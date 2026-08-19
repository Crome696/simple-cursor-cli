import { CursorCommandRunner } from './command-runner.js';
import {
  cliExitFailure,
  commandRunnerFailure,
  CursorCliError,
  CursorCommandRunnerError,
  unknownFailure,
  sanitizeDiagnostic,
  success,
} from './errors.js';
import {
  buildCapabilityPrompt,
  formatCursorModel,
  parseCursorMcpServers,
  parseCursorModels,
  parseCursorOutput,
  parseCursorStreamEvent,
  parseCursorVersion,
} from './parsers.js';
import { validateClientOptions, validateCursorRunInput } from './validation.js';
import type {
  CommandExecutionResult,
  CursorAskInput,
  CursorCliClientOptions,
  CursorCommandRunnerLike,
  CursorHealth,
  CursorMcpServer,
  CursorModelSummary,
  CursorOutputFormat,
  CursorPlanInput,
  CursorResult,
  CursorRunInput,
  CursorRunResult,
  CursorStreamEvent,
  CursorStreamInput,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Builds the deterministic argument array passed to the Cursor Agent CLI.
 *
 * The input is validated before any argument is emitted. The returned array
 * always enables print mode and an explicit output format, then appends the
 * configured operation, model, session, workspace, approval, and context
 * options.
 */
export function buildCursorCliArgs(
  input: CursorRunInput,
): CursorResult<readonly string[]> {
  const validation = validateCursorRunInput(input, 'buildArgs');
  if (!validation.ok) {
    return validation;
  }

  const outputFormat: CursorOutputFormat = input.outputFormat ?? 'json';
  const args: string[] = ['--print', '--output-format', outputFormat];
  const mode = input.plan === true ? 'plan' : input.mode;

  if (mode !== undefined && mode !== 'agent') {
    args.push(`--mode=${mode}`);
  }
  if (input.model !== undefined) {
    args.push('--model', formatCursorModel(input.model));
  }
  if (input.force === true) {
    args.push('--force');
  }
  if (input.yolo === true) {
    args.push('--yolo');
  }
  if (input.resume !== undefined) {
    args.push('--resume');
    if (typeof input.resume === 'string') {
      args.push(input.resume);
    }
  }
  if (input.continue === true) {
    args.push('--continue');
  }
  if (input.workspace !== undefined) {
    args.push('--workspace', input.workspace);
  }
  if (input.worktree !== undefined) {
    args.push('--worktree');
    if (typeof input.worktree === 'string') {
      args.push(input.worktree);
    }
  }
  if (input.streamPartialOutput === true) {
    args.push('--stream-partial-output');
  }
  args.push(...(input.extraArgs ?? []));
  args.push(buildCapabilityPrompt(input.prompt, input.capabilities));
  return success(args);
}

function throwForResult<T>(result: CursorResult<T>): T {
  if (!result.ok) {
    throw new CursorCliError(result.error);
  }
  return result.data;
}

/**
 * High-level typed client for invoking the installed Cursor Agent CLI.
 *
 * Aggregate methods return a discriminated result. The streaming method
 * exposes normalized events and raises CursorCliError for process or parsing
 * failures. Authentication and permission decisions remain with Cursor.
 */
export class CursorCliClient {
  private readonly runner: CursorCommandRunnerLike;
  private readonly timeoutMs: number;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;

  /**
   * Creates a client with an optional executable, process configuration, or
   * injectable runner.
   *
   * @param options Client defaults applied to each operation.
   */
  constructor(options: CursorCliClientOptions = {}) {
    const validation = validateClientOptions(options);
    if (!validation.ok) {
      throw new TypeError(validation.error.message);
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cwd = options.cwd;
    this.env = options.env;
    this.runner =
      options.runner ??
      new CursorCommandRunner({
        executable: options.executable,
        timeoutMs: this.timeoutMs,
        cwd: options.cwd,
        env: options.env,
      });
  }

  /**
   * Runs a headless Agent, Plan, or Ask operation and aggregates its output.
   *
   * @param input Prompt and operation options.
   * @returns A typed result or categorized operation error.
   */
  async run(input: CursorRunInput): Promise<CursorResult<CursorRunResult>> {
    const operation = 'run';
    const validation = validateCursorRunInput(input, operation);
    if (!validation.ok) {
      return validation;
    }

    const args = buildCursorCliArgs(input);
    if (!args.ok) {
      return args;
    }

    const result = await this.runRaw(operation, args.data, {
      cwd: input.cwd ?? this.cwd,
      env: input.env ?? this.env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    if (!result.ok) {
      return result;
    }
    if (result.data.exitCode !== 0) {
      return cliExitFailure(operation, result.data);
    }

    return parseCursorOutput(
      result.data.stdout,
      input.outputFormat ?? 'json',
      operation,
    );
  }

  /**
   * Runs the Cursor Plan mode without write-approval shortcuts.
   *
   * @param input Prompt and plan-compatible options.
   * @returns A typed result or categorized operation error.
   */
  async plan(input: CursorPlanInput): Promise<CursorResult<CursorRunResult>> {
    return this.run({ ...input, mode: 'plan', plan: true });
  }

  /**
   * Runs the Cursor Ask mode without write-approval shortcuts.
   *
   * @param input Prompt and ask-compatible options.
   * @returns A typed result or categorized operation error.
   */
  async ask(input: CursorAskInput): Promise<CursorResult<CursorRunResult>> {
    return this.run({ ...input, mode: 'ask', plan: false });
  }

  /**
   * Streams normalized Cursor events as they arrive.
   *
   * The method always requests stream-JSON output. Consumers can stop
   * iteration to trigger process cleanup; process, timeout, abort, exit, and
   * parse failures are raised as CursorCliError.
   *
   * @param input Prompt and stream-compatible options.
   * @returns An async iterable of normalized Cursor events.
   */
  stream(input: CursorStreamInput): AsyncIterable<CursorStreamEvent> {
    return this.streamInternal(input);
  }

  /**
   * Detects the installed CLI version and checks Cursor authentication status.
   *
   * A missing executable or failed version command is returned as an error.
   * When authentication is unavailable, the health result distinguishes
   * unauthenticated and unknown status with a sanitized diagnostic.
   *
   * @returns A typed health result or categorized diagnostic error.
   */
  async health(): Promise<CursorResult<CursorHealth>> {
    const versionResult = await this.runRaw('health.cli_version', ['--version']);
    if (!versionResult.ok) {
      return versionResult;
    }
    if (versionResult.data.exitCode !== 0) {
      return cliExitFailure('health.cli_version', versionResult.data);
    }

    const version = parseCursorVersion(versionResult.data.stdout);
    if (!version.ok) {
      return version;
    }

    const authResult = await this.runRaw('health.status', ['status']);
    if (!authResult.ok) {
      return authResult;
    }

    const authOutput = `${authResult.data.stdout}\n${authResult.data.stderr}`;
    const authenticated = authResult.data.exitCode === 0;
    const diagnostic = sanitizeDiagnostic(authOutput);
    const status = authenticated
      ? 'authenticated'
      : /not logged in|not authenticated|login required|invalid (?:api )?key|authentication|authenticat|unauthorized/iu.test(
            authOutput,
          )
        ? 'unauthenticated'
        : 'unknown';

    return success({
      cli: { available: true, version: version.data },
      authentication: {
        status,
        diagnostic: authenticated ? null : diagnostic || null,
      },
      canRun: authenticated,
    });
  }

  /**
   * Lists models reported by the installed Cursor CLI.
   *
   * @returns Normalized model summaries or a categorized operation error.
   */
  async listModels(): Promise<CursorResult<readonly CursorModelSummary[]>> {
    const operation = 'models.list';
    const result = await this.runRaw(operation, ['models']);
    if (!result.ok) {
      return result;
    }
    if (result.data.exitCode !== 0) {
      return cliExitFailure(operation, result.data);
    }
    return parseCursorModels(result.data.stdout, operation);
  }

  /**
   * Lists MCP servers reported by the installed Cursor CLI.
   *
   * @returns Normalized server summaries or a categorized operation error.
   */
  async listMcpServers(): Promise<CursorResult<readonly CursorMcpServer[]>> {
    const operation = 'mcp.list';
    const result = await this.runRaw(operation, ['mcp', 'list']);
    if (!result.ok) {
      return result;
    }
    if (result.data.exitCode !== 0) {
      return cliExitFailure(operation, result.data);
    }
    return parseCursorMcpServers(result.data.stdout, operation);
  }

  private async *streamInternal(
    input: CursorStreamInput,
  ): AsyncIterable<CursorStreamEvent> {
    const operation = 'stream';
    const streamInput: CursorRunInput = {
      ...input,
      outputFormat: 'stream-json',
    };
    const validation = validateCursorRunInput(streamInput, operation);
    if (!validation.ok) {
      throw new CursorCliError(validation.error);
    }

    const args = buildCursorCliArgs(streamInput);
    if (!args.ok) {
      throw new CursorCliError(args.error);
    }

    const options = {
      cwd: input.cwd ?? this.cwd,
      env: input.env ?? this.env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    };

    try {
      if (this.runner.stream !== undefined) {
        yield* this.streamFromRunner(args.data, options, operation);
        return;
      }

      const result = await this.runner.execute(args.data, options);
      if (result.exitCode !== 0) {
        throwForResult(cliExitFailure(operation, result));
      }
      const parsed = parseCursorOutput(result.stdout, 'stream-json', operation);
      const runResult = throwForResult(parsed);
      for (const event of runResult.events) {
        yield event;
      }
    } catch (cause) {
      if (cause instanceof CursorCliError) {
        throw cause;
      }
      if (cause instanceof CursorCommandRunnerError) {
        const result = commandRunnerFailure(operation, cause);
        if (!result.ok) {
          throw new CursorCliError(result.error);
        }
        throw new Error('Unexpected successful command-runner failure result.');
      }
      const result = unknownFailure(operation, cause);
      if (!result.ok) {
        throw new CursorCliError(result.error);
      }
      throw new Error('Unexpected successful unknown failure result.');
    }
  }

  private async *streamFromRunner(
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    },
    operation: string,
  ): AsyncIterable<CursorStreamEvent> {
    let lineBuffer = '';
    let stdout = '';
    let stderr = '';
    let lineNumber = 0;
    let eventCount = 0;
    let exitCode = 0;
    let closed = false;

    const parseLine = (line: string): CursorStreamEvent => {
      lineNumber += 1;
      const parsed = parseCursorStreamEvent(
        JSON.parse(line) as unknown,
        `${operation}.line${lineNumber}`,
      );
      if (!parsed.ok) {
        throw new CursorCliError(parsed.error);
      }
      eventCount += 1;
      return parsed.data;
    };

    try {
      const processEvents = this.runner.stream?.(args, options);
      if (processEvents === undefined) {
        throw new Error('The configured runner does not support streaming.');
      }
      for await (const processEvent of processEvents) {
        if (processEvent.type === 'stdout') {
          stdout += processEvent.data;
          lineBuffer += processEvent.data;
          const lines = lineBuffer.split(/\r?\n/u);
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed !== '') {
              let event: CursorStreamEvent;
              try {
                event = parseLine(trimmed);
              } catch (cause) {
                if (cause instanceof CursorCliError) {
                  throw cause;
                }
                throw new CursorCliError({
                  category: 'parse',
                  operation,
                  message: `Invalid Cursor stream JSON: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                });
              }
              yield event;
            }
          }
        } else if (processEvent.type === 'stderr') {
          stderr += processEvent.data;
        } else {
          closed = true;
          exitCode = processEvent.exitCode;
        }
      }

      if (lineBuffer.trim() !== '') {
        let event: CursorStreamEvent;
        try {
          event = parseLine(lineBuffer.trim());
        } catch (cause) {
          if (cause instanceof CursorCliError) {
            throw cause;
          }
          throw new CursorCliError({
            category: 'parse',
            operation,
            message: `Invalid Cursor stream JSON: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          });
        }
        yield event;
      }

      if (closed && exitCode !== 0) {
        throwForResult(
          cliExitFailure(operation, {
            exitCode,
            stdout,
            stderr,
          }),
        );
      }
      if (eventCount === 0) {
        throw new CursorCliError({
          category: 'parse',
          operation,
          message: 'Cursor stream output did not contain events.',
        });
      }
    } catch (cause) {
      if (cause instanceof CursorCliError) {
        throw cause;
      }
      if (cause instanceof CursorCommandRunnerError) {
        const result = commandRunnerFailure(operation, cause);
        if (!result.ok) {
          throw new CursorCliError(result.error);
        }
        throw new Error('Unexpected successful command-runner failure result.');
      }
      const result = unknownFailure(operation, cause);
      if (!result.ok) {
        throw new CursorCliError(result.error);
      }
      throw new Error('Unexpected successful unknown failure result.');
    }
  }

  private async runRaw(
    operation: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<CursorResult<CommandExecutionResult>> {
    try {
      const result = await this.runner.execute(args, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        signal: options.signal,
      });
      return success(result);
    } catch (cause) {
      if (cause instanceof CursorCommandRunnerError) {
        return commandRunnerFailure(operation, cause);
      }
      return unknownFailure(operation, cause);
    }
  }
}
