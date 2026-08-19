import { jsonFailure, parseFailure, success } from './errors.js';
import type {
  CursorCapabilitySelection,
  CursorModel,
  CursorMcpServer,
  CursorOutputFormat,
  CursorResult,
  CursorResultEvent,
  CursorRunResult,
  CursorStreamEvent,
  CursorUnknownEvent,
  CursorModelSummary,
} from './types.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstValue(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function firstString(record: JsonRecord, ...keys: readonly string[][]): string | null {
  for (const keyGroup of keys) {
    const value = stringValue(firstValue(record, keyGroup));
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function firstNumber(record: JsonRecord, ...keys: readonly string[][]): number | null {
  for (const keyGroup of keys) {
    const value = numberValue(firstValue(record, keyGroup));
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function sessionId(record: JsonRecord): string | null {
  const direct = firstString(
    record,
    ['session_id', 'sessionId'],
    ['conversation_id', 'conversationId'],
  );
  if (direct !== null) {
    return direct;
  }

  const session = asRecord(firstValue(record, ['session']));
  return session === null
    ? null
    : firstString(session, ['id', 'session_id', 'sessionId']);
}

function textFromValue(value: unknown): string {
  const direct = stringValue(value);
  if (direct !== null) {
    return direct;
  }
  const array = asArray(value);
  if (array !== null) {
    return array
      .map((item) => textFromValue(item))
      .filter(Boolean)
      .join('');
  }
  const record = asRecord(value);
  if (record === null) {
    return '';
  }
  for (const key of ['text', 'value', 'content', 'delta', 'output']) {
    if (record[key] !== undefined) {
      const text = textFromValue(record[key]);
      if (text !== '') {
        return text;
      }
    }
  }
  return '';
}

function textFromRecord(
  record: JsonRecord,
  keys: readonly string[] = ['text', 'result', 'output', 'content', 'delta'],
): string {
  for (const key of keys) {
    if (record[key] !== undefined) {
      const text = textFromValue(record[key]);
      if (text !== '') {
        return text;
      }
    }
  }

  const message = asRecord(record.message);
  return message === null ? '' : textFromRecord(message, keys);
}

function rawEventType(record: JsonRecord): string | null {
  return firstString(record, ['type', 'event', 'kind']);
}

function canonicalEventType(type: string): string {
  return type.trim().toLocaleLowerCase().replace(/[- ]/gu, '_');
}

function unknownEvent(type: string, raw: unknown): CursorUnknownEvent {
  return { type, raw };
}

/**
 * Normalizes one raw Cursor stream value into a typed event.
 *
 * Known event families receive stable fields; unknown event types retain their
 * original value so callers can remain forward-compatible.
 */
export function parseCursorStreamEvent(
  value: unknown,
  operation = 'stream',
): CursorResult<CursorStreamEvent> {
  const record = asRecord(value);
  if (record === null) {
    return parseFailure(operation, 'Each stream event must be a JSON object.');
  }

  const originalType = rawEventType(record);
  const type = canonicalEventType(originalType ?? 'unknown');
  const subtype = firstString(record, ['subtype', 'sub_type']);
  const raw = value;

  switch (type) {
    case 'system':
    case 'init':
    case 'session':
      return success({
        type: 'system',
        ...(subtype === null ? {} : { subtype }),
        sessionId: sessionId(record),
        model: firstString(record, ['model', 'model_id', 'modelId']),
        raw,
      });
    case 'assistant':
    case 'assistant_message':
    case 'assistant_delta':
    case 'message':
    case 'delta':
      return success({
        type: 'assistant',
        ...(subtype === null ? {} : { subtype }),
        text: textFromRecord(record),
        sessionId: sessionId(record),
        raw,
      });
    case 'tool_call':
    case 'tool_use':
    case 'tool':
    case 'function_call': {
      const tool = asRecord(firstValue(record, ['tool', 'function']));
      return success({
        type: 'tool_call',
        ...(subtype === null ? {} : { subtype }),
        toolName:
          firstString(record, ['tool_name', 'toolName', 'name']) ??
          (tool === null ? null : firstString(tool, ['name', 'tool_name'])),
        status: firstString(record, ['status', 'state']),
        sessionId: sessionId(record),
        raw,
      });
    }
    case 'result':
    case 'final':
    case 'completion':
    case 'done': {
      const nestedResult = asRecord(record.result);
      const resultRecord = nestedResult ?? record;
      const hasResultText = ['text', 'result', 'output', 'content', 'delta'].some(
        (key) => resultRecord[key] !== undefined,
      );
      if (!hasResultText) {
        return parseFailure(
          operation,
          'The Cursor CLI emitted a result event without result text.',
        );
      }
      return success({
        type: 'result',
        ...(subtype === null ? {} : { subtype }),
        text: textFromRecord(resultRecord),
        sessionId: sessionId(resultRecord) ?? sessionId(record),
        requestId:
          firstString(resultRecord, ['request_id', 'requestId']) ??
          firstString(record, ['request_id', 'requestId']),
        model:
          firstString(resultRecord, ['model', 'model_id', 'modelId']) ??
          firstString(record, ['model', 'model_id', 'modelId']),
        durationMs: firstNumber(resultRecord, [
          'duration_ms',
          'durationMs',
          'duration',
        ]),
        durationApiMs: firstNumber(resultRecord, [
          'duration_api_ms',
          'durationApiMs',
          'api_duration_ms',
        ]),
        raw,
      });
    }
    default:
      return success(unknownEvent(originalType ?? 'unknown', raw));
  }
}

function looksLikeResultRecord(record: JsonRecord): boolean {
  return [
    'text',
    'result',
    'output',
    'content',
    'message',
    'session_id',
    'sessionId',
    'request_id',
    'requestId',
    'model',
  ].some((key) => record[key] !== undefined);
}

function parseJson(value: string, operation: string): CursorResult<unknown> {
  try {
    return success(JSON.parse(value) as unknown);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'invalid JSON';
    return jsonFailure(operation, message);
  }
}

function resultEventFromRecord(
  record: JsonRecord,
  operation: string,
): CursorResult<CursorResultEvent> {
  if (!looksLikeResultRecord(record)) {
    return parseFailure(operation, 'Cursor JSON output did not contain a result.');
  }
  const event = parseCursorStreamEvent({ type: 'result', ...record }, operation);
  if (!event.ok) {
    return { ok: false, error: event.error };
  }
  if (
    event.data.type !== 'result' ||
    !('text' in event.data) ||
    !('requestId' in event.data)
  ) {
    return parseFailure(operation, 'Cursor JSON output did not contain a result.');
  }
  return success(event.data as CursorResultEvent);
}

function aggregateEvents(
  events: readonly CursorStreamEvent[],
  outputFormat: CursorOutputFormat,
  raw: unknown,
): CursorResult<CursorRunResult> {
  const resultEvent = [...events]
    .reverse()
    .find((event): event is CursorResultEvent => event.type === 'result');
  const assistantText = events
    .filter(
      (event): event is Extract<CursorStreamEvent, { type: 'assistant' }> =>
        event.type === 'assistant',
    )
    .map((event) => event.text)
    .join('');
  const systemEvent = events.find(
    (event): event is Extract<CursorStreamEvent, { type: 'system' }> =>
      event.type === 'system',
  );

  return success({
    text: resultEvent?.text ?? assistantText,
    sessionId: resultEvent?.sessionId ?? systemEvent?.sessionId ?? null,
    requestId: resultEvent?.requestId ?? null,
    model: resultEvent?.model ?? systemEvent?.model ?? null,
    durationMs: resultEvent?.durationMs ?? null,
    durationApiMs: resultEvent?.durationApiMs ?? null,
    outputFormat,
    events,
    raw,
  });
}

/**
 * Parses text, JSON, or line-delimited stream-JSON Cursor output.
 *
 * JSON and stream-JSON results are aggregated into a typed run result with
 * normalized events and the original raw representation.
 */
export function parseCursorOutput(
  stdout: string,
  outputFormat: CursorOutputFormat,
  operation = 'run',
): CursorResult<CursorRunResult> {
  if (outputFormat === 'text') {
    return success({
      text: stdout.trim(),
      sessionId: null,
      requestId: null,
      model: null,
      durationMs: null,
      durationApiMs: null,
      outputFormat,
      events: [],
      raw: stdout,
    });
  }

  if (outputFormat === 'json') {
    const parsed = parseJson(stdout.trim(), operation);
    if (!parsed.ok) {
      return parsed;
    }
    if (Array.isArray(parsed.data)) {
      const events: CursorStreamEvent[] = [];
      for (const item of parsed.data) {
        const event = parseCursorStreamEvent(item, operation);
        if (!event.ok) {
          return event;
        }
        events.push(event.data);
      }
      return aggregateEvents(events, outputFormat, parsed.data);
    }

    const record = asRecord(parsed.data);
    if (record === null) {
      return parseFailure(operation, 'Cursor JSON output must be an object.');
    }
    if (rawEventType(record) !== null) {
      const event = parseCursorStreamEvent(record, operation);
      return event.ok
        ? aggregateEvents([event.data], outputFormat, parsed.data)
        : event;
    }
    const resultEvent = resultEventFromRecord(record, operation);
    return resultEvent.ok
      ? aggregateEvents([resultEvent.data], outputFormat, parsed.data)
      : resultEvent;
  }

  const events: CursorStreamEvent[] = [];
  const rawValues: unknown[] = [];
  for (const [index, line] of stdout.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const parsed = parseJson(trimmed, `${operation}.line${index + 1}`);
    if (!parsed.ok) {
      return parsed;
    }
    const event = parseCursorStreamEvent(parsed.data, operation);
    if (!event.ok) {
      return event;
    }
    events.push(event.data);
    rawValues.push(parsed.data);
  }

  if (events.length === 0) {
    return parseFailure(operation, 'Cursor stream output did not contain events.');
  }
  return aggregateEvents(events, outputFormat, rawValues);
}

/** Extracts a semantic Cursor CLI version from version command output. */
export function parseCursorVersion(
  stdout: string,
  operation = 'health.version',
): CursorResult<string> {
  const value = stdout.trim();
  const match = value.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u);
  if (match?.[1] !== undefined) {
    return success(match[1]);
  }
  return value === ''
    ? parseFailure(operation, 'Cursor CLI returned an empty version.')
    : parseFailure(operation, `Could not detect a semantic version in: ${value}`);
}

function parseListJson(
  stdout: string,
  operation: string,
): CursorResult<readonly unknown[]> {
  const parsed = parseJson(stdout.trim(), operation);
  if (!parsed.ok) {
    return parsed;
  }
  if (Array.isArray(parsed.data)) {
    return success(parsed.data);
  }
  const record = asRecord(parsed.data);
  if (record === null) {
    return parseFailure(operation, 'Cursor list output must be an array or object.');
  }
  for (const key of ['models', 'servers', 'mcpServers', 'data', 'items']) {
    const values = asArray(record[key]);
    if (values !== null) {
      return success(values);
    }
  }
  return parseFailure(operation, 'Cursor list output did not contain entries.');
}

/**
 * Parses model-list output from JSON or common line-oriented CLI text.
 */
export function parseCursorModels(
  stdout: string,
  operation = 'models.list',
): CursorResult<readonly CursorModelSummary[]> {
  const value = stdout.trim();
  if (value.startsWith('{') || value.startsWith('[')) {
    const parsed = parseListJson(value, operation);
    if (!parsed.ok) {
      return parsed;
    }
    const models = parsed.data.flatMap((item) => {
      const record = asRecord(item);
      if (record === null) {
        const id = stringValue(item);
        return id === null ? [] : [{ id, name: null, raw: item }];
      }
      const id = firstString(record, ['id', 'model', 'name']);
      return id === null
        ? []
        : [
            {
              id,
              name: firstString(record, ['name', 'display_name', 'displayName']),
              raw: item,
            },
          ];
    });
    return models.length === 0
      ? parseFailure(operation, 'Cursor CLI returned no model entries.')
      : success(models);
  }

  const models = value
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^[-*•]\s*/u, ''))
    .filter(
      (line) =>
        line !== '' &&
        !/^available models:?$/iu.test(line) &&
        !/^models:?$/iu.test(line) &&
        !/^[-=]+$/u.test(line),
    )
    .map((id) => ({ id, name: null, raw: id }));
  return models.length === 0
    ? parseFailure(operation, 'Cursor CLI returned no model entries.')
    : success(models);
}

/**
 * Parses MCP-server list output from JSON or common line-oriented CLI text.
 */
export function parseCursorMcpServers(
  stdout: string,
  operation = 'mcp.list',
): CursorResult<readonly CursorMcpServer[]> {
  const value = stdout.trim();
  if (value.startsWith('{') || value.startsWith('[')) {
    const parsed = parseListJson(value, operation);
    if (!parsed.ok) {
      return parsed;
    }
    const servers = parsed.data.flatMap((item) => {
      const record = asRecord(item);
      if (record === null) {
        const name = stringValue(item);
        return name === null ? [] : [{ name, status: null, raw: item }];
      }
      const name = firstString(record, ['name', 'server', 'id']);
      return name === null
        ? []
        : [
            {
              name,
              status: firstString(record, ['status', 'state']),
              raw: item,
            },
          ];
    });
    return servers.length === 0
      ? parseFailure(operation, 'Cursor CLI returned no MCP server entries.')
      : success(servers);
  }

  const servers = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        !/^mcp servers?:?$/iu.test(line) &&
        !/^name\s+(status|state)$/iu.test(line) &&
        !/^[-=]+$/u.test(line),
    )
    .map((line) => {
      const [name, ...status] = line.split(/\s+/u);
      return { name, status: status.join(' ') || null, raw: line };
    });
  return servers.length === 0
    ? parseFailure(operation, 'Cursor CLI returned no MCP server entries.')
    : success(servers);
}

/**
 * Selects the exact model value passed to the Cursor CLI.
 *
 * String selections pass through unchanged; object selections prefer their
 * explicit variant and otherwise use the model identifier.
 */
export function formatCursorModel(model: CursorModel): string {
  return typeof model === 'string' ? model : (model.variant ?? model.id);
}

function capabilityLines(
  label: string,
  values: readonly string[] | undefined,
): readonly string[] {
  return values === undefined || values.length === 0
    ? []
    : [`- ${label}: ${values.map((value) => `\`${value}\``).join(', ')}`];
}

/**
 * Adds an auditable context hint to the prompt. It does not install, enable,
 * authenticate, or otherwise bypass Cursor capability controls.
 */
export function buildCapabilityPrompt(
  prompt: string,
  capabilities: CursorCapabilitySelection | undefined,
): string {
  if (capabilities === undefined) {
    return prompt;
  }

  const lines = [
    ...capabilityLines('Skills', capabilities.skills),
    ...capabilityLines('Plugins', capabilities.plugins),
    ...capabilityLines('MCP servers', capabilities.mcpServers),
    ...capabilityLines('Subagents', capabilities.subagents),
    ...capabilityLines('Rules', capabilities.rules),
    ...capabilityLines('Files', capabilities.files),
  ];
  return lines.length === 0
    ? prompt
    : `${prompt}\n\n[Cursor context selection]\n${lines.join('\n')}`;
}
