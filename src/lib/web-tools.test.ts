import { describe, expect, it, vi } from 'vitest';
import { buildWebAudit } from './web-audit';
import {
  WEB_TOOL_DEFINITIONS,
  collectCurrentWebFetchUrls,
  collectWebFetchUrls,
  composerSearchQuery,
  executeWebToolCalls,
  messagesContainImages,
  readWebToolCalls,
  userSearchContext,
  webContentSystemInstruction,
  webToolSystemInstruction,
  type WebToolRequest,
  type WebToolResult,
} from './web-tools';

describe('web tool calls', () => {
  it('exposes only a bounded fetch tool to the model', () => {
    expect(WEB_TOOL_DEFINITIONS.map((tool) => tool.function.name))
      .toEqual(['web_fetch']);
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

  it('uses the typed draft as the search query and refuses a model-started search', () => {
    expect(composerSearchQuery('  public\nweather \t')).toEqual({ ok: true, query: 'public weather' });
    expect(composerSearchQuery('   ')).toEqual({
      ok: false,
      error: 'Type a search query, then press Search.',
    });
    expect(composerSearchQuery('x'.repeat(501)).ok).toBe(false);
    expect(() => readWebToolCalls([{
      id: '1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"public weather"}' },
    }])).toThrow(/cannot start a web search/i);
    const packed = userSearchContext({
      operation: 'search',
      query: 'public weather',
      results: [{ title: 'Forecast', url: 'https://example.com/', snippet: 'Rain' }],
    });
    expect(packed.context).toContain('UNTRUSTED WEB RESULT');
    expect(packed.context).toContain('Search query: public weather');
    expect(packed.context).toContain('https://example.com/');
    expect(packed.sources).toEqual([{ title: 'Forecast', url: 'https://example.com/' }]);
    expect(packed.errors).toEqual([]);
    const empty = userSearchContext({
      operation: 'search',
      query: 'nothing public',
      results: [],
    });
    expect(empty.sources).toEqual([]);
    expect(empty.errors).toEqual(['web_search: The public search returned no results']);
    expect(buildWebAudit(empty.sources, empty.errors)?.errors).toEqual(empty.errors);
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
      { id: 'same', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://example.com/a"}' } },
      { id: 'same', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://example.com/b"}' } },
    ])).toThrow(/unique/i);
    expect(() => readWebToolCalls([{ id: '1', type: 'other' }])).toThrow(/malformed/i);
    expect(() => readWebToolCalls([{
      id: '1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '[]' },
    }])).toThrow(/object/i);
    expect(() => readWebToolCalls([{
      id: '1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"x","headers":{}}' },
    }])).toThrow(/cannot start a web search/i);
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

  it('executes one bounded fetch round and returns source citations separately', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => ({
      operation: 'fetch',
      url: request.operation === 'fetch' ? request.url : '',
      title: 'Page',
      text: 'Body',
      truncated: false,
      charCount: 4,
    }));
    const result = await executeWebToolCalls([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'web_fetch', arguments: '{"url":"https://example.com/"}' },
      },
    ], execute, new Set(['https://example.com/']));
    expect(result.toolMessages).toHaveLength(1);
    expect(result.sources).toEqual([{ title: 'Page', url: 'https://example.com/' }]);
    expect(result.errors).toEqual([]);
    expect(result.toolMessages[0].content).toContain('UNTRUSTED WEB RESULT');
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
        operation: 'fetch',
        url: request.operation === 'fetch' ? request.url : '',
        title: 'Page',
        text: 'Body',
        truncated: false,
        charCount: 4,
      };
    });
    const allowed = new Set(['https://one.example/', 'https://two.example/']);
    const result = await executeWebToolCalls([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'web_fetch', arguments: '{"url":"https://one.example/"}' },
      },
      {
        id: 'call-2',
        type: 'function',
        function: { name: 'web_fetch', arguments: '{"url":"https://two.example/"}' },
      },
    ], execute, allowed, controller.signal);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolMessages).toHaveLength(1);
  });

  it('does not fetch a site the user declines', async () => {
    const execute = vi.fn();
    const authorizeFetch = vi.fn(async () => false);
    const result = await executeWebToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/"}' },
    }], execute, new Set(['https://example.com/']), undefined, authorizeFetch);
    expect(authorizeFetch).toHaveBeenCalledWith('https://example.com/');
    expect(execute).not.toHaveBeenCalled();
    expect(result.errors).toEqual(['web_fetch: User declined access to this site']);
  });

  it('returns individual tool failures without discarding successful calls', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => {
      if (request.operation === 'fetch' && request.url === 'https://input.example/') {
        throw new Error('page too large');
      }
      return {
        operation: 'fetch',
        url: request.operation === 'fetch' ? request.url : '',
        title: 'Result',
        text: 'Text',
        truncated: false,
        charCount: 4,
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
        function: { name: 'web_fetch', arguments: '{"url":"https://example.com/"}' },
      },
    ], execute, new Set(['https://input.example/', 'https://example.com/']));
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
    expect(prompt).toContain('current untrusted search results');
    expect(prompt).toContain('Search button');
    expect(prompt).not.toContain('Search the web for:');
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
