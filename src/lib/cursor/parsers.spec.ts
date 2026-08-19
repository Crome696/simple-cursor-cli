import { describe, expect, it } from 'vitest';
import {
  parseCursorMcpServers,
  parseCursorModels,
  parseCursorOutput,
  parseCursorStreamEvent,
  parseCursorVersion,
} from '../../index.js';

describe('Cursor output parsers', () => {
  it('parses text output without a live Cursor account', () => {
    expect(parseCursorOutput('  hello Cursor  \n', 'text')).toMatchObject({
      ok: true,
      data: { text: 'hello Cursor', outputFormat: 'text', events: [] },
    });
  });

  it('parses JSON and stream-JSON result events', () => {
    const json = parseCursorOutput(
      JSON.stringify({ type: 'result', result: 'json result' }),
      'json',
    );
    const stream = parseCursorOutput(
      '\n{"type":"assistant","text":"hello "}\n{"type":"result","result":"world"}\n',
      'stream-json',
    );

    expect(json).toMatchObject({ ok: true, data: { text: 'json result' } });
    expect(stream).toMatchObject({
      ok: true,
      data: { text: 'world', events: [{ type: 'assistant' }, { type: 'result' }] },
    });
  });

  it('parses the documented nested assistant and result event shapes', () => {
    const system = parseCursorStreamEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      model: 'sonnet',
    });
    const assistant = parseCursorStreamEvent({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'Cursor' },
        ],
      },
      session_id: 'session-1',
    });
    const result = parseCursorOutput(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        session_id: 'session-1',
        request_id: 'request-1',
        duration_ms: 42,
        duration_api_ms: 39,
      }),
      'json',
    );

    expect(system).toMatchObject({
      ok: true,
      data: {
        type: 'system',
        subtype: 'init',
        sessionId: 'session-1',
        model: 'sonnet',
      },
    });
    expect(assistant).toMatchObject({
      ok: true,
      data: {
        type: 'assistant',
        text: 'hello Cursor',
        sessionId: 'session-1',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        text: 'done',
        sessionId: 'session-1',
        requestId: 'request-1',
        durationMs: 42,
        durationApiMs: 39,
      },
    });
  });

  it('aggregates documented NDJSON events through the terminal result', () => {
    const stream = parseCursorOutput(
      [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 'session-2',
          model: 'sonnet',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial response' }],
          },
          session_id: 'session-2',
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'complete response',
          session_id: 'session-2',
          request_id: 'request-2',
          duration_ms: 17,
          duration_api_ms: 13,
        }),
      ].join('\n'),
      'stream-json',
    );

    expect(stream).toMatchObject({
      ok: true,
      data: {
        text: 'complete response',
        sessionId: 'session-2',
        requestId: 'request-2',
        model: 'sonnet',
        durationMs: 17,
        durationApiMs: 13,
        events: [
          { type: 'system' },
          { type: 'assistant', text: 'partial response' },
          { type: 'result', text: 'complete response' },
        ],
      },
    });
  });

  it('keeps unknown event fields in raw', () => {
    const result = parseCursorStreamEvent({
      type: 'new_cursor_event',
      future: { value: 1 },
    });

    expect(result).toEqual({
      ok: true,
      data: {
        type: 'new_cursor_event',
        raw: { type: 'new_cursor_event', future: { value: 1 } },
      },
    });
  });

  it('reports malformed and empty stream output as parse failures', () => {
    expect(parseCursorOutput('{bad}', 'stream-json')).toMatchObject({
      ok: false,
      error: { category: 'parse' },
    });
    expect(parseCursorOutput('\n\n', 'stream-json')).toMatchObject({
      ok: false,
      error: { category: 'parse' },
    });
  });

  it('normalizes version, model and MCP list fixtures', () => {
    expect(parseCursorVersion('Cursor Agent v0.9.1\n')).toEqual({
      ok: true,
      data: '0.9.1',
    });
    expect(parseCursorModels('Available models:\n- gpt-5\n- sonnet\n')).toEqual({
      ok: true,
      data: [
        { id: 'gpt-5', name: null, raw: 'gpt-5' },
        { id: 'sonnet', name: null, raw: 'sonnet' },
      ],
    });
    expect(parseCursorMcpServers('MCP servers:\nfilesystem connected\n')).toEqual({
      ok: true,
      data: [{ name: 'filesystem', status: 'connected', raw: 'filesystem connected' }],
    });
  });
});
