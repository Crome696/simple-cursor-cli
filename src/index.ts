export { CursorCliClient, buildCursorCliArgs } from './lib/cursor/client.js';
export { CursorCommandRunner } from './lib/cursor/command-runner.js';
export {
  CursorCliError,
  CursorCommandRunnerError,
  commandRunnerFailure,
  sanitizeDiagnostic,
} from './lib/cursor/errors.js';
export {
  buildCapabilityPrompt,
  formatCursorModel,
  parseCursorMcpServers,
  parseCursorModels,
  parseCursorOutput,
  parseCursorStreamEvent,
  parseCursorVersion,
} from './lib/cursor/parsers.js';
export {
  validateClientOptions,
  validateCursorRunInput,
} from './lib/cursor/validation.js';

export type {
  CommandExecutionOptions,
  CommandExecutionResult,
  CursorAskInput,
  CursorAssistantEvent,
  CursorAuthenticationStatus,
  CursorCapabilitySelection,
  CursorCliClientOptions,
  CursorCommandRunnerLike,
  CursorError,
  CursorErrorCategory,
  CursorHealth,
  CursorMcpServer,
  CursorMode,
  CursorModel,
  CursorModelSelection,
  CursorModelSummary,
  CursorOutputFormat,
  CursorPlanInput,
  CursorProcessEvent,
  CursorResult,
  CursorResultEvent,
  CursorRunInput,
  CursorRunResult,
  CursorStreamEvent,
  CursorStreamInput,
  CursorSystemEvent,
  CursorToolCallEvent,
  CursorUnknownEvent,
} from './lib/cursor/types.js';

export type { CursorCommandRunnerErrorCode } from './lib/cursor/errors.js';
