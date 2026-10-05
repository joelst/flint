import { describe, expect, it, vi } from 'vitest';
import { buildWebAudit } from './web-audit';
import { estimateTokens } from './token-estimate';
import {
  WEB_TOOL_DEFINITIONS,
  collectCurrentWebFetchUrls,
  collectWebFetchUrls,
  searchResultUrls,
  executeWebImage,
  executeWebToolCalls,
  messagesContainImages,
  modelCannotUseWebTools,
  readWebToolCalls,
  searchQueryPolicyError,
  searchScrubCorpus,
  userSearchContext,
  webContentSystemInstruction,
  webToolSchemaTokens,
  webToolSystemInstruction,
  webToolTemplateCrash,
  type WebToolRequest,
  type WebToolResult,
} from './web-tools';

function parsedRequest(calls: unknown): WebToolRequest {
  const parsed = readWebToolCalls(calls)[0];
  if (!parsed || !('request' in parsed)) throw new Error('expected a web tool request');
  return parsed.request;
}

function parsedError(calls: unknown): string {
  const parsed = readWebToolCalls(calls)[0];
  if (!parsed || !('error' in parsed)) throw new Error('expected a web tool error');
  return parsed.error;
}

describe('web tool calls', () => {
  it('exposes bounded search and fetch tools to the model', () => {
    expect(WEB_TOOL_DEFINITIONS.map((tool) => tool.function.name))
      .toEqual(['web_search', 'web_fetch']);
    expect(webToolSchemaTokens()).toBe(
      Math.ceil(estimateTokens(JSON.stringify(WEB_TOOL_DEFINITIONS)) * 1.15),
    );
    expect(webToolSchemaTokens()).toBeGreaterThan(0);
  });

  it('returns a per-call error for an unknown tool or malformed JSON, and rejects more than two calls', () => {
    expect(parsedError([
      { id: '1', type: 'function', function: { name: 'shell', arguments: '{}' } },
    ])).toMatch(/not allowed/i);
    expect(parsedError([
      { id: '1', type: 'function', function: { name: 'web_search', arguments: '{' } },
    ])).toMatch(/valid json/i);
    expect(parsedError([
      { id: 'img', type: 'function', function: { name: 'web_fetch', arguments: '{"operation":"image"}' } },
    ])).toMatch(/unsupported argument/i);
    expect(() => readWebToolCalls(Array.from({ length: 3 }, (_, index) => ({
      id: String(index),
      type: 'function' as const,
      function: { name: 'web_search', arguments: '{"query":"x"}' },
    })))).toThrow(/at most 2/i);
  });

  it('runs two fetches when a repeated name splits into exactly two argument objects', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => ({
      operation: 'fetch',
      url: request.operation === 'fetch' ? request.url : '',
      title: 'Page',
      text: 'Body',
      truncated: false,
      charCount: 4,
    }));
    const calls = [{
      id: 'glued',
      type: 'function' as const,
      function: {
        name: 'web_fetchweb_fetch',
        arguments: '{"url":"https://example.com/a"}{"url":"https://example.com/b"}',
      },
    }];
    const parsed = readWebToolCalls(calls);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((item) => (
      'request' in item && item.request.operation === 'fetch' ? item.request.url : ''
    ))).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    const braced = readWebToolCalls([{
      id: 'braced',
      type: 'function' as const,
      function: {
        name: 'web_fetchweb_fetch',
        arguments: '{"url":"https://example.com/a}b"}{"url":"https://example.com/c"}',
      },
    }]);
    expect(braced.map((item) => (
      'request' in item && item.request.operation === 'fetch' ? item.request.url : ''
    ))).toEqual([
      'https://example.com/a%7Db',
      'https://example.com/c',
    ]);
    const result = await executeWebToolCalls(
      calls,
      execute,
      new Set(['https://example.com/a', 'https://example.com/b']),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual([]);
    expect(result.toolCalls.map((call) => call.function.name)).toEqual(['web_fetch', 'web_fetch']);
    expect(result.toolCalls.map((call) => call.id)).toEqual(['glued:0', 'glued:1']);
    expect(result.toolMessages.map((message) => (
      message.role === 'tool' ? message.tool_call_id : ''
    ))).toEqual(['glued:0', 'glued:1']);
  });

  it('reports one web_fetch issue for a repeated name that does not fit in two calls, and still runs the search', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => ({
      operation: 'search',
      query: request.operation === 'search' ? request.query : '',
      results: [{ title: 'StatMuse', url: 'https://www.statmuse.com/nfl/ask/bears', snippet: 'Record' }],
    }));
    const calls = [
      {
        id: 'search-1',
        type: 'function' as const,
        function: { name: 'web_search', arguments: '{"query":"Chicago Bears NFC Championship record"}' },
      },
      {
        id: 'fetch-glued',
        type: 'function' as const,
        function: {
          name: 'web_fetchweb_fetchweb_fetchweb_fetchweb_fetch',
          arguments: '{',
        },
      },
    ];
    expect(() => readWebToolCalls(calls)).not.toThrow();
    const parsed = readWebToolCalls(calls);
    expect(parsed[0]).toMatchObject({ request: { operation: 'search', query: 'Chicago Bears NFC Championship record' } });
    expect(parsed[1]).toMatchObject({
      call: { function: { name: 'web_fetch' } },
    });
    expect('error' in parsed[1] ? parsed[1].error : '').toMatch(/included 5 web_fetch calls/i);
    expect('error' in parsed[1] ? parsed[1].error : '').toMatch(/at most 2/);
    const fiveObjects = Array.from({ length: 5 }, (_, index) => (
      `{"url":"https://example.com/${index}"}`
    )).join('');
    expect(() => readWebToolCalls([
      {
        id: 'search-2',
        type: 'function' as const,
        function: { name: 'web_search', arguments: '{"query":"bears"}' },
      },
      {
        id: 'fetch-five',
        type: 'function' as const,
        function: { name: 'web_fetch'.repeat(5), arguments: fiveObjects },
      },
    ])).not.toThrow();
    const result = await executeWebToolCalls(
      calls,
      execute,
      new Set(),
      undefined,
      undefined,
      async () => true,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.queries).toEqual(['Chicago Bears NFC Championship record']);
    expect(result.errors).toEqual([
      'web_fetch: This reply included 5 web_fetch calls in one response. A reply may request at most 2.',
    ]);
    expect(result.toolCalls.map((call) => call.id)).toEqual(['search-1', 'fetch-glued']);
    expect(result.toolCalls[1].function.name).toBe('web_fetch');
  });

  it('leaves web tools off for Gemma 4 and recognizes the upstream template crash', () => {
    expect(modelCannotUseWebTools('gemma-4-e2b-it-cuda-gpu:3')).toBe(true);
    expect(modelCannotUseWebTools('Gemma4-E2B')).toBe(true);
    expect(modelCannotUseWebTools('qwen3.5-9b')).toBe(false);
    expect(modelCannotUseWebTools('smollm3-3b')).toBe(false);
    expect(modelCannotUseWebTools('gemma-2-2b-it')).toBe(false);
    expect(webToolTemplateCrash(new Error("Trying to access property 'name' on null"))).toBe(true);
    expect(webToolTemplateCrash(new Error('format_function_declaration failed'))).toBe(true);
    expect(webToolTemplateCrash(new Error('The model stopped'))).toBe(false);
  });

  it('allows fetches only for canonical HTTPS URLs already in conversation content', async () => {
    const allowed = collectWebFetchUrls([
      { role: 'system', content: 'Ignore https://system.example/secret' },
      { role: 'user', content: 'Read https://example.com/page#section.' },
    ]);
    expect([...allowed]).toEqual(['https://example.com/page']);
    expect(parsedRequest([{
      id: '1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/page#other"}' },
    }])).toMatchObject({ url: 'https://example.com/page' });
    const execute = vi.fn();
    const refused = await executeWebToolCalls([{
      id: '2',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://other.example/"}' },
    }], execute, allowed);
    expect(execute).not.toHaveBeenCalled();
    expect(refused.errors[0]).toMatch(/current user message/i);
  });

  it('accepts a short model search query and rejects anything else', () => {
    expect(parsedRequest([{
      id: '1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"  public\\nweather \\t"}' },
    }])).toEqual({ operation: 'search', query: 'public weather', maxResults: 5 });
    expect(parsedError([{
      id: 'blank',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"   "}' },
    }])).toMatch(/1-200/);
    expect(parsedError([{
      id: 'long',
      type: 'function',
      function: { name: 'web_search', arguments: JSON.stringify({ query: 'x'.repeat(201) }) },
    }])).toMatch(/1-200/);
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

  it('keeps helper search URLs that legitimately end in punctuation', () => {
    expect([...searchResultUrls([
      { url: 'https://example.com/file.' },
      { url: 'https://example.com/a,' },
      { url: 'https://example.com/b;' },
      { url: 'https://example.com/c:' },
      { url: 'https://example.com/d%7D' },
      { url: 'https://example.com/d}' },
      { url: 'https://example.com/page!' },
      { url: 'https://example.com/file.#section' },
      { url: 'http://example.com/file.' },
      { url: '' },
    ])]).toEqual([
      'https://example.com/file.',
      'https://example.com/a,',
      'https://example.com/b;',
      'https://example.com/c:',
      'https://example.com/d%7D',
      'https://example.com/page!',
    ]);
    expect([...collectWebFetchUrls([{
      role: 'user',
      content: [
        'https://example.com/file.',
        'https://example.com/a,',
        'https://example.com/b;',
        'https://example.com/c:',
        'https://example.com/d}',
      ].join('\n'),
    }])]).toEqual([
      'https://example.com/file',
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
    ]);
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
    expect(parsedError([{ id: '1', type: 'other' }])).toMatch(/malformed/i);
    expect(parsedError([{
      id: '1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '[]' },
    }])).toMatch(/object/i);
    expect(parsedError([{
      id: '1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"x","headers":{}}' },
    }])).toMatch(/unsupported argument/i);
    expect(parsedError([{
      id: '1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"http://example.com/"}' },
    }])).toMatch(/https/i);
    expect(parsedError([{
      id: '1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/","method":"POST"}' },
    }])).toMatch(/unsupported/i);
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
    expect(result.toolMessages[0].content).toContain('Reference data retrieved by Flint');
    expect(result.toolMessages[0].content).toContain('flint-ref-');
    expect(result.toolMessages[0].content).not.toContain('UNTRUSTED WEB RESULT');
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

  it('fetches a cross-origin redirect only after the next host is approved', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => {
      if (request.operation === 'fetch' && request.url === 'https://example.com/') {
        return { operation: 'redirect', url: 'https://other.example/next' };
      }
      return {
        operation: 'fetch',
        url: 'https://other.example/next',
        title: 'Other',
        text: 'Body',
        truncated: false,
        charCount: 4,
      };
    });
    const authorizeFetch = vi.fn(async () => true);
    const result = await executeWebToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/"}' },
    }], execute, new Set(['https://example.com/']), undefined, authorizeFetch);
    expect(authorizeFetch).toHaveBeenNthCalledWith(1, 'https://example.com/', 'request');
    expect(authorizeFetch).toHaveBeenNthCalledWith(2, 'https://other.example/next', 'redirect');
    expect(execute).toHaveBeenNthCalledWith(2, {
      operation: 'fetch',
      url: 'https://other.example/next',
      maxChars: 20_000,
    });
    expect(result.sources).toEqual([{ title: 'Other', url: 'https://other.example/next' }]);
    expect(result.errors).toEqual([]);
    expect(result.toolMessages[0].content).toContain('Reference data retrieved by Flint');
    expect(result.toolMessages[0].content).toContain('flint-ref-');
  });

  it('does not request a redirect host the user declines', async () => {
    const execute = vi.fn(async (): Promise<WebToolResult> => ({
      operation: 'redirect',
      url: 'https://other.example/next',
    }));
    const authorizeFetch = vi.fn(async (url: string) => url === 'https://example.com/');
    const result = await executeWebToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/"}' },
    }], execute, new Set(['https://example.com/']), undefined, authorizeFetch);
    expect(authorizeFetch).toHaveBeenNthCalledWith(2, 'https://other.example/next', 'redirect');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.sources).toEqual([]);
    expect(result.errors).toEqual(['web_fetch: User declined access to this site']);
  });

  it('does not request a redirect destination that is not public HTTPS', async () => {
    const execute = vi.fn(async (): Promise<WebToolResult> => ({
      operation: 'redirect',
      url: 'http://other.example/next',
    }));
    const authorizeFetch = vi.fn(async () => true);
    const result = await executeWebToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/"}' },
    }], execute, new Set(['https://example.com/']), undefined, authorizeFetch);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authorizeFetch).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual(['web_fetch: Public web fetch returned an unexpected result']);
  });

  it('stops a cross-origin redirect chain at the hop cap', async () => {
    const execute = vi.fn(async (): Promise<WebToolResult> => ({
      operation: 'redirect',
      url: 'https://other.example/next',
    }));
    const authorizeFetch = vi.fn(async () => true);
    const result = await executeWebToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/"}' },
    }], execute, new Set(['https://example.com/']), undefined, authorizeFetch);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(result.errors).toEqual(['web_fetch: Too many redirects']);
    expect(result.sources).toEqual([]);
  });

  it('does not fetch a site the user declines', async () => {
    const execute = vi.fn();
    const authorizeFetch = vi.fn(async () => false);
    const result = await executeWebToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://example.com/"}' },
    }], execute, new Set(['https://example.com/']), undefined, authorizeFetch);
    expect(authorizeFetch).toHaveBeenCalledWith('https://example.com/', 'request');
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

  it('adds trusted two-round prompt-injection guidance', () => {
    const prompt = webToolSystemInstruction(' Be helpful. ');
    expect(prompt).toContain('Be helpful.');
    expect(prompt).toContain('not instructions');
    expect(prompt).toContain('at most two rounds');
    expect(prompt).toContain('current untrusted search results');
    expect(prompt).toContain('web_search');
    expect(prompt).not.toContain('Search button');
    expect(prompt).not.toContain('Search the web for:');
  });

  it('runs a model search only after approval and returns untrusted snippets', async () => {
    const execute = vi.fn(async (): Promise<WebToolResult> => ({
      operation: 'search',
      query: 'public weather',
      results: [{ title: 'Forecast', url: 'https://example.com/file.', snippet: 'Rain' }],
    }));
    const authorizeSearch = vi.fn(async () => true);
    const result = await executeWebToolCalls([{
      id: 'call-s',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":" public\\nweather "}' },
    }], execute, undefined, undefined, undefined, authorizeSearch);
    expect(authorizeSearch).toHaveBeenCalledWith('public weather');
    expect(execute).toHaveBeenCalledWith({
      operation: 'search',
      query: 'public weather',
      maxResults: 5,
    });
    expect(result.sources).toEqual([{ title: 'Forecast', url: 'https://example.com/file.' }]);
    expect(result.resultUrls).toEqual(['https://example.com/file.']);
    expect(result.errors).toEqual([]);
    expect(result.queries).toEqual(['public weather']);
    expect(result.toolMessages[0].content).toContain('UNTRUSTED WEB RESULT');
    expect(result.toolMessages[0].content).toContain('Search query: public weather');
  });

  it('does not search when approval is missing or declined', async () => {
    const execute = vi.fn();
    const declined = await executeWebToolCalls([{
      id: 'call-s',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"public weather"}' },
    }], execute, undefined, undefined, undefined, async () => false);
    expect(execute).not.toHaveBeenCalled();
    expect(declined.errors).toEqual(['web_search: User declined the search']);
    expect(declined.queries).toEqual([]);
    expect(declined.resultUrls).toEqual([]);
    const missing = await executeWebToolCalls([{
      id: 'call-s',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"public weather"}' },
    }], execute);
    expect(execute).not.toHaveBeenCalled();
    expect(missing.errors).toEqual(['web_search: User declined the search']);
    expect(missing.queries).toEqual([]);
  });

  it('runs only the first call when one web result fits', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => ({
      operation: 'search',
      query: request.operation === 'search' ? request.query : '',
      results: [],
    }));
    const calls = [1, 2].map((index) => ({
      id: `call-${index}`,
      type: 'function' as const,
      function: { name: 'web_search', arguments: JSON.stringify({ query: `query ${index}` }) },
    }));
    const result = await executeWebToolCalls(
      calls,
      execute,
      undefined,
      undefined,
      undefined,
      async () => true,
      { maxCalls: 1 },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolMessages[1]?.content).toContain('Only one web result fits this context.');
    expect(result.queries).not.toContain('query 2');
    await expect(executeWebToolCalls(
      [1, 2, 3].map((index) => ({
        id: `many-${index}`,
        type: 'function' as const,
        function: { name: 'web_search', arguments: '{"query":"x"}' },
      })),
      execute,
      undefined,
      undefined,
      undefined,
      async () => true,
      { maxCalls: 1 },
    )).rejects.toThrow(/at most 2/i);
  });

  it('names a search only after the user allows it', async () => {
    const searchCall = [{
      id: 'call-s',
      type: 'function' as const,
      function: { name: 'web_search', arguments: '{"query":"public weather"}' },
    }];
    const declinedEvents: string[] = [];
    const declinedExecute = vi.fn(async () => {
      declinedEvents.push('execute');
      return { operation: 'search' as const, query: 'public weather', results: [] };
    });
    const declined = await executeWebToolCalls(searchCall, declinedExecute, undefined, undefined, undefined, async () => {
      declinedEvents.push('asked');
      return false;
    }, {
      onActivity: () => declinedEvents.push('activity'),
    });
    expect(declinedEvents).toEqual(['asked']);
    expect(declinedExecute).not.toHaveBeenCalled();
    expect(declined.queries).toEqual([]);

    const allowedEvents: string[] = [];
    const allowedExecute = vi.fn(async () => {
      allowedEvents.push('execute');
      return { operation: 'search' as const, query: 'public weather', results: [] };
    });
    await executeWebToolCalls(searchCall, allowedExecute, undefined, undefined, undefined, async () => {
      allowedEvents.push('asked');
      return true;
    }, {
      onActivity: () => allowedEvents.push('activity'),
    });
    expect(allowedEvents).toEqual(['asked', 'activity', 'execute']);
  });

  it('records an empty search as a tool issue and returns no result URLs', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => {
      if (request.operation === 'search') {
        return { operation: 'search', query: request.query, results: [] };
      }
      throw new Error('fetch should not run');
    });
    const empty = await executeWebToolCalls([{
      id: 'call-s',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"nothing public"}' },
    }], execute, undefined, undefined, undefined, async () => true);
    expect(empty.sources).toEqual([]);
    expect(empty.resultUrls).toEqual([]);
    expect(empty.errors).toEqual(['web_search: The public search returned no results']);
    expect(empty.toolMessages[0].content).toContain('UNTRUSTED WEB RESULT');
  });

  it('searches even when a sibling fetch is not yet allowed', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => ({
      operation: 'search',
      query: request.operation === 'search' ? request.query : '',
      results: [{ title: 'A', url: 'https://found.example/a', snippet: 's' }],
    }));
    const result = await executeWebToolCalls([
      {
        id: 'call-s',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"public weather"}' },
      },
      {
        id: 'call-f',
        type: 'function',
        function: { name: 'web_fetch', arguments: '{"url":"https://found.example/a"}' },
      },
    ], execute, new Set<string>(), undefined, async () => true, async () => true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.sources).toEqual([{ title: 'A', url: 'https://found.example/a' }]);
    expect(result.resultUrls).toEqual(['https://found.example/a']);
    expect(result.errors).toEqual([
      'web_fetch: web_fetch may retrieve only a URL typed or attached in the current user message, or a URL from the current search results',
    ]);
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

  it('rejects a policy query without echoing it or recording a search', async () => {
    const secret = `flint-ref-${'a'.repeat(12)}`;
    expect(searchQueryPolicyError(secret)).toBe('query rejected by local policy');
    expect(searchQueryPolicyError(secret)).not.toContain(secret);
    const execute = vi.fn();
    const result = await executeWebToolCalls([{
      id: 'call-s',
      type: 'function',
      function: { name: 'web_search', arguments: JSON.stringify({ query: secret }) },
    }], execute, undefined, undefined, undefined, async () => true);
    expect(execute).not.toHaveBeenCalled();
    expect(result.queries).toEqual([]);
    expect(result.errors).toEqual(['web_search: query rejected by local policy']);
    expect(result.toolMessages[0].content).not.toContain(secret);
    expect(result.toolMessages[0].content).toContain('query rejected by local policy');
  });

  it('rejects denied IPv6 literals in a search query and allows a public address', () => {
    expect(searchQueryPolicyError('public 2606:2800:220:1:248:1893:25c8:1946')).toBeNull();
    expect(searchQueryPolicyError('public 93.184.216.34')).toBeNull();
    expect(searchQueryPolicyError('mapped public ::ffff:93.184.216.34')).toBeNull();
    expect(searchQueryPolicyError('code hello::world')).toBeNull();
    expect(searchQueryPolicyError('meet at 12:30:00 today')).toBeNull();
    expect(searchQueryPolicyError('router at ::1')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('ula fd00::1')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('link fe80::1')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('mapped ::ffff:127.0.0.1')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('bracket https://[::1]/')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('sentence ::1.')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('docs 2001:db8::1')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('loopback 127.0.0.1')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('https://[::1]:8080/')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('https://[::1]:8080')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('https://[2001:db8:1:2:3:4:5:6]:8080/')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('https://[2606:2800:220:1:248:1893:25c8:1946]:443/')).toBeNull();
  });

  it('rejects a file scheme and allows a word that ends in file', () => {
    expect(searchQueryPolicyError('public profile: Ada Lovelace')).toBeNull();
    expect(searchQueryPolicyError('short public weather')).toBeNull();
    expect(searchQueryPolicyError('file:///etc/passwd')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('File:/secret')).toBe('query rejected by local policy');
    expect(searchQueryPolicyError('open file:/tmp/x')).toBe('query rejected by local policy');
  });

  it('builds the search scrub corpus from history, the current turn, and attached file text', () => {
    const historySecret = 'history-secret-value-that-is-at-least-forty-eight-characters';
    const fileSecret = 'file-secret-value-that-is-at-least-forty-eight-characters-long';
    const messages = [
      { role: 'system', content: 'System rules for this chat.' },
      { role: 'user', content: `older question ${historySecret}` },
      { role: 'assistant', content: 'older answer' },
      {
        role: 'user',
        content: [
          null,
          { type: 'text' },
          { type: 'text', text: 'current question' },
          { type: 'file_text', file: { name: 'notes.txt', text: fileSecret } },
          { type: 'file_text', file: {} },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,SHOULD-NOT-BE-SCANNED' } },
          { type: 'nope' },
        ],
      },
    ];
    const corpus = searchScrubCorpus(messages);
    expect(corpus).toContain('System rules for this chat.');
    expect(corpus).toContain(historySecret);
    expect(corpus).toContain('older answer');
    expect(corpus).toContain('current question');
    expect(corpus).toContain(fileSecret);
    expect(corpus).not.toContain('SHOULD-NOT-BE-SCANNED');
    expect(searchQueryPolicyError(`please find ${historySecret} now`, corpus))
      .toBe('query rejected by local policy');
    expect(searchQueryPolicyError('short public weather', corpus)).toBeNull();
    expect(searchScrubCorpus(undefined)).toBe('');
  });

  it('rejects a query that repeats a long run from this send', () => {
    const run = 'attached-secret-value-that-is-at-least-forty-eight-characters';
    expect(run.length).toBeGreaterThanOrEqual(48);
    expect(searchQueryPolicyError(`look up ${run} please`, `notes ${run} end`))
      .toBe('query rejected by local policy');
    expect(searchQueryPolicyError('short public weather', `notes ${run} end`)).toBeNull();
  });

  it('does not repeat a page already included in this request', async () => {
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => ({
      operation: 'fetch',
      url: request.operation === 'fetch' ? request.url : '',
      title: 'A',
      text: 'Body',
      truncated: false,
      charCount: 4,
    }));
    const result = await executeWebToolCalls([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'web_fetch', arguments: '{"url":"https://example.com/a"}' },
      },
      {
        id: 'call-2',
        type: 'function',
        function: { name: 'web_fetch', arguments: '{"url":"https://example.com/b"}' },
      },
    ], execute, new Set(['https://example.com/a', 'https://example.com/b']), undefined, undefined, undefined, {
      alreadyIncluded: new Set(['https://example.com/a']),
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolMessages[0].content).toBe(
      'This URL is already included in the current request. Use that block and answer from it.',
    );
    expect(result.sources).toEqual([{ title: 'A', url: 'https://example.com/b' }]);
  });

  it('does not fetch a redirect whose destination is already included', async () => {
    const start = 'https://start.example/go';
    const land = 'https://land.example/page';
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => {
      if (request.operation === 'fetch' && request.url === start) {
        return { operation: 'redirect', url: land };
      }
      return {
        operation: 'fetch',
        url: land,
        title: 'Land',
        text: 'Body',
        truncated: false,
        charCount: 4,
      };
    });
    const authorizeFetch = vi.fn(async () => true);
    const result = await executeWebToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'web_fetch', arguments: `{"url":"${start}"}` },
    }], execute, new Set([start]), undefined, authorizeFetch, undefined, {
      alreadyIncluded: new Set([land]),
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      operation: 'fetch',
      url: start,
      maxChars: 20_000,
    });
    expect(authorizeFetch).toHaveBeenCalledTimes(1);
    expect(authorizeFetch).toHaveBeenCalledWith(start, 'request');
    expect(authorizeFetch).not.toHaveBeenCalledWith(land, 'redirect');
    expect(result.toolMessages[0]?.content).toBe(
      'This URL is already included in the current request. Use that block and answer from it.',
    );
    expect(result.sources).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('does not fetch a redirect to a page fetched earlier in this round', async () => {
    const start = 'https://start.example/go';
    const land = 'https://land.example/page';
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => {
      if (request.operation === 'fetch' && request.url === start) {
        return { operation: 'redirect', url: land };
      }
      return {
        operation: 'fetch',
        url: land,
        title: 'Land',
        text: 'Body',
        truncated: false,
        charCount: 4,
      };
    });
    const authorizeFetch = vi.fn(async () => true);
    const result = await executeWebToolCalls([
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'web_fetch', arguments: `{"url":"${land}"}` },
      },
      {
        id: 'call-2',
        type: 'function',
        function: { name: 'web_fetch', arguments: `{"url":"${start}"}` },
      },
    ], execute, new Set([start, land]), undefined, authorizeFetch);
    const landFetches = execute.mock.calls.filter((call) => (
      call[0]?.operation === 'fetch' && call[0]?.url === land
    ));
    expect(landFetches).toHaveLength(1);
    expect(result.toolMessages[1]?.content).toBe(
      'This URL is already included in the current request. Use that block and answer from it.',
    );
    expect(result.sources).toEqual([{ title: 'Land', url: land }]);
    expect(authorizeFetch).not.toHaveBeenCalledWith(land, 'redirect');
  });

  it('blocks a host before domain consent and drops a blocklisted search result', async () => {
    const execute = vi.fn();
    const authorizeFetch = vi.fn(async () => true);
    const blocked = await executeWebToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://sub.example.com/a"}' },
    }], execute, new Set(['https://sub.example.com/a']), undefined, authorizeFetch, undefined, {
      blocklist: ['example.com'],
    });
    expect(authorizeFetch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(blocked.errors).toEqual(['web_fetch: This host is blocked on this device']);

    const search = vi.fn(async (): Promise<WebToolResult> => ({
      operation: 'search',
      query: 'public weather',
      results: [
        { title: 'Blocked', url: 'https://sub.example.com/a', snippet: 'no' },
        { title: 'Open', url: 'https://other.example/a', snippet: 'yes' },
      ],
    }));
    const found = await executeWebToolCalls([{
      id: 'call-s',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"public weather"}' },
    }], search, undefined, undefined, undefined, async () => true, {
      blocklist: ['example.com'],
    });
    expect(found.resultUrls).toEqual(['https://other.example/a']);
  });

  it('does not ask to fetch an image from a blocked host', async () => {
    const execute = vi.fn();
    const authorize = vi.fn(async () => true);
    const blocked = await executeWebImage(
      'https://photos.example.com/a.jpg',
      execute,
      authorize,
      ['example.com'],
    );
    expect(blocked).toEqual({ error: 'This host is blocked on this device' });
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns one image, follows an approved redirect, and stops on decline or abort', async () => {
    const execute = vi.fn(async (): Promise<WebToolResult> => ({
      operation: 'image',
      url: 'https://photos.example/a.jpg',
      mediaType: 'image/jpeg',
      dataBase64: 'abc',
    }));
    const image = await executeWebImage(
      'https://photos.example/a.jpg',
      execute,
      async () => true,
    );
    expect(image).toEqual({
      url: 'https://photos.example/a.jpg',
      mediaType: 'image/jpeg',
      dataBase64: 'abc',
    });

    const redirected = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => {
      const url = 'url' in request ? request.url : '';
      return url === 'https://photos.example/a.jpg'
        ? { operation: 'redirect', url: 'https://cdn.example/b.jpg' }
        : { operation: 'image', url, mediaType: 'image/jpeg', dataBase64: 'zzz' };
    });
    const followed = await executeWebImage('https://photos.example/a.jpg', redirected, async () => true);
    expect(followed).toEqual({
      url: 'https://cdn.example/b.jpg',
      mediaType: 'image/jpeg',
      dataBase64: 'zzz',
    });

    const declined = await executeWebImage(
      'https://photos.example/a.jpg',
      vi.fn(),
      async () => false,
    );
    expect(declined).toEqual({ error: 'User declined access to this site' });

    const stopped = await executeWebImage(
      'https://photos.example/a.jpg',
      vi.fn(),
      async () => true,
      [],
      AbortSignal.abort(),
    );
    expect(stopped).toEqual({ error: 'Stopped' });

    const unexpected = await executeWebImage(
      'https://photos.example/a.jpg',
      async () => ({ operation: 'search', query: 'nope', results: [] }),
      async () => true,
    );
    expect(unexpected).toEqual({ error: 'Public web fetch returned an unexpected result' });

    const badRedirect = await executeWebImage(
      'https://photos.example/a.jpg',
      async () => ({ operation: 'redirect', url: 'not a url' }),
      async () => true,
    );
    expect(badRedirect).toEqual({ error: 'Public web fetch returned an unexpected result' });

    let hops = 0;
    const tooMany = await executeWebImage(
      'https://photos.example/start.jpg',
      async () => {
        hops += 1;
        return { operation: 'redirect', url: `https://cdn${hops}.example/next.jpg` };
      },
      async () => true,
    );
    expect(tooMany).toEqual({ error: 'Too many redirects' });
  });

  it('returns an error when image authorization or execution rejects', async () => {
    await expect(executeWebImage(
      'https://photos.example/a.jpg',
      async () => {
        throw new Error('helper down');
      },
      async () => true,
    )).resolves.toEqual({ error: 'helper down' });

    await expect(executeWebImage(
      'https://photos.example/a.jpg',
      vi.fn(),
      async () => {
        throw new Error('consent failed');
      },
    )).resolves.toEqual({ error: 'consent failed' });

    const controller = new AbortController();
    await expect(executeWebImage(
      'https://photos.example/a.jpg',
      async () => {
        controller.abort();
        throw new Error('aborted');
      },
      async () => true,
      [],
      controller.signal,
    )).resolves.toEqual({ error: 'Stopped' });
  });

  it('names the search or the host while a tool call is running', async () => {
    const seen: string[] = [];
    const note = (event: { kind: string; query?: string; host?: string }) => {
      seen.push(event.kind === 'search' ? `search:${event.query}` : `fetch:${event.host}`);
    };
    const execute = vi.fn(async (request: WebToolRequest): Promise<WebToolResult> => {
      if (request.operation === 'search') {
        seen.push('ran-search');
        return { operation: 'search', query: request.query, results: [] };
      }
      seen.push(`ran-fetch:${request.url}`);
      if (request.url === 'https://start.example/a') {
        return { operation: 'redirect', url: 'https://land.example/b' };
      }
      return {
        operation: 'fetch',
        url: request.url,
        title: 'Page',
        text: 'Body',
        truncated: false,
        charCount: 4,
      };
    });
    await executeWebToolCalls([{
      id: 'call-s',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"public weather"}' },
    }], execute, undefined, undefined, undefined, async () => true, {
      onActivity: note,
    });
    await executeWebToolCalls([{
      id: 'call-f',
      type: 'function',
      function: { name: 'web_fetch', arguments: '{"url":"https://start.example/a"}' },
    }], execute, new Set(['https://start.example/a']), undefined, async () => true, undefined, {
      onActivity: note,
    });
    expect(seen).toEqual([
      'search:public weather',
      'ran-search',
      'fetch:start.example',
      'ran-fetch:https://start.example/a',
      'fetch:land.example',
      'ran-fetch:https://land.example/b',
    ]);
  });
});
