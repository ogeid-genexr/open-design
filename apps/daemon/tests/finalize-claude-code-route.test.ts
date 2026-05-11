/**
 * Route-level integration coverage for
 * `POST /api/projects/:id/finalize/claude-code` (GitHub issue
 * nexu-io/open-design#963). Drives the real Express handler end to
 * end, swapping in a controlled fake `claude` binary via the
 * `OD_CLAUDE_CODE_CLI_BIN` env override so we can exercise the
 * success path, the missing-CLI path, and the auth-failure path
 * without the developer's actual Claude Code CLI.
 *
 * The fake binary is a tiny Node shebang script. It implements just
 * enough of `claude --version` and `claude --print --output-format
 * stream-json …` to satisfy the synthesizer: it emits a single JSON
 * line on stdout and exits, with the body driven by env vars so
 * each test case can shape the response.
 */
import * as http from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

describe('POST /api/projects/:id/finalize/claude-code', () => {
  let server: http.Server;
  let baseUrl: string;
  let fakeBinDir: string;
  let fakeBinPath: string;

  const PROJECT_ID_OK = 'fcc-route-ok';
  const PROJECT_ID_AUTH = 'fcc-route-auth';
  const PROJECT_ID_MISSING = 'fcc-route-missing';

  const SUCCESS_DESIGN_MD = '# DESIGN.md\n## Summary\nfrom fake CLI\n';

  beforeAll(async () => {
    // Build the fake CLI script BEFORE startServer so the env vars
    // are visible by the time the daemon module is imported (the
    // synthesizer reads OD_CLAUDE_CODE_CLI_BIN at call time, so this
    // is belt-and-suspenders).
    fakeBinDir = mkdtempSync(path.join(tmpdir(), 'od-fake-claude-'));
    fakeBinPath = path.join(fakeBinDir, 'fake-claude');
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('0.0.0-fake (Open Design test)\\n');
  process.exit(0);
}
const mode = process.env.OD_FAKE_CLAUDE_MODE || 'success';
const successBody = process.env.OD_FAKE_CLAUDE_BODY || '';
if (mode === 'success') {
  const event = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: successBody,
    model: 'fake-model',
    usage: { input_tokens: 11, output_tokens: 22 },
  };
  process.stdout.write(JSON.stringify(event) + '\\n');
  process.exit(0);
} else if (mode === 'auth') {
  const event = {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'please run /login to authenticate',
  };
  process.stdout.write(JSON.stringify(event) + '\\n');
  process.exit(1);
}
process.exit(2);
`;
    writeFileSync(fakeBinPath, script);
    chmodSync(fakeBinPath, 0o755);

    process.env.OD_CLAUDE_CODE_CLI_BIN = fakeBinPath;
    process.env.OD_FAKE_CLAUDE_BODY = SUCCESS_DESIGN_MD;

    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;

    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');

    for (const id of [PROJECT_ID_OK, PROJECT_ID_AUTH, PROJECT_ID_MISSING]) {
      await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: `Fixture ${id}` }),
      });
      const dir = path.join(dataDir, 'projects', id);
      mkdirSync(dir, { recursive: true });
      // Seed a conversation + one message so the transcript export
      // phase has something to read.
      const conv = await fetch(`${baseUrl}/api/projects/${id}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Seed' }),
      });
      const convBody = (await conv.json()) as { conversation: { id: string } };
      await fetch(
        `${baseUrl}/api/projects/${id}/conversations/${convBody.conversation.id}/messages/seed-msg`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: 'user',
            createdAt: 1,
            updatedAt: 1,
            blocks: [{ type: 'text', text: 'design me a thing' }],
          }),
        },
      );
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.OD_CLAUDE_CODE_CLI_BIN;
    delete process.env.OD_FAKE_CLAUDE_MODE;
    delete process.env.OD_FAKE_CLAUDE_BODY;
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it('writes DESIGN.md and returns the schema response on the success path', async () => {
    process.env.OD_FAKE_CLAUDE_MODE = 'success';
    const res = await fetch(
      `${baseUrl}/api/projects/${PROJECT_ID_OK}/finalize/claude-code`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      designMdPath: string;
      bytesWritten: number;
      model: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      transcriptMessageCount: number;
    };
    expect(body.model).toBe('fake-model');
    expect(body.inputTokens).toBe(11);
    expect(body.outputTokens).toBe(22);
    expect(body.bytesWritten).toBe(Buffer.byteLength(SUCCESS_DESIGN_MD, 'utf8'));
    expect(existsSync(body.designMdPath)).toBe(true);
    expect(readFileSync(body.designMdPath, 'utf8')).toBe(SUCCESS_DESIGN_MD);
  });

  it('returns 401 UNAUTHORIZED when the CLI reports an auth failure', async () => {
    process.env.OD_FAKE_CLAUDE_MODE = 'auth';
    const res = await fetch(
      `${baseUrl}/api/projects/${PROJECT_ID_AUTH}/finalize/claude-code`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  it('returns 503 UPSTREAM_UNAVAILABLE when the CLI binary is missing', async () => {
    const prev = process.env.OD_CLAUDE_CODE_CLI_BIN;
    process.env.OD_CLAUDE_CODE_CLI_BIN = path.join(fakeBinDir, 'definitely-not-here');
    try {
      const res = await fetch(
        `${baseUrl}/api/projects/${PROJECT_ID_MISSING}/finalize/claude-code`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      process.env.OD_CLAUDE_CODE_CLI_BIN = prev;
    }
  });

  it('rejects malformed model with 400 BAD_REQUEST', async () => {
    const res = await fetch(
      `${baseUrl}/api/projects/${PROJECT_ID_OK}/finalize/claude-code`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: '' }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown project id', async () => {
    const res = await fetch(
      `${baseUrl}/api/projects/does-not-exist/finalize/claude-code`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(404);
  });
});
