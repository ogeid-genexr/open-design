/**
 * Unit coverage for the Claude Code CLI synthesizer that backs
 * `POST /api/projects/:id/finalize/claude-code` (GitHub issue
 * nexu-io/open-design#963). The orchestration (lockfile, transcript
 * export, atomic write) is exercised by `finalize-design.test.ts`
 * and is provider-agnostic; this file pins the CLI-spawning seam
 * so future CLI argv changes do not silently break the route.
 *
 * Tests inject a fake `spawnImpl` returning an EventEmitter-backed
 * fake child process, so they neither require the real `claude`
 * binary nor touch the network.
 */
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  callClaudeCodeCLI,
  FinalizeClaudeCodeNotInstalledError,
  probeClaudeCodeCli,
} from '../src/finalize-claude-code.js';
import { FinalizeUpstreamError } from '../src/finalize-design.js';

type FakeSpawn = (cmd: string, args: readonly string[], opts: any) => FakeChild;

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => boolean;
  /** Test hook: emit stdout JSONL events then close the process. */
  finish: (events: string[], opts?: { exitCode?: number; stderr?: string }) => void;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  child.finish = (events, opts) => {
    for (const e of events) {
      child.stdout.emit('data', Buffer.from(e + '\n', 'utf8'));
    }
    if (opts?.stderr) child.stderr.emit('data', Buffer.from(opts.stderr, 'utf8'));
    // Defer 'close' so the consumer's data handler runs synchronously
    // before we resolve.
    setImmediate(() => child.emit('close', opts?.exitCode ?? 0, null));
  };
  return child;
}

function makeSpawn(
  onSpawn: (cmd: string, args: readonly string[]) => FakeChild,
): FakeSpawn {
  return ((cmd, args) => onSpawn(cmd, args)) as FakeSpawn;
}

describe('probeClaudeCodeCli', () => {
  it('resolves with the trimmed --version output on success', async () => {
    const spawnImpl = makeSpawn(() => {
      const child = createFakeChild();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('2.1.138 (Claude Code)\n'));
        child.emit('close', 0, null);
      });
      return child;
    });

    const { version } = await probeClaudeCodeCli({ spawnImpl: spawnImpl as any });
    expect(version).toBe('2.1.138 (Claude Code)');
  });

  it('throws FinalizeClaudeCodeNotInstalledError on ENOENT spawn failure', async () => {
    const spawnImpl = makeSpawn(() => {
      const child = createFakeChild();
      const err: NodeJS.ErrnoException = new Error('spawn claude ENOENT');
      err.code = 'ENOENT';
      setImmediate(() => child.emit('error', err));
      return child;
    });

    await expect(
      probeClaudeCodeCli({ spawnImpl: spawnImpl as any }),
    ).rejects.toBeInstanceOf(FinalizeClaudeCodeNotInstalledError);
  });

  it('throws FinalizeUpstreamError when the CLI exits non-zero', async () => {
    const spawnImpl = makeSpawn(() => {
      const child = createFakeChild();
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('cli broken'));
        child.emit('close', 1, null);
      });
      return child;
    });

    await expect(
      probeClaudeCodeCli({ spawnImpl: spawnImpl as any }),
    ).rejects.toBeInstanceOf(FinalizeUpstreamError);
  });
});

describe('callClaudeCodeCLI', () => {
  const promptInput = {
    systemPrompt: 'sys',
    userPrompt: 'user',
    cwd: '/tmp',
  };

  it('passes --append-system-prompt + --model and returns the result event body + usage', async () => {
    let capturedArgs: readonly string[] = [];
    const spawnImpl = makeSpawn((_cmd, args) => {
      capturedArgs = args;
      const child = createFakeChild();
      setImmediate(() => {
        child.finish([
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '# DESIGN.md\nbody\n',
            model: 'claude-opus-4-7',
            usage: { input_tokens: 100, output_tokens: 200 },
          }),
        ]);
      });
      return child;
    });

    const out = await callClaudeCodeCLI({
      ...promptInput,
      model: 'claude-opus-4-7',
      signal: new AbortController().signal,
      transport: { spawnImpl: spawnImpl as any },
    });

    expect(out.designMd).toBe('# DESIGN.md\nbody\n');
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(200);
    expect(out.model).toBe('claude-opus-4-7');
    expect(capturedArgs).toContain('--append-system-prompt');
    expect(capturedArgs).toContain('--output-format');
    expect(capturedArgs).toContain('stream-json');
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).toContain('claude-opus-4-7');
  });

  it('returns null model + token counters when the CLI omits them', async () => {
    const spawnImpl = makeSpawn(() => {
      const child = createFakeChild();
      setImmediate(() => {
        child.finish([
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '# minimal\n',
          }),
        ]);
      });
      return child;
    });

    const out = await callClaudeCodeCLI({
      ...promptInput,
      signal: new AbortController().signal,
      transport: { spawnImpl: spawnImpl as any },
    });

    expect(out.designMd).toBe('# minimal\n');
    expect(out.inputTokens).toBeNull();
    expect(out.outputTokens).toBeNull();
    expect(out.model).toBeNull();
  });

  it('throws FinalizeUpstreamError(401) when the result event signals an auth failure', async () => {
    const spawnImpl = makeSpawn(() => {
      const child = createFakeChild();
      setImmediate(() => {
        child.finish(
          [
            JSON.stringify({
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              result: 'please run `/login` to authenticate',
            }),
          ],
          { exitCode: 1 },
        );
      });
      return child;
    });

    const err = await callClaudeCodeCLI({
      ...promptInput,
      signal: new AbortController().signal,
      transport: { spawnImpl: spawnImpl as any },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FinalizeUpstreamError);
    expect((err as FinalizeUpstreamError).status).toBe(401);
  });

  it('throws FinalizeUpstreamError(502) when no result event is emitted', async () => {
    const spawnImpl = makeSpawn(() => {
      const child = createFakeChild();
      setImmediate(() => {
        child.finish([], { exitCode: 1, stderr: 'crashed mid-call' });
      });
      return child;
    });

    const err = await callClaudeCodeCLI({
      ...promptInput,
      signal: new AbortController().signal,
      transport: { spawnImpl: spawnImpl as any },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FinalizeUpstreamError);
    expect((err as FinalizeUpstreamError).status).toBe(502);
    expect((err as FinalizeUpstreamError).rawText).toContain('crashed mid-call');
  });

  it('rejects with AbortError when the signal is already aborted before spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const spawnImpl = makeSpawn(() => {
      spawned = true;
      return createFakeChild();
    });

    const err = await callClaudeCodeCLI({
      ...promptInput,
      signal: controller.signal,
      transport: { spawnImpl: spawnImpl as any },
    }).catch((e: unknown) => e);

    expect(spawned).toBe(false);
    expect((err as Error).name).toBe('AbortError');
  });

  it('rejects with AbortError when the signal aborts mid-call', async () => {
    const controller = new AbortController();
    const spawnImpl = makeSpawn(() => {
      const child = createFakeChild();
      // Simulate Node's AbortSignal-aware spawn behavior: when the
      // signal aborts, it kills the child and emits an 'error' with
      // name='AbortError'. We mimic this on signal abort.
      controller.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        child.emit('error', err);
      });
      return child;
    });

    const promise = callClaudeCodeCLI({
      ...promptInput,
      signal: controller.signal,
      transport: { spawnImpl: spawnImpl as any },
    });

    setImmediate(() => controller.abort());
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
  });
});
