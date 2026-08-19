import { describe, expect, it } from 'vitest';
import {
  CursorCliClient,
  type CursorResult,
  type CursorStreamEvent,
} from '../../src/index.js';

const E2E_TOKEN = 'SIMPLE_CURSOR_CLI_E2E_OK';
const READ_ONLY_PROMPT = `Reply with the exact token ${E2E_TOKEN}. Do not read, write, or execute anything.`;
const configuredExecutable = process.env.CURSOR_E2E_EXECUTABLE?.trim() || undefined;
const configuredModel = process.env.CURSOR_E2E_MODEL?.trim() || undefined;

function readTimeoutMs(): number {
  const configuredTimeout = process.env.CURSOR_E2E_TIMEOUT_MS;
  if (configuredTimeout === undefined) {
    return 120_000;
  }

  const timeoutMs = Number(configuredTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('CURSOR_E2E_TIMEOUT_MS must be a positive integer.');
  }
  return timeoutMs;
}

function unwrap<T>(result: CursorResult<T>, operation: string): T {
  if (!result.ok) {
    throw new Error(
      `${operation} failed with ${result.error.category}: ${result.error.message}`,
    );
  }
  return result.data;
}

const client = new CursorCliClient({
  executable: configuredExecutable ?? 'agent',
  timeoutMs: readTimeoutMs(),
});

const input = {
  prompt: READ_ONLY_PROMPT,
  extraArgs: ['--trust'],
  ...(configuredModel === undefined ? {} : { model: configuredModel }),
};

describe('Cursor CLI end-to-end', () => {
  it('runs the authenticated read-only Cursor CLI flow', async () => {
    const health = unwrap(await client.health(), 'health');
    expect(health.cli.available).toBe(true);
    expect(health.cli.version).not.toBe('');
    expect(health.authentication.status).toBe('authenticated');
    expect(health.canRun).toBe(true);

    const result = unwrap(await client.ask({ ...input, outputFormat: 'json' }), 'ask');

    expect(result.outputFormat).toBe('json');
    expect(result.text.trim()).not.toBe('');
    expect(result.text).toContain(E2E_TOKEN);
    expect(result.sessionId).not.toBeNull();
    const events: CursorStreamEvent[] = [];
    for await (const event of client.stream(input)) {
      events.push(event);
    }

    const resultEvents = events.filter(
      (event): event is Extract<CursorStreamEvent, { type: 'result' }> =>
        event.type === 'result',
    );
    const finalEvent = resultEvents[resultEvents.length - 1];
    if (finalEvent === undefined) {
      throw new Error('Cursor CLI stream did not emit a result event.');
    }

    expect(finalEvent.text.trim()).not.toBe('');
    expect(finalEvent.text).toContain(E2E_TOKEN);
  });
});
