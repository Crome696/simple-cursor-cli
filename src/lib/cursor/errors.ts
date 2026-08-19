import type { CommandExecutionResult, CursorError, CursorResult } from './types.js';

export type CursorCommandRunnerErrorCode =
  'executable_unavailable' | 'timeout' | 'aborted' | 'spawn_error';

export class CursorCliError extends Error {
  readonly error: CursorError;

  constructor(error: CursorError) {
    const safeError: CursorError = {
      ...error,
      message: sanitizeDiagnostic(error.message),
      ...(error.stderr === undefined
        ? {}
        : { stderr: sanitizeDiagnostic(error.stderr) }),
    };
    super(safeError.message);
    this.name = 'CursorCliError';
    this.error = safeError;
  }
}

export class CursorCommandRunnerError extends Error {
  readonly code: CursorCommandRunnerErrorCode;
  readonly stderr: string;

  constructor(
    code: CursorCommandRunnerErrorCode,
    message: string,
    options: { readonly stderr?: string } = {},
  ) {
    super(sanitizeDiagnostic(message));
    this.name = 'CursorCommandRunnerError';
    this.code = code;
    this.stderr = sanitizeDiagnostic(options.stderr ?? '');
  }
}

export function success<T>(data: T): CursorResult<T> {
  return { ok: true, data };
}

export function failure<T = never>(error: CursorError): CursorResult<T> {
  return { ok: false, error };
}

export function sanitizeDiagnostic(value: string): string {
  const withoutAnsi = value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?[a-zA-Z\d]+))/g,
    '',
  );

  const redacted = withoutAnsi
    .replace(/\b(?:crsr|cursor)_[A-Za-z0-9._~-]+\b/gi, '[REDACTED]')
    .replace(
      /\b(?:api[-_ ]?key|auth[-_ ]?token|access[-_ ]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
      (match) => `${match.slice(0, match.search(/[:=]/))}=[REDACTED]`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(?:token|secret|password)\s+[A-Za-z0-9._~+/-]+=*/gi,
      (match) => `${match.split(/\s+/u)[0]} [REDACTED]`,
    );

  return redacted.replace(/\s+/gu, ' ').trim().slice(0, 500);
}

function error(
  category: CursorError['category'],
  operation: string,
  message: string,
  details: Pick<CursorError, 'exitCode' | 'stderr'> = {},
): CursorError {
  return {
    category,
    operation,
    message: sanitizeDiagnostic(message),
    ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
    ...(details.stderr === undefined
      ? {}
      : { stderr: sanitizeDiagnostic(details.stderr) }),
  };
}

export function validationFailure(
  operation: string,
  message: string,
): CursorResult<never> {
  return failure(error('validation', operation, message));
}

export function parseFailure(operation: string, message: string): CursorResult<never> {
  return failure(error('parse', operation, message));
}

export function jsonFailure(operation: string, message: string): CursorResult<never> {
  return parseFailure(operation, `Invalid Cursor JSON output: ${message}`);
}

function classifyDiagnostic(diagnostic: string): CursorError['category'] | undefined {
  const lower = diagnostic.toLocaleLowerCase();

  if (
    /(not logged|not authenticated|authentication|login required|please log in|unauthori[sz]ed|invalid (?:api )?key|auth[- ]?token)/u.test(
      lower,
    )
  ) {
    return 'authentication';
  }
  if (
    /(permission denied|forbidden|access denied|not allowed|approval required)/u.test(
      lower,
    )
  ) {
    return 'permission';
  }
  if (
    /(invalid model|unknown model|unsupported model|model .* not found)/u.test(lower)
  ) {
    return 'invalid_model';
  }
  if (/(command not found|no such file|cannot find|unknown command)/u.test(lower)) {
    return 'not_found';
  }
  return undefined;
}

export function cliExitFailure(
  operation: string,
  result: Pick<CommandExecutionResult, 'exitCode' | 'stdout' | 'stderr'>,
): CursorResult<never> {
  const diagnostic = sanitizeDiagnostic(
    [result.stderr, result.stdout].filter(Boolean).join(' '),
  );
  const category = classifyDiagnostic(diagnostic) ?? 'cli_exit';
  const detail = diagnostic === '' ? '' : ` ${diagnostic}`;

  return failure(
    error(
      category,
      operation,
      `Cursor CLI exited with code ${result.exitCode}.${detail}`,
      { exitCode: result.exitCode, stderr: result.stderr },
    ),
  );
}

export function commandRunnerFailure(
  operation: string,
  runnerError: CursorCommandRunnerError,
): CursorResult<never> {
  const category: CursorError['category'] =
    runnerError.code === 'executable_unavailable'
      ? 'cli_unavailable'
      : runnerError.code === 'timeout'
        ? 'timeout'
        : runnerError.code === 'aborted'
          ? 'aborted'
          : 'unknown';

  return failure(
    error(category, operation, runnerError.message, {
      stderr: runnerError.stderr,
    }),
  );
}

export function unknownFailure(operation: string, cause: unknown): CursorResult<never> {
  const message = cause instanceof Error ? cause.message : String(cause);
  return failure(error('unknown', operation, message));
}
