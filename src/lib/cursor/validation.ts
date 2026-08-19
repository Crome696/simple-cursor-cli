import { validationFailure } from './errors.js';
import type {
  CursorCapabilitySelection,
  CursorCliClientOptions,
  CursorModel,
  CursorModelSelection,
  CursorResult,
  CursorRunInput,
} from './types.js';

function validateText(
  value: string,
  field: string,
  operation: string,
  required = false,
): CursorResult<string> {
  if (typeof value !== 'string') {
    return validationFailure(operation, `${field} must be a string.`);
  }
  if (required && value.trim().length === 0) {
    return validationFailure(operation, `${field} must not be empty.`);
  }
  if (value.includes('\u0000')) {
    return validationFailure(operation, `${field} must not contain NUL characters.`);
  }
  return { ok: true, data: value };
}

function validateCollection(
  values: readonly string[] | undefined,
  field: string,
  operation: string,
): CursorResult<undefined> {
  if (values === undefined) {
    return { ok: true, data: undefined };
  }
  if (!Array.isArray(values)) {
    return validationFailure(operation, `${field} must be an array.`);
  }
  for (const value of values) {
    const validated = validateText(value, field, operation, true);
    if (!validated.ok) {
      return validated;
    }
  }
  return { ok: true, data: undefined };
}

function validateModel(
  model: CursorModel | undefined,
  operation: string,
): CursorResult<CursorModel | undefined> {
  if (model === undefined) {
    return { ok: true, data: undefined };
  }
  if (typeof model === 'string') {
    const validated = validateText(model, 'model', operation, true);
    return validated.ok ? { ok: true, data: validated.data } : validated;
  }
  if (typeof model !== 'object' || model === null) {
    return validationFailure(operation, 'model must be a string or selection object.');
  }

  const selection = model as CursorModelSelection;
  const id = validateText(selection.id, 'model.id', operation, true);
  if (!id.ok) {
    return id;
  }
  if (selection.variant !== undefined) {
    const variant = validateText(selection.variant, 'model.variant', operation, true);
    if (!variant.ok) {
      return variant;
    }
  }
  return { ok: true, data: model };
}

function validateCapabilities(
  capabilities: CursorCapabilitySelection | undefined,
  operation: string,
): CursorResult<undefined> {
  if (capabilities === undefined) {
    return { ok: true, data: undefined };
  }
  if (typeof capabilities !== 'object' || capabilities === null) {
    return validationFailure(operation, 'capabilities must be an object.');
  }

  for (const [field, values] of Object.entries(capabilities)) {
    const result = validateCollection(
      values as readonly string[] | undefined,
      `capabilities.${field}`,
      operation,
    );
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true, data: undefined };
}

function validateExtraArgs(
  extraArgs: readonly string[] | undefined,
  operation: string,
): CursorResult<undefined> {
  if (extraArgs === undefined) {
    return { ok: true, data: undefined };
  }
  if (!Array.isArray(extraArgs)) {
    return validationFailure(operation, 'extraArgs must be an array.');
  }

  for (const arg of extraArgs) {
    const value = validateText(arg, 'extraArgs', operation);
    if (!value.ok) {
      return value;
    }
  }

  const credentialFlag = extraArgs.find((arg) =>
    /^(?:-a|--api-key|--auth-token|--access-token|--token|--password|--secret)(?:=|$)/iu.test(
      arg,
    ),
  );
  if (credentialFlag !== undefined) {
    return validationFailure(
      operation,
      'Credential flags are managed by Cursor authentication or environment configuration and cannot be passed through this library.',
    );
  }
  return { ok: true, data: undefined };
}

function validateApprovalEscapeHatch(
  input: CursorRunInput,
  operation: string,
): CursorResult<undefined> {
  if (input.mode !== 'plan' && input.mode !== 'ask' && input.plan !== true) {
    return { ok: true, data: undefined };
  }
  const writeFlag = (input.extraArgs ?? []).find((arg) =>
    /^(?:--force|--yolo)(?:=|$)/iu.test(arg),
  );
  return writeFlag === undefined
    ? { ok: true, data: undefined }
    : validationFailure(
        operation,
        'force and yolo cannot be supplied through extraArgs for plan or ask mode.',
      );
}

/**
 * Validates one run-like operation before argument construction or spawning.
 *
 * The checks cover values, incompatible options, paths, timeouts, extra
 * arguments, and credential-bearing flags.
 */
export function validateCursorRunInput(
  input: CursorRunInput,
  operation = 'run',
): CursorResult<CursorRunInput> {
  if (typeof input !== 'object' || input === null) {
    return validationFailure(operation, 'input must be an object.');
  }

  const prompt = validateText(input.prompt, 'prompt', operation, true);
  if (!prompt.ok) {
    return prompt;
  }

  const model = validateModel(input.model, operation);
  if (!model.ok) {
    return model;
  }

  const capabilities = validateCapabilities(input.capabilities, operation);
  if (!capabilities.ok) {
    return capabilities;
  }

  if (input.mode !== undefined && !['agent', 'plan', 'ask'].includes(input.mode)) {
    return validationFailure(operation, 'mode must be one of: agent, plan, ask.');
  }
  if (
    input.outputFormat !== undefined &&
    !['text', 'json', 'stream-json'].includes(input.outputFormat)
  ) {
    return validationFailure(
      operation,
      'outputFormat must be one of: text, json, stream-json.',
    );
  }
  if (input.plan === true && input.mode !== undefined && input.mode !== 'plan') {
    return validationFailure(operation, 'plan can only be combined with mode=plan.');
  }
  if (input.force === true && input.yolo === true) {
    return validationFailure(operation, 'force and yolo are mutually exclusive.');
  }
  if (input.force === true && (input.mode === 'plan' || input.plan === true)) {
    return validationFailure(operation, 'force is not valid for plan mode.');
  }
  if (input.yolo === true && (input.mode === 'plan' || input.plan === true)) {
    return validationFailure(operation, 'yolo is not valid for plan mode.');
  }
  if (input.resume !== undefined && input.continue === true) {
    return validationFailure(operation, 'resume and continue are mutually exclusive.');
  }
  if (typeof input.resume === 'string') {
    const resume = validateText(input.resume, 'resume', operation, true);
    if (!resume.ok) {
      return resume;
    }
  }
  if (input.streamPartialOutput === true && input.outputFormat !== 'stream-json') {
    return validationFailure(
      operation,
      'streamPartialOutput requires outputFormat=stream-json.',
    );
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1)
  ) {
    return validationFailure(operation, 'timeoutMs must be a positive integer.');
  }

  for (const [field, value] of [
    ['workspace', input.workspace],
    ['cwd', input.cwd],
  ] as const) {
    if (value !== undefined) {
      const result = validateText(value, field, operation, true);
      if (!result.ok) {
        return result;
      }
    }
  }
  if (typeof input.worktree === 'string') {
    const worktree = validateText(input.worktree, 'worktree', operation, true);
    if (!worktree.ok) {
      return worktree;
    }
  }

  const extraArgs = validateExtraArgs(input.extraArgs, operation);
  if (!extraArgs.ok) {
    return extraArgs;
  }
  const approvalEscapeHatch = validateApprovalEscapeHatch(input, operation);
  if (!approvalEscapeHatch.ok) {
    return approvalEscapeHatch;
  }

  return { ok: true, data: input };
}

/**
 * Validates the defaults used to construct a high-level Cursor client.
 */
export function validateClientOptions(
  options: CursorCliClientOptions,
): CursorResult<CursorCliClientOptions> {
  if (typeof options !== 'object' || options === null) {
    return validationFailure('client', 'options must be an object.');
  }
  if (options.executable !== undefined) {
    const executable = validateText(options.executable, 'executable', 'client', true);
    if (!executable.ok) {
      return executable;
    }
  }
  if (options.cwd !== undefined) {
    const cwd = validateText(options.cwd, 'cwd', 'client', true);
    if (!cwd.ok) {
      return cwd;
    }
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)
  ) {
    return validationFailure('client', 'timeoutMs must be a positive integer.');
  }
  return { ok: true, data: options };
}
