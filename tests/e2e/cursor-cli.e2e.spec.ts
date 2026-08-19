import { beforeAll, describe, expect, it } from 'vitest';
import {
  CursorCliClient,
  type CursorHealth,
  type CursorResult,
  type CursorStreamEvent,
} from '../../src/index.js';

if (process.env.CURSOR_E2E !== '1') {
  throw new Error(
    'Cursor CLI E2E tests are opt-in. Set CURSOR_E2E=1 before running npm run test:e2e.',
  );
}

const E2E_TOKEN = 'SIMPLE_CURSOR_CLI_E2E_OK';
const READ_ONLY_PROMPT = `Reply with the exact token ${E2E_TOKEN}. Do not read, write, or execute anything.`;
const configuredExecutable = process.env.CURSOR_E2E_EXECUTABLE?.trim();
const configuredModel = process.env.CURSOR_E2E_MODEL?.trim();

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
  executable: configuredExecutable || 'agent',
  timeoutMs: readTimeoutMs(),
});

const input = {
  prompt: READ_ONLY_PROMPT,
  ...(configuredModel === undefined ? {} : { model: configuredModel }),
};

describe('Cursor CLI end-to-end', () => {
  let health!: CursorHealth;
  let healthError: Error | undefined;

  beforeAll(async () => {
    const result = await client.health();
    if (!result.ok) {
      healthError = new Error(
        `health failed with ${result.error.category}: ${result.error.message}`,
      );
      return;
    }
    health = result.data;

    if (health.authentication.status !== 'authenticated' || health.canRun !== true) {
      healthError = new Error(
        'Cursor CLI authentication is unavailable. Run the normal agent login flow before the E2E suite.',
      );
    }
  });

  function requireAuthenticatedHealth(): CursorHealth {
    if (healthError !== undefined) {
      throw healthError;
    }
    return health;
  }

  it('detects an installed and authenticated Cursor CLI', () => {
    const verifiedHealth = requireAuthenticatedHealth();
    expect(verifiedHealth.cli.available).toBe(true);
    expect(verifiedHealth.cli.version).not.toBe('');
    expect(verifiedHealth.authentication.status).toBe('authenticated');
    expect(verifiedHealth.canRun).toBe(true);
  });

  it('runs a read-only Ask request with JSON output', async () => {
    requireAuthenticatedHealth();
    const result = unwrap(await client.ask({ ...input, outputFormat: 'json' }), 'ask');

    expect(result.outputFormat).toBe('json');
    expect(result.text.trim()).not.toBe('');
    expect(result.text).toContain(E2E_TOKEN);
    expect(result.sessionId).not.toBeNull();
  });

  it('streams a read-only Ask request through a terminal result event', async () => {
    requireAuthenticatedHealth();
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
