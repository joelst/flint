import { EventEmitter } from 'node:events';
import https from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeSearchResults,
  executeWebRequest,
  fetchPublicText,
  isDeniedAddress,
  normalizeRequest,
  requestPinned,
  runHelper,
} from './web-tool.js';

describe('web tool request validation', () => {
  it('bounds public search requests', () => {
    expect(normalizeRequest({ operation: 'search', query: ' local models ', maxResults: 99 }))
      .toEqual({ operation: 'search', query: 'local models', maxResults: 5 });
  });

  it('rejects unsupported request fields', () => {
    expect(() => normalizeRequest({
      operation: 'search',
      query: 'models',
      headers: { Authorization: 'secret' },
    })).toThrow(/unsupported field/i);
    expect(() => normalizeRequest({
      operation: 'fetch',
      url: 'https://example.com/',
      method: 'POST',
    })).toThrow(/unsupported field/i);
  });

  it('refuses credentials and non-HTTPS retrieval', () => {
    expect(() => normalizeRequest({
      operation: 'fetch',
      url: 'https://user:secret@example.com/',
    })).toThrow(/credentials/i);
    expect(() => normalizeRequest({
      operation: 'fetch',
      url: 'http://example.com/',
    })).toThrow(/https/i);
  });
});

describe('web tool network boundary', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fec0::1',
    'feff::1',
    'fe80::1',
    '224.0.0.1',
    '0.0.0.0',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::c0a8:101',
    '192.88.99.1',
    '192.88.99.2',
    '100:0:0:1::1',
    '100::1',
    '200::1',
    '4000::1',
    'e000::1',
    '::ffff:0:7f00:1',
    '::ffff:0:a00:1',
    '::ffff:0:c0a8:101',
    '::ffff:0:5db8:d822',
    '2001:db8::1',
    '3ffe::',
    '3ffe::1',
    '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('denies private or special address %s', (address) => {
    expect(isDeniedAddress(address)).toBe(true);
  });

  it('allows ordinary public IPv4 and IPv6 addresses', () => {
    expect(isDeniedAddress('93.184.216.34')).toBe(false);
    expect(isDeniedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    expect(isDeniedAddress('::ffff:93.184.216.34')).toBe(false);
    expect(isDeniedAddress('192.88.98.255')).toBe(false);
    expect(isDeniedAddress('192.88.100.1')).toBe(false);
    expect(isDeniedAddress('2a00:1450:4001:80b::200e')).toBe(false);
    expect(isDeniedAddress('3ffd:ffff::1')).toBe(false);
    expect(isDeniedAddress('3fff:1000::1')).toBe(false);
  });

  it.each([
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://[::1]/',
  ])('rejects literal loopback form %s before requesting it', async (url) => {
    const request = vi.fn();
    await expect(fetchPublicText(url, { request })).rejects.toThrow(/private|special/i);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'https://localhost/',
    'https://localhost./',
    'https://LOCALHOST../',
    'https://printer.local/',
    'https://printer.local./',
    'https://app.localhost/',
    'https://app.localhost./',
  ])('rejects local hostname %s before resolving it', async (url) => {
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const request = vi.fn();
    await expect(fetchPublicText(url, { resolve, request })).rejects.toThrow(/local hostnames/i);
    expect(resolve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(() => normalizeRequest({ operation: 'fetch', url })).toThrow(/local hostnames/i);
  });

  it('rejects a redirect to a trailing-dot local hostname before resolving it', async () => {
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const request = vi.fn(async () => ({
      statusCode: 302,
      headers: { location: 'https://localhost./admin' },
      body: Buffer.alloc(0),
    }));
    await expect(fetchPublicText('https://public.example/', { resolve, request }))
      .rejects.toThrow(/local hostnames/i);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('revalidates redirect destinations before connecting', async () => {
    const resolve = vi.fn(async (hostname: string) => [{
      address: hostname === 'public.example' ? '93.184.216.34' : '127.0.0.1',
      family: 4,
    }]);
    const request = vi.fn(async () => ({
      statusCode: 302,
      headers: { location: 'https://private.example/secret' },
      body: Buffer.alloc(0),
    }));
    await expect(fetchPublicText('https://public.example/', {
      resolve,
      request,
    })).rejects.toThrow(/private|special/i);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a hostname when any resolved address is private', async () => {
    const resolve = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const request = vi.fn();
    await expect(fetchPublicText('https://mixed.example/', {
      resolve,
      request,
    })).rejects.toThrow(/private|special/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('caps redirect chains and validates response metadata', async () => {
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const redirect = vi.fn(async () => ({
      statusCode: 302,
      headers: { location: 'https://public.example/again' },
      body: Buffer.alloc(0),
    }));
    await expect(fetchPublicText('https://public.example/', {
      resolve,
      request: redirect,
    })).rejects.toThrow(/too many redirects/i);
    expect(redirect).toHaveBeenCalledTimes(4);

    const encoded = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
      body: Buffer.from('compressed'),
    }));
    await expect(fetchPublicText('https://public.example/', {
      resolve,
      request: encoded,
    })).rejects.toThrow(/content encoding/i);

    const binary = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('binary'),
    }));
    await expect(fetchPublicText('https://public.example/', {
      resolve,
      request: binary,
    })).rejects.toThrow(/content type/i);
  });

  it('never forwards a POST body to a different redirect origin', async () => {
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const request = vi.fn(async () => ({
      statusCode: 307,
      headers: { location: 'https://other.example/search' },
      body: Buffer.alloc(0),
      truncated: false,
    }));
    await expect(fetchPublicText('https://search.example/', {
      resolve,
      request,
      method: 'POST',
      body: 'q=private+query',
    })).rejects.toThrow(/cross-origin/i);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('allows a cross-origin 302 only after converting the redirected request to GET', async () => {
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: 'https://other.example/results' },
        body: Buffer.alloc(0),
        truncated: false,
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('results'),
        truncated: false,
      });
    await expect(fetchPublicText('https://search.example/', {
      resolve,
      request,
      method: 'POST',
      body: 'q=private+query',
    })).resolves.toMatchObject({ body: 'results' });
    expect(request).toHaveBeenNthCalledWith(
      2,
      new URL('https://other.example/results'),
      { address: '93.184.216.34', family: 4 },
      expect.objectContaining({ method: 'GET', body: null }),
    );
  });

  it('enforces one overall deadline across DNS, redirects, and response capture', async () => {
    const resolve = vi.fn(() => new Promise(() => {}));
    await expect(fetchPublicText('https://public.example/', {
      resolve,
      overallTimeoutMs: 5,
    })).rejects.toThrow(/timed out/i);
  });

  it('captures a bounded prefix instead of rejecting an oversized page', async () => {
    const response = Object.assign(new EventEmitter(), {
      headers: { 'content-type': 'text/plain', 'content-length': '1000' },
      statusCode: 200,
      destroy: vi.fn(),
    });
    const request = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
    });
    request.end.mockImplementation(() => {
      responseCallback(response);
      response.emit('data', Buffer.from('123456789'));
      response.emit('end');
    });
    let responseCallback: (value: any) => void = () => {};
    const spy = vi.spyOn(https, 'request').mockImplementation(((_options: any, callback: any) => {
      responseCallback = callback;
      return request;
    }) as any);
    try {
      const result = await requestPinned(
        new URL('https://example.com/'),
        { address: '93.184.216.34', family: 4 },
        { maxBytes: 5 },
      );
      expect(result.body.toString()).toBe('12345');
      expect(result.truncated).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['https://example.com/', { address: '93.184.216.34', family: 4 }, 'example.com'],
    ['https://93.184.216.34/', { address: '93.184.216.34', family: 4 }, undefined],
    ['https://[2606:4700:4700::1111]/', { address: '2606:4700:4700::1111', family: 6 }, undefined],
  ])('sends SNI only for DNS names (%s)', async (raw, resolved, servername) => {
    let captured: any;
    const request = Object.assign(new EventEmitter(), {
      end: vi.fn(() => request.emit('error', new Error('stop'))),
      write: vi.fn(),
      destroy: vi.fn(),
      setTimeout: vi.fn(),
    });
    const spy = vi.spyOn(https, 'request').mockImplementation(((options: any) => {
      captured = options;
      return request;
    }) as any);
    try {
      await expect(requestPinned(new URL(raw), resolved)).rejects.toThrow('stop');
      expect(captured.hostname).toBe(resolved.address);
      expect(captured.servername).toBe(servername);
      expect(captured.hostname).not.toMatch(/[[\]]/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('search result decoding', () => {
  it('returns bounded, decoded public results without tracking redirects', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example &amp; One</a>
        <a class="result__snippet">A <b>useful</b> result.</a>
      </div>`;
    expect(decodeSearchResults(html, 1)).toEqual([{
      title: 'Example & One',
      url: 'https://example.com/a',
      snippet: 'A useful result.',
    }]);
  });

  it('skips malformed destinations and bounds extracted fields', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="javascript:alert(1)">Bad</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.com/">X${'y'.repeat(500)}</a>
        <div class="result__snippet">${'z'.repeat(2_000)}</div>
      </div>`;
    const [result] = decodeSearchResults(html, 5);
    expect(result.url).toBe('https://example.com/');
    expect(result.title).toHaveLength(300);
    expect(result.snippet).toHaveLength(1_000);
  });

  it('removes entity-encoded markup and control characters from source labels', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com/">
          Safe&#10;&lt;script&gt;bad&lt;/script&gt; title
        </a>
      </div>`;
    expect(decodeSearchResults(html, 1)[0].title).toBe('Safe bad title');
  });

  it('decodes entities once so nested encodings cannot become active markup', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com/">
          Safe &amp;lt;script&amp;gt;literal&amp;lt;/script&amp;gt;
        </a>
      </div>`;
    expect(decodeSearchResults(html, 1)[0].title)
      .toBe('Safe &lt;script&gt;literal&lt;/script&gt;');
  });

  it('skips advertising blocks and DuckDuckGo ad redirects', () => {
    const html = `
      <div class="result result--ad">
        <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Ad</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.com/">Organic</a>
      </div>`;
    expect(decodeSearchResults(html, 5)).toEqual([{
      title: 'Organic',
      url: 'https://example.com/',
      snippet: '',
    }]);
  });
});

describe('search execution', () => {
  it('uses form POST and rejects challenge responses explicitly', async () => {
    const resolve = vi.fn(async () => [{ address: '52.142.124.215', family: 4 }]);
    const request = vi.fn(async (_url, _resolved, options) => ({
      statusCode: 202,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<form id="challenge-form">Bots use DuckDuckGo too</form>'),
      truncated: false,
      options,
    }));
    await expect(executeWebRequest({
      operation: 'search',
      query: 'local models',
    }, { resolve, request })).rejects.toThrow(/bot challenge/i);
    expect(request.mock.calls[0][2]).toMatchObject({
      method: 'POST',
      body: 'q=local+models',
    });
  });

  it('decodes a declared charset and rejects one it cannot honor', async () => {
    const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const windows1252 = Buffer.concat([
      Buffer.from('<title>Caf'),
      Buffer.from([0xe9]),
      Buffer.from('</title><p>Caf'),
      Buffer.from([0xe9]),
      Buffer.from('</p>'),
    ]);
    const decoded = await executeWebRequest(
      { operation: 'fetch', url: 'https://example.com/' },
      {
        resolve,
        request: vi.fn(async () => ({
          statusCode: 200,
          headers: { 'content-type': 'text/html; charset="Windows-1252"' },
          body: windows1252,
          truncated: false,
        })),
      },
    );
    expect(decoded.title).toBe('Café');
    expect(decoded.text).toContain('Café');
    expect(decoded.text).not.toContain('\uFFFD');

    await expect(fetchPublicText('https://example.com/', {
      resolve,
      request: vi.fn(async () => ({
        statusCode: 200,
        headers: { 'content-type': "text/plain; charset='utf-8'" },
        body: Buffer.from('plain'),
        truncated: false,
      })),
    })).resolves.toMatchObject({ body: 'plain' });

    await expect(fetchPublicText('https://example.com/', {
      resolve,
      request: vi.fn(async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/plain; charset=utf-7; charset=utf-8' },
        body: Buffer.from('plain'),
        truncated: false,
      })),
    })).resolves.toMatchObject({ body: 'plain' });

    await expect(fetchPublicText('https://example.com/', {
      resolve,
      request: vi.fn(async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/plain; charset=utf-7' },
        body: Buffer.from('not utf-7'),
        truncated: false,
      })),
    })).rejects.toThrow(/charset: utf-7/i);

    await expect(fetchPublicText('https://example.com/', {
      resolve,
      request: vi.fn(async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/plain; charset=' },
        body: Buffer.from('x'),
        truncated: false,
      })),
    })).rejects.toThrow(/charset/i);

    await expect(fetchPublicText('https://example.com/', {
      resolve,
      request: vi.fn(async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: Buffer.from([0xff]),
        truncated: false,
      })),
    })).rejects.toThrow(/not valid utf-8/i);

    await expect(fetchPublicText('https://example.com/', {
      resolve,
      request: vi.fn(async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from([0xff]),
        truncated: false,
      })),
    })).rejects.toThrow(/not valid utf-8/i);
  });

  it('returns organic results from a successful search page', async () => {
    const resolve = vi.fn(async () => [{ address: '52.142.124.215', family: 4 }]);
    const request = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(`
        <div class="result">
          <a class="result__a" href="https://example.com/">Example</a>
          <div class="result__snippet">Snippet</div>
        </div>`),
      truncated: false,
    }));
    await expect(executeWebRequest({
      operation: 'search',
      query: 'local models',
      maxResults: 1,
    }, { resolve, request })).resolves.toEqual({
      operation: 'search',
      query: 'local models',
      results: [{
        title: 'Example',
        url: 'https://example.com/',
        snippet: 'Snippet',
      }],
    });
  });
});

describe('fetch execution and helper entry', () => {
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
  const respond = (body: string, headers: Record<string, string> = { 'content-type': 'text/html' }, statusCode = 200) =>
    vi.fn(async () => ({ statusCode, headers, body: Buffer.from(body), truncated: false }));

  async function* chunks(...values: string[]) {
    for (const value of values) yield Buffer.from(value);
  }

  it('extracts bounded page text and a decoded title, dropping active content', async () => {
    const html = '<title>A &amp; B &#x263A; &#9731; &#xD800; &#99999999;</title>'
      + '<script>secret()</script><p>Hello&nbsp;<b>world</b> &QUOT;q&quot;</p>';
    const result = await executeWebRequest(
      { operation: 'fetch', url: 'https://example.com/#frag' },
      { resolve, request: respond(html) },
    );
    expect(result).toMatchObject({
      operation: 'fetch',
      url: 'https://example.com/',
      title: 'A & B \u263a \u2603',
      truncated: false,
    });
    expect(result.text).toContain('Hello&nbsp; world "q"');
    expect(result.text).not.toContain('secret');
  });

  it('collapses plain text and truncates it to the requested size', async () => {
    const result = await executeWebRequest(
      { operation: 'fetch', url: 'https://example.com/', maxChars: 1_000 },
      { resolve, request: respond(`a \n ${'b'.repeat(2_000)}`, { 'content-type': 'text/plain; charset=utf-8' }) },
    );
    expect(result.text).toHaveLength(1_000);
    expect(result.truncated).toBe(true);
    expect(result.charCount).toBe(1_000);
  });

  it('refuses malformed requests before any network activity', () => {
    for (const raw of [null, [], 'x', { operation: 'shell' }]) {
      expect(() => normalizeRequest(raw)).toThrow(/object|search or fetch/i);
    }
    expect(() => normalizeRequest({ operation: 'search', query: '  ' })).toThrow(/1-500/);
    expect(() => normalizeRequest({ operation: 'search', query: 'x'.repeat(501) })).toThrow(/1-500/);
    expect(normalizeRequest({ operation: 'search', query: 'q' })).toMatchObject({ maxResults: 5 });
    expect(normalizeRequest({ operation: 'search', query: 'q', maxResults: 0 })).toMatchObject({ maxResults: 1 });
    expect(normalizeRequest({ operation: 'fetch', url: 'https://example.com/', maxChars: 1 }))
      .toMatchObject({ maxChars: 1_000 });
    expect(normalizeRequest({ operation: 'fetch', url: 'https://example.com/', maxChars: 1e9 }))
      .toMatchObject({ maxChars: 50_000 });
    expect(normalizeRequest({ operation: 'fetch', url: 'https://example.com:443/' }))
      .toMatchObject({ url: 'https://example.com/' });
    expect(() => normalizeRequest({ operation: 'fetch', url: 'https://example.com:8443/' })).toThrow(/port/i);
    expect(() => normalizeRequest({ operation: 'fetch', url: 'https://printer.local/' })).toThrow(/local/i);
  });

  it('connects to IP literals without DNS and refuses empty or private answers', async () => {
    const lookup = vi.fn();
    await fetchPublicText('https://[2606:4700:4700::1111]/', {
      resolve: lookup,
      request: respond('ok', { 'content-type': 'text/plain' }),
    });
    expect(lookup).not.toHaveBeenCalled();
    await expect(fetchPublicText('https://10.0.0.1/', { resolve: lookup })).rejects.toThrow(/private/);
    await expect(fetchPublicText('https://empty.example/', { resolve: vi.fn(async () => []) }))
      .rejects.toThrow(/did not resolve/);
    await expect(fetchPublicText('https://empty.example/', { resolve: vi.fn(async () => null) }))
      .rejects.toThrow(/did not resolve/);
  });

  it('fails immediately when no time remains and on unusable responses', async () => {
    await expect(fetchPublicText('https://example.com/', { resolve, overallTimeoutMs: 0 }))
      .rejects.toThrow(/timed out/);
    await expect(fetchPublicText('https://example.com/', { resolve, request: respond('', {}, 302) }))
      .rejects.toThrow(/no destination/);
    await expect(fetchPublicText('https://example.com/', { resolve, request: respond('', {}, 500) }))
      .rejects.toThrow(/HTTP 500/);
    await expect(fetchPublicText('https://example.com/', { resolve, request: respond('', {}) }))
      .rejects.toThrow(/content type: missing/);
    await expect(fetchPublicText('https://example.com/', {
      resolve,
      request: respond('', { 'content-type': 'text/html', 'content-encoding': 'gzip' }),
    })).rejects.toThrow(/encoding: gzip/);
  });

  it('writes one JSON line and an exit code for success and every failure', async () => {
    const lines: string[] = [];
    const write = (line: string) => { lines.push(line); };
    await expect(runHelper(
      chunks('{"operation":"fetch",', '"url":"https://example.com/"}'),
      write,
      { resolve, request: respond('plain', { 'content-type': 'text/plain' }) },
    )).resolves.toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, result: { text: 'plain' } });

    await expect(runHelper(chunks('{'), write)).resolves.toBe(1);
    expect(JSON.parse(lines[1]).ok).toBe(false);

    await expect(runHelper(chunks('x'.repeat(16 * 1024 + 1)), write)).resolves.toBe(1);
    expect(JSON.parse(lines[2]).error).toMatch(/Input exceeds/);

    await expect(runHelper(
      chunks('{"operation":"fetch","url":"https://example.com/","maxChars":50000}'),
      write,
      { resolve, request: respond('\u0001'.repeat(50_000), { 'content-type': 'text/plain' }) },
    )).resolves.toBe(1);
    expect(JSON.parse(lines[3]).error).toMatch(/Output exceeds/);

    await expect(runHelper(chunks('{"operation":"search","query":"q"}'), write, {
      resolve,
      request: vi.fn(async () => { throw 'raw failure'; }),
    })).resolves.toBe(1);
    expect(JSON.parse(lines[4]).error).toBe('raw failure');
    expect(lines.every((line) => line.endsWith('\n'))).toBe(true);
  });
});

describe('pinned request transport', () => {
  function fakeTransport() {
    const response = Object.assign(new EventEmitter(), { headers: {}, statusCode: undefined, destroy: vi.fn() });
    const request = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn(), end: vi.fn() });
    let captured: any;
    let callback: (value: any) => void = () => {};
    const spy = vi.spyOn(https, 'request').mockImplementation(((options: any, cb: any) => {
      captured = options;
      callback = cb;
      return request;
    }) as any);
    return { response, request, spy, options: () => captured, deliver: () => callback(response) };
  }

  it('sends a form body with explicit length and reports a missing status as 0', async () => {
    const t = fakeTransport();
    t.request.end.mockImplementation(() => {
      t.deliver();
      t.response.emit('data', Buffer.from('ok'));
      t.response.emit('end');
    });
    try {
      const result = await requestPinned(
        new URL('https://example.com/a?b=c'),
        { address: '93.184.216.34', family: 4 },
        { method: 'POST', body: 'q=x' },
      );
      expect(t.request.write).toHaveBeenCalledWith(Buffer.from('q=x'));
      expect(t.options()).toMatchObject({
        method: 'POST',
        path: '/a?b=c',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '3' },
      });
      expect(result).toMatchObject({ statusCode: 0, truncated: false });
      expect(result.body.toString()).toBe('ok');
    } finally {
      t.spy.mockRestore();
    }
  });

  it('stops at an exact byte limit and ignores later stream errors', async () => {
    const t = fakeTransport();
    t.request.end.mockImplementation(() => {
      t.deliver();
      t.response.emit('data', Buffer.from('12345'));
      t.response.emit('data', Buffer.from('6'));
      t.response.emit('error', new Error('after settle'));
      t.response.emit('end');
    });
    try {
      const result = await requestPinned(
        new URL('https://example.com/'),
        { address: '93.184.216.34', family: 4 },
        { maxBytes: 5 },
      );
      expect(result.body.toString()).toBe('12345');
      expect(result.truncated).toBe(true);
      expect(t.response.destroy).toHaveBeenCalled();
    } finally {
      t.spy.mockRestore();
    }
  });

  it('rejects on a response error and destroys a timed-out request', async () => {
    const t = fakeTransport();
    t.request.end.mockImplementation(() => {
      t.deliver();
      t.response.emit('error', new Error('reset'));
    });
    try {
      await expect(requestPinned(new URL('https://example.com/'), { address: '93.184.216.34', family: 4 }))
        .rejects.toThrow('reset');
    } finally {
      t.spy.mockRestore();
    }

    const timed = fakeTransport();
    timed.request.destroy.mockImplementation((error: Error) => timed.request.emit('error', error));
    timed.request.end.mockImplementation(() => timed.request.emit('timeout'));
    try {
      await expect(requestPinned(new URL('https://example.com/'), { address: '93.184.216.34', family: 4 }))
        .rejects.toThrow(/timed out/);
      expect(timed.options().timeout).toBe(8_000);
    } finally {
      timed.spy.mockRestore();
    }
  });
});

describe('remaining helper edges', () => {
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

  it('keeps unknown entities and drops an incomplete trailing character from a truncated body', async () => {
    const body = Buffer.concat([Buffer.from('<title>x&bogus;y</title>caf'), Buffer.from('\u00e9').subarray(0, 1)]);
    const result = await executeWebRequest(
      { operation: 'fetch', url: 'https://example.com/' },
      { resolve, request: vi.fn(async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body, truncated: true })) },
    );
    expect(result.title).toBe('x&bogus;y');
    expect(result.text).toBe('x&bogus;y caf');
    expect(result.truncated).toBe(true);
  });

  it('stops following an endless redirect chain', async () => {
    const request = vi.fn(async () => ({ statusCode: 302, headers: { location: '/again' }, body: Buffer.alloc(0) }));
    await expect(fetchPublicText('https://example.com/', { resolve, request })).rejects.toThrow(/Too many redirects/);
    expect(request.mock.calls.length).toBeGreaterThan(1);
  });

  it('skips advertising redirects and result blocks without a result link', () => {
    const html = '<div class="result"><span>no link</span></div>'
      + '<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>'
      + '<div class="result"><a class="result__a" href="https://example.org/">Real</a></div>';
    expect(decodeSearchResults(html, 5)).toEqual([{ title: 'Real', url: 'https://example.org/', snippet: '' }]);
  });

  it('writes to stdout by default', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);
    try {
      async function* input() { yield Buffer.from('{'); }
      await expect(runHelper(input())).resolves.toBe(1);
      expect(String(spy.mock.calls[0][0])).toMatch(/^\{"ok":false/);
    } finally {
      spy.mockRestore();
    }
  });
});
