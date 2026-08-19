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
