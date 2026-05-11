// Provider-sibling of finalize-design.ts that synthesizes DESIGN.md via
// the locally installed Claude Code CLI rather than calling
// api.anthropic.com directly. Designed for Max plan subscribers, whose
// CLI usage is subsidized by their subscription — paying per-token API
// rates for finalize on top of an active Max plan is the gap this
// module closes (GitHub issue nexu-io/open-design#963).
//
// The shared orchestration (lockfile, transcript export + truncation,
// prompt build, atomic DESIGN.md write) lives in finalize-design.ts.
// This module supplies a `FinalizeSynthesizer` that:
//   1. Preflights `claude --version` so a missing CLI surfaces as a
//      503-mappable error before the lockfile is even taken.
//   2. Spawns `claude --print --output-format stream-json` with the
//      project directory as cwd, writes the user prompt to stdin,
//      and accumulates the stream-json `result` event for the body
//      and (when surfaced) usage counters.
//   3. Maps process-level failures (auth, abort, non-zero exit) onto
//      `FinalizeUpstreamError` / `AbortError` so the route handler
//      can reuse the Anthropic-route's status-aware mapping.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type Database from 'better-sqlite3';
import type {
  FinalizeClaudeCodeResponse,
  FinalizeArtifactRef,
} from '@open-design/contracts/api/finalize';
import { getProject } from './db.js';
import { resolveProjectDir } from './projects.js';
import {
  FinalizeUpstreamError,
  runFinalizeWithSynthesizer,
  type FinalizeSynthesisResult,
  type FinalizeSynthesizer,
  type RunFinalizeOptions,
} from './finalize-design.js';
import { spawnEnvForAgent } from './runtimes/env.js';

export type { FinalizeClaudeCodeResponse };

type Db = Database.Database;

/**
 * Resolve the CLI binary path. Production defaults to plain `claude`
 * (PATH lookup); `OD_CLAUDE_CODE_CLI_BIN` overrides for users with
 * non-PATH installs and for daemon integration tests that point the
 * route at a controlled script.
 */
function defaultCliBin(): string {
  return process.env.OD_CLAUDE_CODE_CLI_BIN || 'claude';
}
const VERSION_PROBE_TIMEOUT_MS = 5_000;
/**
 * Default upstream-call ceiling for the CLI route. Claude Code
 * synthesis is meaningfully slower than a direct Anthropic Messages
 * API call: the CLI streams its response, may retry internally, and
 * has subprocess overhead the API path doesn't pay. A 2-minute
 * ceiling (the Anthropic default) trips while the CLI is still
 * legitimately working. 10 minutes accommodates a multi-turn
 * synthesis without giving runaway processes an unbounded budget.
 */
const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 600_000;

/**
 * Empty value passed to `--tools` so the synthesis run has zero
 * built-in tool surface regardless of which tools the installed CLI
 * version ships or which MCP servers / configured tools the user has
 * wired up. `--tools` is Claude Code's documented switch for
 * constraining the built-in tool set; `--allowedTools` is a permission
 * allowlist and does not replace the built-in surface. The synthesis
 * prompt is self-contained — all transcript, design system, and
 * artifact context is in stdin — so the provider never needs a tool.
 *
 * Exported so tests can assert the argv contract.
 */
export const CLAUDE_CODE_EMPTY_TOOL_SET = '' as const;

/**
 * The local Claude Code CLI is not installed (or not on PATH the
 * daemon can see). Distinct from `FinalizeUpstreamError` so the route
 * handler can return a tailored 503 message instructing the user to
 * install / re-login rather than the generic upstream-failed code.
 */
export class FinalizeClaudeCodeNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalizeClaudeCodeNotInstalledError';
  }
}

/**
 * Test-injection seam. Production callers leave both fields
 * unspecified and the synthesizer uses real `child_process.spawn`
 * with the resolved CLI binary path. Tests substitute both.
 */
export interface ClaudeCodeCliTransport {
  /** Override for the `claude` executable path. Default: `claude` (PATH lookup). */
  cliPath?: string;
  /** Override spawn implementation. Default: `child_process.spawn`. */
  spawnImpl?: typeof spawn;
}

export interface FinalizeClaudeCodeOptions extends RunFinalizeOptions {
  cli?: ClaudeCodeCliTransport;
}

/**
 * One-shot preflight: run `claude --version` and resolve when the
 * CLI prints a non-empty stdout AND exits zero. Maps ENOENT to
 * `FinalizeClaudeCodeNotInstalledError`; any other failure (non-zero
 * exit, empty stdout) to a generic 502 `FinalizeUpstreamError` so
 * the route still maps to UPSTREAM_UNAVAILABLE.
 *
 * Bounded by a 5s internal timeout; the wider per-finalize timeout
 * does not gate the preflight because it runs before the lockfile
 * is taken and the orchestrator has not yet composed a signal.
 */
export async function probeClaudeCodeCli(
  transport: ClaudeCodeCliTransport = {},
): Promise<{ version: string }> {
  const cliPath = transport.cliPath ?? defaultCliBin();
  const spawnImpl = transport.spawnImpl ?? spawn;

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(cliPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return reject(
          new FinalizeClaudeCodeNotInstalledError(
            `claude CLI not found at "${cliPath}". Install Claude Code (https://docs.claude.com/en/docs/claude-code) and ensure it is on PATH.`,
          ),
        );
      }
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new FinalizeUpstreamError(502, '', 'claude --version timed out'));
    }, VERSION_PROBE_TIMEOUT_MS);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(
          new FinalizeClaudeCodeNotInstalledError(
            `claude CLI not found at "${cliPath}". Install Claude Code (https://docs.claude.com/en/docs/claude-code) and ensure it is on PATH.`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new FinalizeUpstreamError(
            502,
            stderr,
            `claude --version exited with code ${code}`,
          ),
        );
        return;
      }
      const version = stdout.trim();
      if (!version) {
        reject(new FinalizeUpstreamError(502, '', 'claude --version produced no output'));
        return;
      }
      resolve({ version });
    });
  });
}

interface StreamJsonResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Authentication / login failure detected from CLI stderr or a
 * stream-json `result` event with an error subtype. Keeps the auth
 * vs general-upstream-failure distinction at the boundary so the
 * route handler can return 401 UNAUTHORIZED with an actionable
 * message ("run `claude /login`") rather than the catch-all 502.
 */
function isAuthFailureSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('/login') ||
    lower.includes('please run') ||
    lower.includes('invalid api key') ||
    lower.includes('not authenticated') ||
    lower.includes('credentials')
  );
}

/**
 * Spawn the Claude Code CLI in headless print mode and feed it the
 * synthesis prompts. Returns the final stream-json `result` event's
 * text + usage. Errors map as:
 *   - process spawn ENOENT → `FinalizeClaudeCodeNotInstalledError`
 *   - signal abort → AbortError (orchestrator → route → 503)
 *   - auth-signal-bearing stderr / error-subtype result → 401 via
 *     `FinalizeUpstreamError(401)`
 *   - any other non-zero exit / unparseable stream → 502 via
 *     `FinalizeUpstreamError(502)` with the trailing stderr as
 *     `rawText`
 */
export async function callClaudeCodeCLI(input: {
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
  cwd: string;
  model?: string;
  maxTokens?: number;
  transport?: ClaudeCodeCliTransport;
}): Promise<FinalizeSynthesisResult> {
  const cliPath = input.transport?.cliPath ?? defaultCliBin();
  const spawnImpl = input.transport?.spawnImpl ?? spawn;

  const args: string[] = [
    '--print',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    // stream-json requires --verbose to emit per-event chunks rather
    // than collapsing the run into a single terminal event.
    '--verbose',
    '--append-system-prompt',
    input.systemPrompt,
    // Synthesis never needs project file access or tool invocations —
    // the full transcript, design system, and current artifact are
    // already in the user prompt. Pass an empty allowlist so the CLI
    // runs with zero tool surface regardless of which built-in tools
    // ship in the installed version or which MCP / configured tools
    // the user has wired up. `--tools` is Claude Code's documented
    // switch for constraining the built-in tool set; passing an empty
    // value disables all of them. `--allowedTools` is a permission
    // allowlist and does NOT replace the built-in surface, and
    // `--permission-mode default` alone only controls how permission
    // prompts are surfaced. The combination keeps the CLI in a pure
    // prompt-completion shape.
    '--tools',
    CLAUDE_CODE_EMPTY_TOOL_SET,
    '--permission-mode',
    'default',
  ];
  if (input.model) {
    args.push('--model', input.model);
  }

  // Pre-abort short-circuit: if the caller already aborted before we
  // spawned, raise AbortError without touching the CLI.
  if (input.signal.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }

  // Claude Code reads its per-response output ceiling from the
  // `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env var (it has no equivalent
  // CLI flag). Honoring `maxTokens` here keeps the route's request
  // contract truthful: a caller that asks for a tighter ceiling
  // actually gets one, matching the Anthropic provider's behavior.
  // Use the same env shaping as the claude agent runtime path: strip
  // ANTHROPIC_API_KEY so Claude Code falls back to its own subscription
  // auth (claude /login, Max/Pro plan) instead of silently API-billing
  // a daemon that happens to have the key exported. This is the billing
  // boundary the whole provider exists to preserve. Honors the
  // ANTHROPIC_BASE_URL escape hatch (custom proxy).
  const childEnv = spawnEnvForAgent('claude', process.env);
  if (typeof input.maxTokens === 'number' && input.maxTokens > 0) {
    childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.trunc(input.maxTokens));
  }

  const spawnOptions: SpawnOptions = {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: input.signal,
    env: childEnv,
  };

  let child: ChildProcess;
  try {
    child = spawnImpl(cliPath, args, spawnOptions);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new FinalizeClaudeCodeNotInstalledError(
        `claude CLI not found at "${cliPath}"`,
      );
    }
    throw err;
  }

  // Pipe the user prompt as plain text on stdin; the CLI's
  // --input-format text mode treats stdin as the user message.
  child.stdin?.on('error', () => {
    // EPIPE if the CLI exits before we finish writing. Swallow; the
    // close handler below maps the exit code to an error.
  });
  child.stdin?.end(input.userPrompt);

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  // Accumulate stdout line-by-line; the CLI emits one JSON object per
  // line. We keep only the most recent `result` event and a list of
  // any explicit error events for diagnostics.
  let stdoutTail = '';
  let resultEvent: StreamJsonResultEvent | null = null;

  return await new Promise<FinalizeSynthesisResult>((resolve, reject) => {
    const flushLines = (chunk: string): void => {
      stdoutTail += chunk;
      let newline: number;
      while ((newline = stdoutTail.indexOf('\n')) !== -1) {
        const line = stdoutTail.slice(0, newline).trim();
        stdoutTail = stdoutTail.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as { type?: unknown };
          if (event && typeof event === 'object' && event.type === 'result') {
            resultEvent = event as StreamJsonResultEvent;
          }
        } catch {
          // Non-JSON line — ignore. The CLI occasionally prints
          // diagnostic banners to stdout under unusual config; we
          // tolerate them and rely on the final result event.
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => flushLines(chunk.toString('utf8')));

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new FinalizeClaudeCodeNotInstalledError(
            `claude CLI not found at "${cliPath}"`,
          ),
        );
        return;
      }
      // node propagates an abort by killing the child and emitting an
      // 'error' with name === 'AbortError'; preserve the name so the
      // orchestrator's downstream mapping treats it as a cancel.
      if (err.name === 'AbortError' || input.signal.aborted) {
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        reject(aborted);
        return;
      }
      reject(err);
    });

    child.on('close', (code, killSignal) => {
      // Drain any trailing partial line.
      if (stdoutTail.trim()) {
        flushLines('\n');
      }

      if (input.signal.aborted) {
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        reject(aborted);
        return;
      }

      if (resultEvent && resultEvent.is_error !== true && resultEvent.subtype === 'success') {
        const text = typeof resultEvent.result === 'string' ? resultEvent.result : '';
        if (!text) {
          reject(
            new FinalizeUpstreamError(
              502,
              stderrBuf,
              'claude CLI returned an empty success result',
            ),
          );
          return;
        }
        const usage = resultEvent.usage ?? {};
        const inputTokens =
          typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
        const outputTokens =
          typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
        resolve({
          designMd: text,
          inputTokens,
          outputTokens,
          model: typeof resultEvent.model === 'string' ? resultEvent.model : null,
        });
        return;
      }

      // Result event present but flagged as an error — typically auth
      // failure. Map auth-signal-bearing payloads to 401.
      if (resultEvent && (resultEvent.is_error === true || resultEvent.subtype !== 'success')) {
        const combined = `${stderrBuf}\n${JSON.stringify(resultEvent)}`;
        if (isAuthFailureSignal(combined)) {
          reject(
            new FinalizeUpstreamError(
              401,
              combined,
              'claude CLI is not authenticated — run `claude /login`',
            ),
          );
          return;
        }
        reject(
          new FinalizeUpstreamError(
            502,
            combined,
            `claude CLI reported an error (subtype=${String(resultEvent.subtype ?? 'unknown')})`,
          ),
        );
        return;
      }

      // No result event at all — the CLI exited without emitting one.
      // Treat as upstream failure; surface stderr for diagnostics.
      if (isAuthFailureSignal(stderrBuf)) {
        reject(
          new FinalizeUpstreamError(
            401,
            stderrBuf,
            'claude CLI is not authenticated — run `claude /login`',
          ),
        );
        return;
      }
      const trailer = killSignal ? ` (killed with ${killSignal})` : '';
      reject(
        new FinalizeUpstreamError(
          502,
          stderrBuf,
          `claude CLI exited with code ${code}${trailer} without a result event`,
        ),
      );
    });
  });
}

/**
 * Top-level entry point invoked by the route handler. Mirrors
 * `finalizeDesignPackage` (the Anthropic provider) but routes the
 * upstream call through the local Claude Code CLI. The function:
 *   1. Resolves the project's working directory so the CLI inherits
 *      a sensible cwd matching the user's mental model.
 *   2. Probes `claude --version` before the lockfile is acquired so
 *      a missing CLI does not leave a `.finalize.lock` behind.
 *   3. Delegates to `runFinalizeWithSynthesizer` with a synthesizer
 *      that spawns the CLI per call.
 */
export async function finalizeDesignPackageWithClaudeCode(
  db: Db,
  projectsRoot: string,
  designSystemsRoot: string,
  projectId: string,
  options: FinalizeClaudeCodeOptions,
): Promise<FinalizeClaudeCodeResponse> {
  const project = getProject(db, projectId);
  if (!project) {
    throw new Error(`project not found: ${projectId}`);
  }
  const projectMetadata =
    (project as { metadata?: { baseDir?: string } | null }).metadata ?? null;
  const cwd = resolveProjectDir(projectsRoot, projectId, projectMetadata ?? undefined);

  // Preflight outside the lockfile so a missing-CLI failure does not
  // strand `.finalize.lock` on disk.
  await probeClaudeCodeCli(options.cli ?? {});

  const synthesize: FinalizeSynthesizer = ({ systemPrompt, userPrompt, signal }) => {
    const callInput: Parameters<typeof callClaudeCodeCLI>[0] = {
      systemPrompt,
      userPrompt,
      signal,
      cwd,
    };
    if (options.model) callInput.model = options.model;
    if (typeof options.maxTokens === 'number') callInput.maxTokens = options.maxTokens;
    if (options.cli) callInput.transport = options.cli;
    return callClaudeCodeCLI(callInput);
  };

  const runOptions: RunFinalizeOptions = {
    // Apply the CLI-specific default ceiling unless the caller has
    // explicitly opted into a shorter or longer budget; tests pass
    // smaller values to exercise the abort path without burning
    // wall-clock time.
    timeoutMs: options.timeoutMs ?? DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
  };
  if (options.model !== undefined) runOptions.model = options.model;
  if (options.maxTokens !== undefined) runOptions.maxTokens = options.maxTokens;
  if (options.now !== undefined) runOptions.now = options.now;
  if (options.signal !== undefined) runOptions.signal = options.signal;
  const result = await runFinalizeWithSynthesizer(
    db,
    projectsRoot,
    designSystemsRoot,
    projectId,
    runOptions,
    synthesize,
  );

  const artifact: FinalizeArtifactRef | null = result.artifact;
  return {
    designMdPath: result.designMdPath,
    bytesWritten: result.bytesWritten,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    artifact,
    transcriptMessageCount: result.transcriptMessageCount,
    designSystemId: result.designSystemId,
  };
}
