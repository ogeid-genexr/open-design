// Shared DTOs for the `/api/projects/:id/finalize/<provider>` family of
// synthesis endpoints. The first endpoint is `/finalize/anthropic`
// (introduced in PR #832); future provider-namespaced siblings
// (`/finalize/openai` etc.) can reuse the request/response shape.

/**
 * Bumped when the finalize request/response shape changes incompatibly.
 * Also serves as a real runtime export so esbuild emits a `.mjs` for
 * this module (without it, the file is type-only and NodeNext-resolved
 * consumers cannot resolve the re-export from the package root).
 */
export const FINALIZE_SCHEMA_VERSION = 1;

/**
 * Request body for `POST /api/projects/:id/finalize/anthropic`.
 *
 * Field names mirror `ProxyStreamRequest` (./proxy.ts) so a caller that
 * already has provider credentials assembled for chat can reuse the
 * same shape. `baseUrl` is optional here (intentional divergence from
 * the proxy, which requires it) — standard Anthropic users do not need
 * to set it; Bedrock / self-hosted-proxy users still can.
 */
export interface FinalizeAnthropicRequest {
  apiKey: string;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
}

/**
 * Reference to the artifact that participated in the finalize call, if
 * any. Synthesis prompts pass the artifact body verbatim; this response
 * field lets the caller name which file was chosen and when it was
 * last touched.
 */
export interface FinalizeArtifactRef {
  name: string;
  /** ISO 8601 from the artifact's manifest, or `null` for legacy artifacts. */
  updatedAt: string | null;
}

/**
 * Response body for a successful finalize call. The synthesized
 * `DESIGN.md` was written atomically to `designMdPath`; `bytesWritten`
 * is the exact UTF-8 byte length on disk. Token counts are echoed
 * straight from the provider's `usage` block.
 */
export interface FinalizeAnthropicResponse {
  designMdPath: string;
  bytesWritten: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  artifact: FinalizeArtifactRef | null;
  transcriptMessageCount: number;
  designSystemId: string | null;
}

/**
 * Request body for `POST /api/projects/:id/finalize/claude-code`.
 *
 * Auth is delegated to the user's existing Claude Code CLI login
 * (`claude /login`) so Max plan subscribers do not pay per-token
 * BYOK API costs for synthesis. Consequently there is no `apiKey`
 * field. `model` is optional — when omitted, the daemon lets the
 * CLI pick its configured default.
 */
export interface FinalizeClaudeCodeRequest {
  model?: string;
  maxTokens?: number;
}

/**
 * Response body for `/finalize/claude-code`. Mirrors
 * `FinalizeAnthropicResponse` except:
 *   - `model` is nullable: when the request omits `model` and the
 *     CLI's stream-json result event doesn't surface the model it
 *     used, the daemon returns `null` rather than guessing.
 *   - `inputTokens` / `outputTokens` are nullable: the CLI surfaces
 *     usage in its final `result` event when available, but the
 *     daemon does not synthesize counts when it isn't.
 */
export interface FinalizeClaudeCodeResponse {
  designMdPath: string;
  bytesWritten: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  artifact: FinalizeArtifactRef | null;
  transcriptMessageCount: number;
  designSystemId: string | null;
}
