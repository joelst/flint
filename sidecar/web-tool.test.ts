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
    '::ffff:0:7f00:1',
    '::ffff:0:a00:1',
    '::ffff:0:c0a8:101',
    '::ffff:0:5db8:d822',
    '2001:db8::1',
  ])('denies private or special address %s', (address) => {
    expect(isDeniedAddress(address)).toBe(true);
  });

  it('allows ordinary public IPv4 and IPv6 addresses', () => {
    expect(isDeniedAddress('93.184.216.34')).toBe(false);
    expect(isDeniedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    expect(isDeniedAddress('::ffff:93.184.216.34')).toBe(false);
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
