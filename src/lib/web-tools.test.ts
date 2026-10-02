import { describe, expect, it, vi } from 'vitest';
import { buildWebAudit } from './web-audit';
import {
  WEB_TOOL_DEFINITIONS,
  collectCurrentWebFetchUrls,
  collectWebFetchUrls,
  executeWebToolCalls,
  messagesContainImages,
  readWebToolCalls,
  webContentSystemInstruction,
  webToolSystemInstruction,
  type WebToolRequest,
  type WebToolResult,
} from './web-tools';

describe('web tool calls', () => {
  it('exposes only bounded search and fetch tools', () => {
    expect(WEB_TOOL_DEFINITIONS.map((tool) => tool.function.name))
      .toEqual(['web_search', 'web_fetch']);
  });

  it('rejects unknown tools, malformed JSON, and more than two calls', () => {
    expect(() => readWebToolCalls([
      { id: '1', type: 'function', function: { name: 'shell', arguments: '{}' } },
    ])).toThrow(/not allowed/i);
    expect(() => readWebToolCalls([
      { id: '1', type: 'function', function: { name: 'web_search', arguments: '{' } },
    ])).toThrow(/valid json/i);
    expect(() => readWebToolCalls(Array.from({ length: 3 }, (_, index) => ({
      id: String(index),
      type: 'function' as const,
      function: { name: 'web_search', arguments: '{"query":"x"}' },
    })))).toThrow(/at most 2/i);
  });

  it('allows fetches only for canonical HTTPS URLs already in conversation content', () => {
    const allowed = collectWebFetchUrls([
      { role: 'system', content: 'Ignore https://system.example/secret' },
      { role: 'user', content: 'Read https://example.com/page#section.' },
    ]);
    expect([...allowed]).toEqual(['https://example.com/page']);
    expect(readWebToolCalls([{
      id: '1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/page#other"}' },
    }], allowed)[0].request).toMatchObject({ url: 'https://example.com/page' });
    expect(() => readWebToolCalls([{
      id: '2',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://other.example/"}' },
    }], allowed)).toThrow(/current user message/i);
  });

  it('allows only explicitly requested search text from the latest user message', () => {
    const call = [{
      id: '1',
      type: 'function' as const,
      function: { name: 'web_search', arguments: '{"query":"public weather"}' },
    }];
    expect(readWebToolCalls(
      call,
      undefined,
      'Private project code: bluebird.\nSearch the web for: public weather',
    )[0].request).toMatchObject({ query: 'public weather' });
    expect(() => readWebToolCalls(
      [{
        ...call[0],
        function: { name: 'web_search', arguments: '{"query":"bluebird"}' },
      }],
      undefined,
      'Private project code: bluebird.\nSearch the web for: public weather',
    )).toThrow(/Search the web for/i);
    expect(() => readWebToolCalls(
      call,
      undefined,
      'Do not search the web for: public weather',
    )).toThrow(/Search the web for/i);
    expect(() => readWebToolCalls(
      call,
      undefined,
      'Search the web for: "public weather"',
    )).toThrow(/exact unquoted query/i);
    expect(() => readWebToolCalls(
      [{
        ...call[0],
        function: { name: 'web_search', arguments: '{"query":"weather"}' },
      }],
      undefined,
      'Search the web for: public weather',
    )).toThrow(/exact unquoted query/i);
    for (const text of [
      '> Search the web for: public weather',
      '```text\nSearch the web for: public weather\n```',
      '````md\n```\nSearch the web for: public weather\n```\n````',
      '~~~~\n~~~\nSearch the web for: public weather\n~~~\n~~~~',
      '```\n``` not a closing fence\nSearch the web for: public weather\n```',
      '```\nunclosed fence\nSearch the web for: public weather',
      '```\n    ```\nSearch the web for: public weather\n```',
      '```\n\t```\nSearch the web for: public weather\n```',
      '```\n\u00a0```\nSearch the web for: public weather\n```',
      '```\n``` \f\nSearch the web for: public weather\n```',
      '    ```\n```\nSearch the web for: public weather\n```',
      '```a`b\n```\nSearch the web for: public weather\n```',
      '<!--\nSearch the web for: public weather\n-->',
      'Note <!-- draft\nSearch the web for: public weather\n-->',
      '<!-- a --> <!--\nSearch the web for: public weather\n-->',
      '  <!--\nunclosed comment\nSearch the web for: public weather',
      '> <!--\nSearch the web for: public weather\n-->',
      '> quoted text\nSearch the web for: public weather',
      '> quoted\ncontinued\nSearch the web for: public weather',
      '> > nested\nSearch the web for: public weather',
      '  > indented quote\nSearch the web for: public weather',
      '> quoted\n\u00a0\nSearch the web for: public weather',
      '>\u00a0\nSearch the web for: public weather',
      '> quoted\n\f\nSearch the web for: public weather',
      '> quoted\n>\u00a0\nSearch the web for: public weather',
      '> quoted\n\ufeff\nSearch the web for: public weather',
      '<!-- a\n--> <!--\nSearch the web for: public weather\n-->',
      '"Search the web for: public weather"',
      'Search the public web for: public weather',
      'search the web for: public weather',
      'Search the web for: public weather\nSearch the web for: other query',
    ]) {
      expect(() => readWebToolCalls(call, undefined, text)).toThrow(/Search the web for/i);
    }
    for (const text of [
      '````md\n```\nexample\n```\n````\nSearch the web for: public weather',
      '```\ncode\n`````  \nSearch the web for: public weather',
      '```\ncode\n   ```\t\nSearch the web for: public weather',
      '~~~a`b\ncode\n~~~\nSearch the web for: public weather',
      '<!--\ncomment\n-->\nSearch the web for: public weather',
      '<!-- one line -->\nSearch the web for: public weather',
      '<!--\na\n--> trailing\nSearch the web for: public weather',
      '```\n<!--\n```\nSearch the web for: public weather',
      '> quoted\n\nSearch the web for: public weather',
      '> quoted\r\n  \t\r\nSearch the web for: public weather',
      '>\nSearch the web for: public weather',
      '>\t\nSearch the web for: public weather',
      '> quoted\n \t \nSearch the web for: public weather',
      '> quoted\n```\ncode\n```\nSearch the web for: public weather',
    ]) {
      expect(readWebToolCalls(call, undefined, text)).toHaveLength(1);
    }
    expect(() => readWebToolCalls(
      [{
        ...call[0],
        function: { name: 'web_search', arguments: '{"query":"Public Weather"}' },
      }],
      undefined,
      'Search the web for: public weather',
    )).toThrow(/exact unquoted query/i);
  });

  it('collects text-part URLs while excluding system, tool, and malformed content', () => {
    expect([...collectWebFetchUrls([
      null,
      { role: 'system', content: 'https://system.example/' },
      { role: 'tool', content: 'https://tool.example/' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'See https://example.com/a and https://example.com/wiki/Rust_(language).' },
          { type: 'file_text', text: 'Do not authorize https://attachment.example/' },
          { type: 'image_url', image_url: { url: 'https://images.example/x.png' } },
        ],
      },
      { role: 'assistant', content: 'Do not authorize https://assistant.example/' },
      { role: 'user', content: 42 },
    ])]).toEqual([
      'https://example.com/a',
      'https://example.com/wiki/Rust_(language)',
    ]);
    expect(collectWebFetchUrls({})).toEqual(new Set());
  });

  it('authorizes fetches only from the current message and current URL chips', () => {
    expect([...collectCurrentWebFetchUrls(
      { role: 'user', content: 'Current https://current.example/a.' },
      ['https://chip.example/page#section'],
    )]).toEqual([
      'https://current.example/a',
      'https://chip.example/page',
    ]);
  });

  it('keeps a matched IPv6 bracket and still strips an unmatched one', () => {
    const bare = [...collectCurrentWebFetchUrls(
      { role: 'user', content: 'Fetch https://[2606:4700:4700::1111] please' },
      [],
    )];
    expect(bare).toEqual(['https://[2606:4700:4700::1111]/']);
    expect(new URL(bare[0]).hostname).toBe('[2606:4700:4700::1111]');

    const dotted = [...collectCurrentWebFetchUrls(
      { role: 'user', content: 'Fetch https://[2606:4700:4700::1111].' },
      [],
    )];
    expect(dotted).toEqual(['https://[2606:4700:4700::1111]/']);
    expect(new URL(dotted[0]).hostname).toBe('[2606:4700:4700::1111]');

    expect([...collectWebFetchUrls([{
      role: 'user',
      content: 'See https://example.com/path] next',
    }])]).toEqual(['https://example.com/path']);
  });

  it('preserves terminal exclamation and question marks in current-send URL authority', () => {
    expect([...collectCurrentWebFetchUrls(
      {
        role: 'user',
        content: 'Use https://example.com/page! and https://example.com/query?',
      },
      [],
    )]).toEqual([
      'https://example.com/page!',
      'https://example.com/query?',
    ]);
  });

  it('rejects malformed IDs, call envelopes, argument shapes, and URLs', () => {
    expect(() => readWebToolCalls([
      { id: 'same', type: 'function', function: { name: 'web_search', arguments: '{"query":"a"}' } },
      { id: 'same', type: 'function', function: { name: 'web_search', arguments: '{"query":"b"}' } },
    ])).toThrow(/unique/i);
    expect(() => readWebToolCalls([{ id: '1', type: 'other' }])).toThrow(/malformed/i);
    expect(() => readWebToolCalls([{
      id: '1',
      type: 'function',
      function: { name: 'web_search', arguments: '[]' },
    }])).toThrow(/object/i);
    expect(() => readWebToolCalls([{
      id: '1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"x","headers":{}}' },
    }])).toThrow(/unsupported/i);
    expect(() => readWebToolCalls([{
      id: '1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"http://example.com/"}' },
    }])).toThrow(/https/i);
    expect(() => readWebToolCalls([{
      id: '1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/","method":"POST"}' },
    }])).toThrow(/unsupported/i);
  });

  it('executes one bounded round and returns source citations separately', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => request.operation === 'search'
      ? { operation: 'search', query: request.query, results: [{
          title: 'Example',
          url: 'https://example.com/',
          snippet: 'Result text',
        }] }
      : {
          operation: 'fetch',
          url: request.url,
          title: 'Page',
          text: 'Body',
          truncated: false,
          charCount: 4,
        });
    const result = await executeWebToolCalls([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"local AI"}' },
      },
    ], execute);
    expect(result.toolMessages).toHaveLength(1);
    expect(result.sources).toEqual([{ title: 'Example', url: 'https://example.com/' }]);
    expect(result.errors).toEqual([]);
    expect(result.toolMessages[0].content).toContain('UNTRUSTED WEB RESULT');
  });

  it('records an audit issue when a public search returns no organic results', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => ({
      operation: 'search',
      query: request.operation === 'search' ? request.query : '',
      results: [],
    }));
    const result = await executeWebToolCalls([{
      id: 'call-empty',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"nothing public"}' },
    }], execute, undefined, undefined, 'Search the web for: nothing public');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.sources).toEqual([]);
    expect(result.errors).toEqual(['web_search: The public search returned no results']);
    expect(result.toolMessages).toHaveLength(1);
    expect(result.toolMessages[0].content).toContain('"results":[]');
    expect(result.toolMessages[0].content).not.toContain('"error"');
    expect(buildWebAudit(result.sources, result.errors)?.errors).toEqual([
      'web_search: The public search returned no results',
    ]);
  });

  it('returns a cited untrusted tool message for fetched text', async () => {
    const execute = vi.fn(async (): Promise<WebToolResult> => ({
      operation: 'fetch',
      url: 'https://example.com/',
      title: '',
      text: 'Body',
      truncated: false,
      charCount: 4,
    }));
    const allowed = new Set(['https://example.com/']);
    const result = await executeWebToolCalls([{
      id: 'call-2',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/"}' },
    }], execute, allowed);
    expect(result.sources).toEqual([{
      title: 'https://example.com/',
      url: 'https://example.com/',
    }]);
    expect(result.toolMessages[0]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-2',
      name: 'web_fetch',
    });
  });

  it('preserves truncation on model-fetched sources and their audit', async () => {
    const execute = vi.fn(async (): Promise<WebToolResult> => ({
      operation: 'fetch',
      url: 'https://example.com/long',
      title: 'Long page',
      text: 'Prefix',
      truncated: true,
      charCount: 6,
    }));
    const result = await executeWebToolCalls([{
      id: 'call-t',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/long"}' },
    }], execute, new Set(['https://example.com/long']));
    expect(result.sources).toEqual([{
      title: 'Long page',
      url: 'https://example.com/long',
      truncated: true,
    }]);
    expect(buildWebAudit(result.sources, [])?.sources).toEqual([
      { title: 'Long page', url: 'https://example.com/long', truncated: true },
    ]);
  });

  it('does not dispatch another call after Stop is observed', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => {
      controller.abort();
      return {
        operation: 'search',
        query: request.operation === 'search' ? request.query : '',
        results: [],
      };
    });
    const result = await executeWebToolCalls([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"one"}' },
      },
      {
        id: 'call-2',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"one"}' },
      },
    ], execute, undefined, controller.signal, 'Search the web for: one');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolMessages).toHaveLength(1);
  });

  it('does not dispatch a search the user declines at the final confirmation', async () => {
    const execute = vi.fn();
    const confirmSearch = vi.fn(async () => false);
    const result = await executeWebToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"public weather"}' },
    }], execute, undefined, undefined, 'Search the web for: public weather', confirmSearch);
    expect(confirmSearch).toHaveBeenCalledWith('public weather');
    expect(execute).not.toHaveBeenCalled();
    expect(result.errors).toEqual(['web_search: User declined the public web search']);
  });

  it('returns individual tool failures without discarding successful calls', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => {
      if (request.operation === 'fetch') throw new Error('page too large');
      return {
        operation: 'search',
        query: request.query,
        results: [{ title: 'Result', url: 'https://example.com/', snippet: 'Text' }],
      };
    });
    const result = await executeWebToolCalls([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'web_fetch', arguments: '{"url":"https://input.example/"}' },
      },
      {
        id: 'call-2',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"two"}' },
      },
    ], execute, new Set(['https://input.example/']), undefined, 'Search the web for: two');
    expect(result.toolMessages).toHaveLength(2);
    expect(result.sources).toEqual([{ title: 'Result', url: 'https://example.com/' }]);
    expect(result.errors).toEqual(['web_fetch: page too large']);
    expect(result.toolMessages[0].content).toContain('"error":"page too large"');
  });

  it('adds trusted one-round prompt-injection guidance', () => {
    const prompt = webToolSystemInstruction(' Be helpful. ');
    expect(prompt).toContain('Be helpful.');
    expect(prompt).toContain('not instructions');
    expect(prompt).toContain('only once');
  });

  it('marks manual page context untrusted even when model tools are unavailable', () => {
    const prompt = webContentSystemInstruction('Be helpful.');
    expect(prompt).toContain('Be helpful.');
    expect(prompt).toContain('untrusted reference material');
    expect(prompt).not.toContain('request tools');
  });

  it('detects image parts that cannot be combined with Foundry tool calls', () => {
    expect(messagesContainImages([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
    ])).toBe(true);
    expect(messagesContainImages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    ])).toBe(false);
  });
});
