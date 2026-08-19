import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CursorCommandRunnerError,
  type CursorCommandRunnerErrorCode,
} from './errors.js';
import type {
  CommandExecutionOptions,
  CommandExecutionResult,
  CursorCommandRunnerLike,
  CursorProcessEvent,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (reason?: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown = undefined;

  push(value: T): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

  fail(reason: unknown): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.failure = reason;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(reason);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return Promise.resolve({ done: false, value: this.values.shift() as T });
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

interface ProcessSession {
  readonly queue: AsyncEventQueue<CursorProcessEvent>;
  readonly cancel: () => void;
}

function isAbortError(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface SpawnSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

function resolveWindowsCommand(
  executable: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const result = spawnSync('where.exe', [executable], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    return undefined;
  }

  return String(result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== '');
}

function resolveWindowsPowerShellScript(
  executable: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const resolved =
    executable.includes('\\') || executable.includes('/')
      ? executable
      : resolveWindowsCommand(executable, env);
  if (resolved === undefined) {
    return undefined;
  }

  if (resolved.toLowerCase().endsWith('.ps1') && existsSync(resolved)) {
    return resolved;
  }

  if (resolved.toLowerCase().endsWith('.cmd')) {
    const script = resolved.slice(0, -'.cmd'.length) + '.ps1';
    if (existsSync(script)) {
      return script;
    }
  }

  return undefined;
}

function buildSpawnSpec(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnSpec {
  if (process.platform !== 'win32') {
    return { executable, args };
  }

  const script = resolveWindowsPowerShellScript(executable, env);
  if (script === undefined) {
    return { executable, args };
  }

  const systemRoot = env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  return {
    executable: existsSync(powershell) ? powershell : 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
  };
}

/**
 * Low-level shell-free process runner for the Cursor Agent executable.
 *
 * The runner separates executable and argument values, supports the standard
 * Windows Cursor wrapper, and owns timeout, abort, output, and cleanup
 * behavior. The high-level client is responsible for validation and parsing.
 */
export class CursorCommandRunner implements CursorCommandRunnerLike {
  readonly executable: string;
  readonly timeoutMs: number;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;

  /**
   * Creates a runner with process defaults.
   *
   * @param options Executable, timeout, working-directory, and environment
   * defaults.
   */
  constructor(
    options: {
      readonly executable?: string;
      readonly timeoutMs?: number;
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    const executable = options.executable ?? 'agent';
    if (executable.trim() === '' || executable.includes('\u0000')) {
      throw new TypeError(
        'executable must be a non-empty path without NUL characters.',
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive integer.');
    }
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.cwd = options.cwd;
    this.env = options.env;
  }

  /**
   * Executes a command and aggregates stdout, stderr, exit code, and duration.
   *
   * @param args Argument array passed to the configured executable.
   * @param options Per-execution process controls.
   * @returns The completed process result.
   */
  async execute(
    args: readonly string[],
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    let exitCode: number | null = null;
    let stdout = '';
    let stderr = '';
    let durationMs = 0;

    for await (const event of this.stream(args, options)) {
      if (event.type === 'stdout') {
        stdout += event.data;
      } else if (event.type === 'stderr') {
        stderr += event.data;
      } else {
        exitCode = event.exitCode;
        durationMs = event.durationMs;
      }
    }

    return {
      exitCode: exitCode ?? 1,
      stdout,
      stderr,
      durationMs,
    };
  }

  /**
   * Streams low-level process events and cleans up on iterator completion.
   *
   * @param args Argument array passed to the configured executable.
   * @param options Per-execution process controls.
   * @returns Stdout, stderr, and close events.
   */
  async *stream(
    args: readonly string[],
    options: CommandExecutionOptions = {},
  ): AsyncIterable<CursorProcessEvent> {
    const session = this.start(args, options);
    try {
      for await (const event of session.queue) {
        yield event;
      }
    } finally {
      session.cancel();
    }
  }

  private start(
    args: readonly string[],
    options: CommandExecutionOptions,
  ): ProcessSession {
    const queue = new AsyncEventQueue<CursorProcessEvent>();
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const signal = options.signal;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    let abortHandler: (() => void) | undefined;

    const kill = (): void => {
      if (child !== undefined && !child.killed) {
        try {
          child.kill();
        } catch {
          // The process may have exited between the state check and kill().
        }
      }
    };

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal !== undefined && abortHandler !== undefined) {
        signal.removeEventListener('abort', abortHandler);
        abortHandler = undefined;
      }
    };

    const fail = (
      code: CursorCommandRunnerErrorCode,
      message: string,
      stderr = '',
    ): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      kill();
      queue.fail(new CursorCommandRunnerError(code, message, { stderr }));
    };

    const close = (code: number | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      queue.push({
        type: 'close',
        exitCode: code ?? 1,
        durationMs: Date.now() - startedAt,
      });
      queue.end();
    };

    const cancel = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      kill();
      queue.end();
    };

    if (isAbortError(signal)) {
      fail('aborted', 'Cursor CLI execution was aborted.');
      return { queue, cancel };
    }

    const childEnvironment = {
      ...process.env,
      ...(this.env ?? {}),
      ...(options.env ?? {}),
    };
    const spawnSpec = buildSpawnSpec(this.executable, args, childEnvironment);

    try {
      child = spawn(spawnSpec.executable, [...spawnSpec.args], {
        cwd: options.cwd ?? this.cwd,
        env: childEnvironment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'spawn failed';
      fail('spawn_error', `Could not start Cursor CLI: ${detail}`);
      return { queue, cancel };
    }

    const onError = (cause: Error & { readonly code?: string }): void => {
      if (cause.code === 'ENOENT') {
        fail(
          'executable_unavailable',
          `Cursor executable '${this.executable}' was not found.`,
        );
      } else {
        fail('spawn_error', `Could not start Cursor CLI: ${cause.message}`);
      }
    };
    const onClose = (code: number | null): void => close(code);

    child.once('error', onError);
    child.once('close', onClose);
    child.stdout?.on('data', (chunk: Buffer | string) =>
      queue.push({ type: 'stdout', data: chunk.toString() }),
    );
    child.stderr?.on('data', (chunk: Buffer | string) =>
      queue.push({ type: 'stderr', data: chunk.toString() }),
    );

    if (signal !== undefined) {
      abortHandler = () => fail('aborted', 'Cursor CLI execution was aborted.');
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    timer = setTimeout(
      () => fail('timeout', `Cursor CLI execution timed out after ${timeoutMs} ms.`),
      timeoutMs,
    );

    return { queue, cancel };
  }
}
