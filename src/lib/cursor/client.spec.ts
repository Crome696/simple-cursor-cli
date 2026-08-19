import { describe, expect, it, vi } from 'vitest';
import {
  buildCursorCliArgs,
  CursorCliClient,
  CursorCliError,
  sanitizeDiagnostic,
  type CommandExecutionOptions,
  type CommandExecutionResult,
  type CursorCommandRunnerLike,
  type CursorProcessEvent,
} from '../../index.js';

function execution(
  stdout: string,
  options: Partial<CommandExecutionResult> = {},
): CommandExecutionResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 4,
    ...options,
  };
}

class FakeRunner implements CursorCommandRunnerLike {
  readonly calls: Array<{
    readonly args: readonly string[];
    readonly options: CommandExecutionOptions | undefined;
  }> = [];

  constructor(
    private readonly handler: (
      args: readonly string[],
      options?: CommandExecutionOptions,
    ) => Promise<CommandExecutionResult>,
    private readonly streamHandler?: (
      args: readonly string[],
      options?: CommandExecutionOptions,
    ) => AsyncIterable<CursorProcessEvent>,
  ) {}

  execute(
    args: readonly string[],
    options?: CommandExecutionOptions,
  ): Promise<CommandExecutionResult> {
    this.calls.push({ args, options });
    return this.handler(args, options);
  }

  stream(
    args: readonly string[],
    options?: CommandExecutionOptions,
  ): AsyncIterable<CursorProcessEvent> {
    if (this.streamHandler === undefined) {
      throw new Error('stream handler not configured');
    }
    this.calls.push({ args, options });
    return this.streamHandler(args, options);
  }
}

describe('buildCursorCliArgs', () => {
  it('builds a deterministic headless argument list', () => {
    const result = buildCursorCliArgs({
      prompt: 'Inspect the repository',
      mode: 'ask',
      model: { id: 'sonnet', variant: 'sonnet-thinking-high' },
      outputFormat: 'json',
      resume: 'session-123',
      workspace: 'C:\\workspace',
      worktree: 'review-tree',
      extraArgs: ['--new-flag', 'value'],
      capabilities: { rules: ['review.mdc'], files: ['src/index.ts'] },
    });

    expect(result).toEqual({
      ok: true,
      data: [
        '--print',
        '--output-format',
        'json',
        '--mode=ask',
        '--model',
        'sonnet-thinking-high',
        '--resume',
        'session-123',
        '--workspace',
        'C:\\workspace',
        '--worktree',
        'review-tree',
        '--new-flag',
        'value',
        'Inspect the repository\n\n[Cursor context selection]\n- Rules: `review.mdc`\n- Files: `src/index.ts`',
      ],
    });
  });

  it('rejects credential flags, including assignment forms', () => {
    for (const extraArgs of [
      ['-a', 'secret'],
      ['--api-key=secret'],
      ['--auth-token=secret'],
    ]) {
      const result = buildCursorCliArgs({ prompt: 'test', extraArgs });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe('validation');
        expect(result.error.message).not.toContain('secret');
      }
    }
  });

  it('rejects conflicting safety and session options', () => {
    expect(
      buildCursorCliArgs({ prompt: 'test', mode: 'plan', force: true }),
    ).toMatchObject({ ok: false, error: { category: 'validation' } });
    expect(
      buildCursorCliArgs({ prompt: 'test', force: true, yolo: true }),
    ).toMatchObject({ ok: false, error: { category: 'validation' } });
    expect(
      buildCursorCliArgs({
        prompt: 'test',
        resume: true,
        continue: true,
      }),
    ).toMatchObject({ ok: false, error: { category: 'validation' } });
    expect(
      buildCursorCliArgs({
        prompt: 'test',
        streamPartialOutput: true,
        outputFormat: 'json',
      }),
    ).toMatchObject({ ok: false, error: { category: 'validation' } });
    expect(
      buildCursorCliArgs({
        prompt: 'test',
        mode: 'plan',
        extraArgs: ['--force'],
      }),
    ).toMatchObject({ ok: false, error: { category: 'validation' } });
    expect(
      buildCursorCliArgs({
        prompt: 'test',
        mode: 'ask',
        extraArgs: ['--yolo=true'],
      }),
    ).toMatchObject({ ok: false, error: { category: 'validation' } });
  });
});

describe('CursorCliClient', () => {
  it('redacts common credential-shaped diagnostics', () => {
    const diagnostic = sanitizeDiagnostic(
      'crsr_abc123 api-key=key-value token token-value secret: secret-value password password-value Bearer bearer-value',
    );

    expect(diagnostic).not.toMatch(
      /crsr_abc123|key-value|token-value|secret-value|password-value|bearer-value/iu,
    );
    expect(diagnostic).toContain('[REDACTED]');
  });

  it('runs JSON output and preserves normalized result metadata', async () => {
    const runner = new FakeRunner(async () =>
      execution(
        JSON.stringify({
          type: 'result',
          result: 'Completed',
          session_id: 'session-1',
          request_id: 'request-1',
          model: 'sonnet',
          duration_ms: 42,
        }),
      ),
    );
    const client = new CursorCliClient({ runner });

    const result = await client.run({ prompt: 'Do the work' });

    expect(result).toMatchObject({
      ok: true,
      data: {
        text: 'Completed',
        sessionId: 'session-1',
        requestId: 'request-1',
        model: 'sonnet',
        durationMs: 42,
      },
    });
    expect(runner.calls[0]?.args).toEqual([
      '--print',
      '--output-format',
      'json',
      'Do the work',
    ]);
  });

  it('uses plan and ask modes without write approval flags', async () => {
    const runner = new FakeRunner(async () =>
      execution(JSON.stringify({ type: 'result', result: 'ok' })),
    );
    const client = new CursorCliClient({ runner });

    await client.plan({ prompt: 'Plan this change' });
    await client.ask({ prompt: 'Explain this code' });

    expect(runner.calls[0]?.args).toContain('--mode=plan');
    expect(runner.calls[0]?.args).not.toContain('--force');
    expect(runner.calls[0]?.args).not.toContain('--yolo');
    expect(runner.calls[1]?.args).toContain('--mode=ask');
  });

  it('maps CLI failures into categorized, redacted results', async () => {
    const runner = new FakeRunner(async () =>
      execution('', {
        exitCode: 1,
        stderr: 'Not authenticated: Bearer super-secret-token',
      }),
    );
    const client = new CursorCliClient({ runner });

    const result = await client.run({ prompt: 'test' });

    expect(result).toMatchObject({ ok: false, error: { category: 'authentication' } });
    if (!result.ok) {
      expect(result.error.message).not.toContain('super-secret-token');
      expect(result.error.stderr).not.toContain('super-secret-token');
    }
  });

  it('streams normalized events incrementally and preserves unknown events', async () => {
    const stream = async function* (): AsyncIterable<CursorProcessEvent> {
      yield {
        type: 'stdout',
        data: '{"type":"assistant","text":"first"}\n',
      };
      yield {
        type: 'stdout',
        data: '{"type":"future_event","value":1}\n',
      };
      yield {
        type: 'stdout',
        data: '{"type":"result","result":"done"}\n',
      };
      yield { type: 'close', exitCode: 0, durationMs: 7 };
    };
    const runner = new FakeRunner(async () => execution(''), stream);
    const client = new CursorCliClient({ runner });
    const events = [];

    for await (const event of client.stream({ prompt: 'Stream this' })) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'assistant', text: 'first' });
    expect(events[1]).toEqual({
      type: 'future_event',
      raw: { type: 'future_event', value: 1 },
    });
    expect(events[2]).toMatchObject({ type: 'result', text: 'done' });
    expect(runner.calls[0]?.args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      'Stream this',
    ]);
  });

  it('throws a typed error for invalid stream JSON', async () => {
    const stream = async function* (): AsyncIterable<CursorProcessEvent> {
      yield { type: 'stdout', data: '{not-json}\n' };
      yield { type: 'close', exitCode: 0, durationMs: 1 };
    };
    const runner = new FakeRunner(async () => execution(''), stream);
    const client = new CursorCliClient({ runner });

    await expect(async () => {
      for await (const event of client.stream({ prompt: 'test' })) {
        expect(event).toBeDefined();
      }
    }).rejects.toMatchObject({
      name: 'CursorCliError',
      error: { category: 'parse' },
    });
  });

  it('returns health, model and MCP diagnostics through typed summaries', async () => {
    const execute = vi.fn(async (args: readonly string[]) => {
      if (args[0] === '--version') {
        return execution('Cursor Agent 1.2.3\n');
      }
      if (args[0] === 'status') {
        return execution('', { exitCode: 1, stderr: 'Not logged in' });
      }
      if (args[0] === 'models') {
        return execution(JSON.stringify([{ id: 'sonnet', name: 'Sonnet' }]));
      }
      return execution(JSON.stringify([{ name: 'filesystem', status: 'connected' }]));
    });
    const client = new CursorCliClient({
      runner: { execute },
    });

    const health = await client.health();
    const models = await client.listModels();
    const servers = await client.listMcpServers();

    expect(health).toMatchObject({
      ok: true,
      data: {
        cli: { available: true, version: '1.2.3' },
        authentication: { status: 'unauthenticated', diagnostic: 'Not logged in' },
        canRun: false,
      },
    });
    expect(models).toMatchObject({
      ok: true,
      data: [{ id: 'sonnet', name: 'Sonnet', raw: { id: 'sonnet', name: 'Sonnet' } }],
    });
    expect(servers).toMatchObject({
      ok: true,
      data: [{ name: 'filesystem', status: 'connected' }],
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('distinguishes an unavailable executable', async () => {
    const client = new CursorCliClient({
      executable: 'simple-cursor-cli-executable-that-does-not-exist',
    });

    const result = await client.run({ prompt: 'test' });

    expect(result).toMatchObject({ ok: false, error: { category: 'cli_unavailable' } });
  });

  it('passes shell metacharacters as data with shell disabled', async () => {
    const runner = new (await import('./command-runner.js')).CursorCommandRunner({
      executable: process.execPath,
    });
    const payload = '$(touch should-not-run); echo unsafe | redirect > file';
    const result = await runner.execute([
      '-e',
      'process.stdout.write(process.argv[1])',
      payload,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(payload);
  });

  it('cleans up timeout and abort failures', async () => {
    const runner = new (await import('./command-runner.js')).CursorCommandRunner({
      executable: process.execPath,
      timeoutMs: 100,
    });
    await expect(
      runner.execute(['-e', 'setTimeout(() => {}, 1000)']),
    ).rejects.toMatchObject({ code: 'timeout' });

    const controller = new AbortController();
    const aborted = runner.execute(['-e', 'setTimeout(() => {}, 1000)'], {
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' });
  });

  it('exposes CursorCliError for stream cancellation', async () => {
    const stream = async function* (
      _args: readonly string[],
      options?: CommandExecutionOptions,
    ): AsyncIterable<CursorProcessEvent> {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      yield* [];
      throw new Error('cancelled by test');
    };
    const runner: CursorCommandRunnerLike = {
      execute: async () => execution(''),
      stream,
    };
    const client = new CursorCliClient({ runner });
    const controller = new AbortController();
    const iterator = client.stream({ prompt: 'cancel', signal: controller.signal });
    const pending = iterator[Symbol.asyncIterator]().next();
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(CursorCliError);
  });
});
