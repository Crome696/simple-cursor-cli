export type CursorMode = 'agent' | 'plan' | 'ask';

export type CursorOutputFormat = 'text' | 'json' | 'stream-json';

/**
 * A model can be passed through unchanged as a string, or selected by an
 * object whose `variant` is the exact model value accepted by Cursor.
 *
 * The object form deliberately does not invent a reasoning flag. Cursor model
 * names and variants are version-specific, so callers can use the string form
 * for any value supported by their installed CLI.
 */
export interface CursorModelSelection {
  readonly id: string;
  readonly variant?: string;
}

export type CursorModel = string | CursorModelSelection;

export interface CursorCapabilitySelection {
  readonly skills?: readonly string[];
  readonly plugins?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly subagents?: readonly string[];
  readonly rules?: readonly string[];
  readonly files?: readonly string[];
}

export interface CursorRunInput {
  readonly prompt: string;
  readonly model?: CursorModel;
  readonly mode?: CursorMode;
  /** Shorthand for `mode: 'plan'`. */
  readonly plan?: boolean;
  readonly capabilities?: CursorCapabilitySelection;
  /** Defaults to `json` for stable programmatic consumption. */
  readonly outputFormat?: CursorOutputFormat;
  /** Allow write and terminal actions that would otherwise require approval. */
  readonly force?: boolean;
  /** Cursor's non-interactive approval shortcut. */
  readonly yolo?: boolean;
  readonly resume?: string | boolean;
  readonly continue?: boolean;
  readonly workspace?: string;
  readonly worktree?: string | boolean;
  readonly streamPartialOutput?: boolean;
  /** Additional version-specific CLI flags, appended after library flags. */
  readonly extraArgs?: readonly string[];
  /** Working directory used only by the child process. */
  readonly cwd?: string;
  /** Environment overlay used only by the child process. */
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type CursorPlanInput = Omit<CursorRunInput, 'mode' | 'plan' | 'force' | 'yolo'>;

export type CursorAskInput = Omit<CursorRunInput, 'mode' | 'plan' | 'force' | 'yolo'>;

export type CursorStreamInput = Omit<CursorRunInput, 'outputFormat'> & {
  readonly outputFormat?: 'stream-json';
};

export interface CommandExecutionOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface CommandExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Low-level process events exposed only to injectable runners. */
export type CursorProcessEvent =
  | { readonly type: 'stdout'; readonly data: string }
  | { readonly type: 'stderr'; readonly data: string }
  | {
      readonly type: 'close';
      readonly exitCode: number;
      readonly durationMs: number;
    };

export interface CursorCommandRunnerLike {
  execute(
    args: readonly string[],
    options?: CommandExecutionOptions,
  ): Promise<CommandExecutionResult>;
  /** Optional low-level stream support for incremental headless output. */
  stream?(
    args: readonly string[],
    options?: CommandExecutionOptions,
  ): AsyncIterable<CursorProcessEvent>;
}

export interface CursorCliClientOptions {
  readonly runner?: CursorCommandRunnerLike;
  /** Defaults to `agent`; `cursor-agent` is supported only when explicit. */
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CursorSystemEvent {
  readonly type: 'system';
  readonly subtype?: string;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly raw: unknown;
}

export interface CursorAssistantEvent {
  readonly type: 'assistant';
  readonly subtype?: string;
  readonly text: string;
  readonly sessionId: string | null;
  readonly raw: unknown;
}

export interface CursorToolCallEvent {
  readonly type: 'tool_call';
  readonly subtype?: string;
  readonly toolName: string | null;
  readonly status: string | null;
  readonly sessionId: string | null;
  readonly raw: unknown;
}

export interface CursorResultEvent {
  readonly type: 'result';
  readonly subtype?: string;
  readonly text: string;
  readonly sessionId: string | null;
  readonly requestId: string | null;
  readonly model: string | null;
  readonly durationMs: number | null;
  readonly durationApiMs: number | null;
  readonly raw: unknown;
}

export interface CursorUnknownEvent {
  readonly type: string;
  readonly raw: unknown;
}

export type CursorStreamEvent =
  | CursorSystemEvent
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | CursorUnknownEvent;

export interface CursorRunResult {
  readonly text: string;
  readonly sessionId: string | null;
  readonly requestId: string | null;
  readonly model: string | null;
  readonly durationMs: number | null;
  readonly durationApiMs: number | null;
  readonly outputFormat: CursorOutputFormat;
  readonly events: readonly CursorStreamEvent[];
  readonly raw: unknown;
}

export type CursorAuthenticationStatus =
  'authenticated' | 'unauthenticated' | 'unknown';

export interface CursorHealth {
  readonly cli: {
    readonly available: true;
    readonly version: string;
  };
  readonly authentication: {
    readonly status: CursorAuthenticationStatus;
    readonly diagnostic: string | null;
  };
  readonly canRun: boolean;
}

export interface CursorModelSummary {
  readonly id: string;
  readonly name: string | null;
  readonly raw: unknown;
}

export interface CursorMcpServer {
  readonly name: string;
  readonly status: string | null;
  readonly raw: unknown;
}

export type CursorErrorCategory =
  | 'validation'
  | 'cli_unavailable'
  | 'authentication'
  | 'permission'
  | 'not_found'
  | 'invalid_model'
  | 'timeout'
  | 'aborted'
  | 'cli_exit'
  | 'parse'
  | 'unknown';

export interface CursorError {
  readonly category: CursorErrorCategory;
  readonly operation: string;
  readonly message: string;
  readonly exitCode?: number;
  readonly stderr?: string;
}

export type CursorResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: CursorError };
