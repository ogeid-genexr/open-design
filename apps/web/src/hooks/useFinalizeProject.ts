// Wraps POST /api/projects/:id/finalize/<provider> for the Finalize
// design package button (#451). The daemon route runs synchronously for
// 60–120 s, so the hook owns:
//   - request lifecycle (idle / pending / success / error)
//   - cancellation via AbortController (best-effort — daemon's
//     synthesis call may already be in flight when abort fires)
//   - daemon error envelope mapping per #832's contract: when the
//     response is non-OK, body.error.{code,message,details} is the
//     authoritative payload. The mapping table below produces the
//     user-facing toast string for each `code`. `details`, when present,
//     is rendered as a secondary toast line so the upstream provider's
//     reason (e.g. account usage cap, missing CLI login) is visible to
//     the user instead of just the daemon's category label.
//
// The hook is provider-aware via a tagged request union. `anthropic`
// hits the BYOK API route (#832); `claude-code` hits the local CLI
// route (#963) which Max plan subscribers prefer because it inherits
// their subscription's subsidized billing. The caller chooses which
// based on the user's AppConfig (mode + agentId) — the hook does not
// pick a default of its own.

import { useCallback, useRef, useState } from 'react';
import type {
  ApiErrorCode,
  FinalizeAnthropicRequest,
  FinalizeAnthropicResponse,
  FinalizeClaudeCodeRequest,
  FinalizeClaudeCodeResponse,
} from '@open-design/contracts';

// Per-provider client-side fetch ceiling. Each value is the daemon's
// own upstream-call ceiling for that provider plus a small buffer so
// the daemon's status-aware error mapping always wins under normal
// failure modes (the client only times out when the daemon has gone
// silent past its own ceiling, which signals a real disconnect rather
// than a slow upstream).
//   - anthropic:   daemon 120 s + 10 s buffer
//   - claude-code: daemon 600 s + 30 s buffer (CLI synthesis is
//                  meaningfully slower than a direct API call —
//                  subprocess overhead, streaming, internal retries)
const FETCH_TIMEOUT_BY_PROVIDER: Record<FinalizeProvider, number> = {
  anthropic: 130_000,
  'claude-code': 630_000,
};

export type FinalizeStatus = 'idle' | 'pending' | 'success' | 'error';

export interface FinalizeError {
  code: ApiErrorCode | 'NETWORK_ERROR' | 'TIMEOUT';
  message: string;
  details: string | null;
}

export type FinalizeProvider = 'anthropic' | 'claude-code';

/**
 * Tagged-union request type. The discriminant selects the daemon
 * route; the rest of the body is sent verbatim per the route's
 * contract (anthropic: BYOK API key + model; claude-code: optional
 * model only, CLI handles auth).
 */
export type FinalizeRequest =
  | ({ provider: 'anthropic' } & FinalizeAnthropicRequest)
  | ({ provider: 'claude-code' } & FinalizeClaudeCodeRequest);

/**
 * Provider-agnostic success response. The Anthropic route's fields
 * are a strict subset of the Claude Code route's (the latter
 * widens model/inputTokens/outputTokens to nullable), so this
 * widened shape is safe to use for both. UI consumers that read
 * token counts must accept nullable.
 */
export type FinalizeResponse = FinalizeClaudeCodeResponse;

export interface FinalizeProjectState {
  status: FinalizeStatus;
  error: FinalizeError | null;
  result: FinalizeResponse | null;
  trigger: (req: FinalizeRequest) => Promise<FinalizeResponse | null>;
  cancel: () => void;
}

interface DaemonErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export function useFinalizeProject(projectId: string): FinalizeProjectState {
  const [status, setStatus] = useState<FinalizeStatus>('idle');
  const [error, setError] = useState<FinalizeError | null>(null);
  const [result, setResult] = useState<FinalizeResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Tracks whether the in-flight controller's abort came from the
  // 130 s timeout (true) or the user clicking Cancel (false). The
  // catch block reads this to surface a TIMEOUT error instead of a
  // silent idle reset, so users learn the daemon may still be running.
  const timedOutRef = useRef(false);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const trigger = useCallback(
    async (req: FinalizeRequest): Promise<FinalizeResponse | null> => {
      // Cancel any in-flight call before starting a new one so a
      // double-clicked button doesn't pile up two daemon requests.
      abortRef.current?.abort();
      timedOutRef.current = false;
      const controller = new AbortController();
      abortRef.current = controller;
      const timeoutId = setTimeout(() => {
        timedOutRef.current = true;
        controller.abort();
      }, FETCH_TIMEOUT_BY_PROVIDER[req.provider]);

      setStatus('pending');
      setError(null);
      setResult(null);

      // Every state-write site below first checks `isCurrent()` so a
      // superseded trigger cannot leak its outcome into a replacement
      // trigger's lifecycle. Without these guards, a quick double-click
      // would let the first request's late AbortError catch run
      // setStatus('idle') while the second request is still pending,
      // clearing the spinner and re-enabling the buttons mid-flight.
      const isCurrent = () => abortRef.current === controller;

      try {
        const { provider, ...payload } = req;
        const resp = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/finalize/${provider}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          },
        );

        if (!resp.ok) {
          const envelope = (await resp.json().catch(() => ({}))) as DaemonErrorEnvelope;
          if (!isCurrent()) return null;
          const code = envelope.error?.code ?? 'INTERNAL_ERROR';
          const detailsRaw = envelope.error?.details;
          const details = typeof detailsRaw === 'string' ? detailsRaw : null;
          const finalizeError: FinalizeError = {
            code: code as FinalizeError['code'],
            message: messageForCode(code as ApiErrorCode, req.provider),
            details,
          };
          setError(finalizeError);
          setStatus('error');
          return null;
        }

        const raw = (await resp.json()) as FinalizeAnthropicResponse | FinalizeClaudeCodeResponse;
        // Widen the Anthropic response (concrete model + tokens) to
        // the union shape stored in state. The fields are guaranteed
        // populated for the Anthropic route, so the cast is safe.
        const body: FinalizeResponse = raw as FinalizeResponse;
        if (!isCurrent()) return null;
        setResult(body);
        setStatus('success');
        return body;
      } catch (err) {
        if (!isCurrent()) return null;
        const aborted =
          (err instanceof DOMException && err.name === 'AbortError') ||
          (err instanceof Error && err.name === 'AbortError');
        if (aborted) {
          if (timedOutRef.current) {
            // Timeout abort — surface as an error so users see the
            // failure signal. The daemon may still be running its
            // synthesis, so the message names that explicitly.
            const finalizeError: FinalizeError = {
              code: 'TIMEOUT',
              message: messageForCode('TIMEOUT', req.provider),
              details: null,
            };
            setError(finalizeError);
            setStatus('error');
            return null;
          }
          // User-initiated cancel — clean reset, not an error surface.
          setError(null);
          setStatus('idle');
          return null;
        }
        const finalizeError: FinalizeError = {
          code: 'NETWORK_ERROR',
          message: messageForCode('NETWORK_ERROR', req.provider),
          details: err instanceof Error ? err.message : String(err),
        };
        setError(finalizeError);
        setStatus('error');
        return null;
      } finally {
        clearTimeout(timeoutId);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [projectId],
  );

  return { status, error, result, trigger, cancel };
}

// User-facing toast strings for each daemon error code. The unknown /
// network branch covers transport errors and codes the daemon adds in
// future without crashing the UI. `provider` tailors three codes whose
// remediation differs by route (UNAUTHORIZED, RATE_LIMITED,
// UPSTREAM_UNAVAILABLE); the rest are provider-neutral.
export function messageForCode(
  code: ApiErrorCode | 'NETWORK_ERROR' | string,
  provider: FinalizeProvider = 'anthropic',
): string {
  switch (code) {
    case 'BAD_REQUEST':
      return provider === 'claude-code'
        ? 'Bad request — check the model name.'
        : 'Bad request — check the API key and model.';
    case 'UNAUTHORIZED':
      return provider === 'claude-code'
        ? 'Claude Code CLI is not signed in. Run `claude /login` in a terminal.'
        : 'API key was rejected. Check it in Settings.';
    case 'FORBIDDEN':
      return 'Access denied by the upstream API.';
    case 'RATE_LIMITED':
      return provider === 'claude-code'
        ? 'Claude Code rate-limited the request. Try again in a minute.'
        : 'Anthropic rate-limited the request. Try again in a minute.';
    case 'UPSTREAM_UNAVAILABLE':
      return provider === 'claude-code'
        ? 'Claude Code CLI is unavailable. Make sure `claude` is installed and on PATH.'
        : 'The Anthropic API is unavailable right now.';
    case 'CONFLICT':
      return 'Another finalize is in progress for this project.';
    case 'PROJECT_NOT_FOUND':
      return 'Project not found.';
    case 'INTERNAL_ERROR':
      return 'Something went wrong while finalizing. Check the daemon logs.';
    case 'TIMEOUT':
      return 'Finalize timed out after 130 s. The daemon may still be running.';
    case 'NETWORK_ERROR':
    default:
      return "Couldn't reach the daemon. Make sure it's running.";
  }
}
