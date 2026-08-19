/** Cursor operation mode understood by the headless Agent CLI. */
export type CursorMode = 'agent' | 'plan' | 'ask';

/** Output representation requested from the Cursor CLI. */
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

/** A raw model value or an explicit model selection object. */
export type CursorModel = string | CursorModelSelection;

/** Optional context labels appended to the operation prompt. */
export interface CursorCapabilitySelection {
  readonly skills?: readonly string[];
  readonly plugins?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly subagents?: readonly string[];
  readonly rules?: readonly string[];
  readonly files?: readonly string[];
}

/** Shared input accepted by the general client operation. */
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

/** Input for the plan convenience method. */
export type CursorPlanInput = Omit<CursorRunInput, 'mode' | 'plan' | 'force' | 'yolo'>;

/** Input for the ask convenience method. */
export type CursorAskInput = Omit<CursorRunInput, 'mode' | 'plan' | 'force' | 'yolo'>;

/** Input for incremental stream operations. */
export type CursorStreamInput = Omit<CursorRunInput, 'outputFormat'> & {
  readonly outputFormat?: 'stream-json';
};

/** Process controls passed to an injectable command runner. */
export interface CommandExecutionOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

/** Completed stdout, stderr, exit-code, and duration data. */
export interface CommandExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Low-level process events exposed only through injectable runners. */
export type CursorProcessEvent =
  | { readonly type: 'stdout'; readonly data: string }
  | { readonly type: 'stderr'; readonly data: string }
  | {
      readonly type: 'close';
      readonly exitCode: number;
      readonly durationMs: number;
    };

/** Injectable runner contract used by the client and offline tests. */
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

/** Defaults and dependencies used to construct a Cursor client. */
export interface CursorCliClientOptions {
  readonly runner?: CursorCommandRunnerLike;
  /** Defaults to `agent`; `cursor-agent` is supported only when explicit. */
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Normalized Cursor session or system initialization event. */
export interface CursorSystemEvent {
  readonly type: 'system';
  readonly subtype?: string;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly raw: unknown;
}

/** Normalized assistant response or delta event. */
export interface CursorAssistantEvent {
  readonly type: 'assistant';
  readonly subtype?: string;
  readonly text: string;
  readonly sessionId: string | null;
  readonly raw: unknown;
}

/** Normalized tool-call progress event. */
export interface CursorToolCallEvent {
  readonly type: 'tool_call';
  readonly subtype?: string;
  readonly toolName: string | null;
  readonly status: string | null;
  readonly sessionId: string | null;
  readonly raw: unknown;
}

/** Normalized terminal result event with request metadata. */
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

/** Forward-compatible event retaining an unknown raw Cursor value. */
export interface CursorUnknownEvent {
  readonly type: string;
  readonly raw: unknown;
}

/** Union of normalized and forward-compatible stream events. */
export type CursorStreamEvent =
  | CursorSystemEvent
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | CursorUnknownEvent;

/** Aggregated output returned by non-streaming client operations. */
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

/** Authentication state reported by the health operation. */
export type CursorAuthenticationStatus =
  'authenticated' | 'unauthenticated' | 'unknown';

/** CLI availability, authentication, and run-readiness diagnostic. */
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

/** Stable model summary with the original parsed item. */
export interface CursorModelSummary {
  readonly id: string;
  readonly name: string | null;
  readonly raw: unknown;
}

/** Stable MCP-server summary with the original parsed item. */
export interface CursorMcpServer {
  readonly name: string;
  readonly status: string | null;
  readonly raw: unknown;
}

/** Stable categories for expected operation and process failures. */
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

/** Sanitized structured error returned in a failed CursorResult. */
export interface CursorError {
  readonly category: CursorErrorCategory;
  readonly operation: string;
  readonly message: string;
  readonly exitCode?: number;
  readonly stderr?: string;
}

/** Discriminated success/failure result returned by aggregate operations. */
export type CursorResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: CursorError };
