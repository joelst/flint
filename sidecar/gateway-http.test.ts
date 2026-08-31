import { describe, it, expect } from 'vitest';
import {
  stripHopByHopHeaders,
  isJsonContentType,
  isModelNotLoadedError,
  shouldBufferBody,
  extractModelName,
  rewriteStatusEndpoints,
  isLoopbackAddress,
} from './gateway-http.js';
import { buildModelIndex, resolveModelId, stripVersion } from './model-registry.js';

describe('stripHopByHopHeaders', () => {
  it('removes the fixed hop-by-hop set', () => {
    const out = stripHopByHopHeaders({
      'content-type': 'application/json',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
    });
    expect(out).toEqual({ 'content-type': 'application/json' });
  });

  it('also removes headers nominated by Connection', () => {
    const out = stripHopByHopHeaders({
      connection: 'X-Custom, X-Other',
      'x-custom': 'a',
      'x-other': 'b',
      'x-keep': 'c',
    });
    expect(out).toEqual({ 'x-keep': 'c' });
  });

  it('drops undefined values and tolerates junk input', () => {
    expect(stripHopByHopHeaders({ a: undefined, b: '1' })).toEqual({ b: '1' });
    expect(stripHopByHopHeaders(null)).toEqual({});
  });
});

describe('isJsonContentType', () => {
  it('matches the media type ignoring parameters', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('APPLICATION/JSON')).toBe(true);
  });

  it('rejects other types', () => {
    expect(isJsonContentType('multipart/form-data')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe('isModelNotLoadedError', () => {
  const real = "Failed to handle OpenAI completion: Model 'qwen3-0.6b' is not loaded. "
    + 'Please load the model before getting a ChatClient.';

  it('matches the Foundry rejection on 400', () => {
    expect(isModelNotLoadedError(400, real)).toBe(true);
    expect(isModelNotLoadedError(400, JSON.stringify({ error: { message: real } }))).toBe(true);
  });

  // Captured verbatim from a live Foundry service, apostrophes escaped as it sends them.
  it('matches the exact body the service returns', () => {
    const wire = '{"error":{"message":"Failed to handle OpenAI completion: Model '
      + '\\u0027qwen3.5-4b-generic-cpu:3\\u0027 is not loaded. Please load the model '
      + 'before getting a ChatClient.","type":"invalid_request_error","code":null}}';
    expect(isModelNotLoadedError(400, wire)).toBe(true);
  });

  // Autoload must not silently stop working the first time Foundry rewords the sentence
  // around the model name.
  it('survives rewording around the quoted model name', () => {
    expect(isModelNotLoadedError(400, "Model 'phi-4' is not loaded.")).toBe(true);
    expect(isModelNotLoadedError(400, "Request failed: Model 'phi-4' is not loaded yet, sorry.")).toBe(true);
  });

  // A JSON body of some other shape must fall back to the raw text, not be discarded.
  it('reads the raw body when the JSON is not the expected shape', () => {
    expect(isModelNotLoadedError(400, JSON.stringify({ detail: real }))).toBe(true);
    expect(isModelNotLoadedError(400, JSON.stringify({ error: { message: 'bad request' } }))).toBe(false);
  });

  it('ignores the same text on other statuses', () => {
    expect(isModelNotLoadedError(500, real)).toBe(false);
    expect(isModelNotLoadedError(404, real)).toBe(false);
  });

  it('ignores unrelated 400s', () => {
    expect(isModelNotLoadedError(400, 'model field is required')).toBe(false);
    expect(isModelNotLoadedError(400, 'Model validation failed because it is not loaded')).toBe(false);
    expect(isModelNotLoadedError(400, 'The model is not loaded')).toBe(false);
    expect(isModelNotLoadedError(400, '')).toBe(false);
  });
});

describe('shouldBufferBody', () => {
  const base = { method: 'POST', contentType: 'application/json', contentLength: 100 };

  it('buffers small JSON posts', () => {
    expect(shouldBufferBody(base)).toBe(true);
  });

  it('does not buffer GET', () => {
    expect(shouldBufferBody({ ...base, method: 'GET' })).toBe(false);
  });

  it('does not buffer audio uploads', () => {
    expect(shouldBufferBody({ ...base, contentType: 'multipart/form-data' })).toBe(false);
  });

  it('refuses a body declared over the cap', () => {
    expect(shouldBufferBody({ ...base, contentLength: 999, maxBytes: 500 })).toBe(false);
  });

  it('allows an undeclared length', () => {
    expect(shouldBufferBody({ ...base, contentLength: null })).toBe(true);
  });
});

describe('extractModelName', () => {
  it('reads the model field', () => {
    expect(extractModelName('{"model":"qwen3-0.6b"}')).toBe('qwen3-0.6b');
  });

  it('returns null for malformed or missing values', () => {
    expect(extractModelName('not json')).toBe(null);
    expect(extractModelName('{"model":"  "}')).toBe(null);
    expect(extractModelName('{"model":42}')).toBe(null);
  });
});

describe('rewriteStatusEndpoints', () => {
  it('replaces the internal endpoint with the public one', () => {
    const body = JSON.stringify({ endpoints: ['http://127.0.0.1:49812'], pipeName: 'x' });
    const out = JSON.parse(rewriteStatusEndpoints(body, 'http://127.0.0.1:5273'));
    expect(out.endpoints).toEqual(['http://127.0.0.1:5273']);
    expect(out.pipeName).toBe('x');
  });

  it('passes through anything unexpected', () => {
    expect(rewriteStatusEndpoints('nope', 'http://x')).toBe('nope');
    expect(rewriteStatusEndpoints('{"a":1}', 'http://x')).toBe('{"a":1}');
  });
});

describe('isLoopbackAddress', () => {
  it('accepts loopback forms including IPv4-mapped IPv6', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects LAN addresses', () => {
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('model registry', () => {
  const models = [
    {
      alias: 'qwen3-0.6b',
      variants: [
        { id: 'qwen3-0.6b-generic-cpu:1', cached: true },
        { id: 'qwen3-0.6b-generic-cpu:4', cached: true },
        { id: 'qwen3-0.6b-cuda-gpu:2', cached: false },
      ],
    },
    {
      alias: 'phi-4-mini',
      variants: [{ id: 'phi-4-mini-cuda-gpu:1', cached: true }],
    },
    { alias: 'never-downloaded', variants: [{ id: 'never-downloaded-cpu:1', cached: false }] },
  ];
  const index = buildModelIndex(models);

  it('strips the version suffix', () => {
    expect(stripVersion('a-b-cpu:4')).toBe('a-b-cpu');
    expect(stripVersion('a-b-cpu')).toBe('a-b-cpu');
  });

  it('resolves the friendly alias without pinning a variant', () => {
    expect(resolveModelId(index, 'qwen3-0.6b')).toEqual({
      alias: 'qwen3-0.6b', variantId: null,
    });
  });

  it('resolves an exact versioned variant id', () => {
    expect(resolveModelId(index, 'qwen3-0.6b-generic-cpu:1')).toEqual({
      alias: 'qwen3-0.6b', variantId: 'qwen3-0.6b-generic-cpu:1',
    });
  });

  it('resolves the advertised versionless id to the highest cached version', () => {
    expect(resolveModelId(index, 'qwen3-0.6b-generic-cpu')).toEqual({
      alias: 'qwen3-0.6b', variantId: 'qwen3-0.6b-generic-cpu:4',
    });
  });

  it('never resolves an uncached variant, so a request cannot trigger a download', () => {
    expect(resolveModelId(index, 'qwen3-0.6b-cuda-gpu')).toBe(null);
    expect(resolveModelId(index, 'never-downloaded')).toBe(null);
  });

  it('returns null for unknown or empty input', () => {
    expect(resolveModelId(index, 'nope')).toBe(null);
    expect(resolveModelId(index, '')).toBe(null);
    expect(resolveModelId(index, undefined)).toBe(null);
  });

  it('tolerates a malformed catalog', () => {
    expect(buildModelIndex(null).size).toBe(0);
    expect(buildModelIndex([{ variants: [] }, { alias: 'x' }]).size).toBe(0);
  });
});
