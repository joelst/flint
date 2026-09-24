import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BUFFERED_RESPONSE_TIMEOUT_MS,
  stripHopByHopHeaders,
  isJsonContentType,
  modelRejection,
  rejectionNames,
  shouldBufferBody,
  extractModelName,
  rewriteModelName,
  rewriteStatusEndpoints,
  formatPublicEndpoint,
  isLoopbackAddress,
} from './gateway-http.js';
import { buildModelIndex, resolveModelId, stripVersion } from './model-registry.js';

describe('gateway capture limits', () => {
  it('uses a five-second buffered response deadline', () => {
    expect(DEFAULT_BUFFERED_RESPONSE_TIMEOUT_MS).toBe(5_000);
  });
});

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

describe('modelRejection', () => {
  const legacy = "Failed to handle OpenAI completion: Model 'qwen3-0.6b' is not loaded. "
    + 'Please load the model before getting a ChatClient.';
  // SDK 2.0.1, probed live (#162).
  const notLoaded = "Model not loaded: Model 'qwen3-0.6b-generic-cpu:4' must be loaded before inference";
  const notFound = "Model not found: No model matching 'qwen3-0.6b'";

  it('classifies the SDK 2.0.1 not-loaded 400 with its model name', () => {
    expect(modelRejection(400, notLoaded)).toEqual({ kind: 'not-loaded', model: 'qwen3-0.6b-generic-cpu:4' });
    expect(modelRejection(400, JSON.stringify({ error: { message: notLoaded } })))
      .toEqual({ kind: 'not-loaded', model: 'qwen3-0.6b-generic-cpu:4' });
  });

  it('classifies the SDK 2.0.1 not-found 404 with its model name', () => {
    expect(modelRejection(404, notFound)).toEqual({ kind: 'not-found', model: 'qwen3-0.6b' });
    expect(modelRejection(404, JSON.stringify({ error: { message: notFound } })))
      .toEqual({ kind: 'not-found', model: 'qwen3-0.6b' });
  });

  it('still classifies the SDK 1.x wording', () => {
    expect(modelRejection(400, legacy)).toEqual({ kind: 'not-loaded', model: 'qwen3-0.6b' });
    expect(modelRejection(400, JSON.stringify({ error: { message: legacy } })))
      .toEqual({ kind: 'not-loaded', model: 'qwen3-0.6b' });
  });

  // Captured verbatim from a live SDK 1.x service, apostrophes escaped as it sends them.
  it('reads the exact body the service returns', () => {
    const wire = '{"error":{"message":"Failed to handle OpenAI completion: Model '
      + '\\u0027qwen3.5-4b-generic-cpu:3\\u0027 is not loaded. Please load the model '
      + 'before getting a ChatClient.","type":"invalid_request_error","code":null}}';
    expect(modelRejection(400, wire)?.model).toBe('qwen3.5-4b-generic-cpu:3');
  });

  // Autoload must not silently stop working the first time Foundry rewords the sentence
  // around the model name.
  it('survives rewording around the quoted model name', () => {
    expect(modelRejection(400, "Model 'phi-4' is not loaded.")?.model).toBe('phi-4');
    expect(modelRejection(400, "Request failed: Model 'phi-4' is not loaded yet, sorry.")?.model).toBe('phi-4');
    expect(modelRejection(400, "Model 'phi-4' must be loaded before inference (hint)")?.model).toBe('phi-4');
  });

  // A JSON body of some other shape must fall back to the raw text, not be discarded.
  it('reads the raw body when the JSON is not the expected shape', () => {
    expect(modelRejection(400, JSON.stringify({ detail: legacy }))?.model).toBe('qwen3-0.6b');
    expect(modelRejection(400, JSON.stringify({ error: { message: 'bad request' } }))).toBeNull();
  });

  it('does not cross statuses', () => {
    expect(modelRejection(500, legacy)).toBeNull();
    expect(modelRejection(404, legacy)).toBeNull();
    expect(modelRejection(404, notLoaded)).toBeNull();
    expect(modelRejection(400, notFound)).toBeNull();
  });

  it('ignores unrelated 400s and 404s', () => {
    expect(modelRejection(400, 'model field is required')).toBeNull();
    expect(modelRejection(400, 'Model validation failed because it is not loaded')).toBeNull();
    expect(modelRejection(400, 'The model is not loaded')).toBeNull();
    expect(modelRejection(400, '')).toBeNull();
    expect(modelRejection(404, 'Not Found')).toBeNull();
    expect(modelRejection(404, JSON.stringify({ error: { message: "Route '/v1/nope' not found" } }))).toBeNull();
  });
});

describe('rejectionNames', () => {
  it('requires the quoted model to be the one this request sent, ignoring case', () => {
    const rejection = modelRejection(404, "Model not found: No model matching 'Qwen3-0.6b'");
    expect(rejectionNames(rejection, 'qwen3-0.6b')).toBe(true);
    expect(rejectionNames(rejection, ' QWEN3-0.6B ')).toBe(true);
    expect(rejectionNames(rejection, 'qwen3-0.6b-generic-cpu:4')).toBe(false);
    expect(rejectionNames(rejection, null)).toBe(false);
    expect(rejectionNames(null, 'qwen3-0.6b')).toBe(false);
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

describe('rewriteModelName', () => {
  it('replaces the model field and preserves everything else', () => {
    const body = JSON.stringify({
      model: 'qwen2.5-0.5b',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_tokens: 8,
    });
    const out = rewriteModelName(body, 'qwen2.5-0.5b-instruct-generic-cpu:4');
    const parsed = JSON.parse(out as string);
    expect(parsed.model).toBe('qwen2.5-0.5b-instruct-generic-cpu:4');
    expect(parsed.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(parsed.stream).toBe(true);
    expect(parsed.max_tokens).toBe(8);
  });

  it('returns the original body untouched when the name already matches', () => {
    const body = '{"model":"a","messages":[]}';
    expect(rewriteModelName(body, 'a')).toBe(body);
  });

  it('adds the field when the body omits it', () => {
    expect(JSON.parse(rewriteModelName('{"messages":[]}', 'a') as string).model).toBe('a');
  });

  // The caller falls back to sending the body untouched, so null must mean "cannot".
  it('returns null when the body is not a JSON object', () => {
    expect(rewriteModelName('not json', 'a')).toBe(null);
    expect(rewriteModelName('[1,2]', 'a')).toBe(null);
    expect(rewriteModelName('"str"', 'a')).toBe(null);
    expect(rewriteModelName('null', 'a')).toBe(null);
  });

  it('returns null for an unusable replacement name', () => {
    expect(rewriteModelName('{"model":"a"}', '')).toBe(null);
    expect(rewriteModelName('{"model":"a"}', '   ')).toBe(null);
    expect(rewriteModelName(null as any, 'a')).toBe(null);
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

describe('formatPublicEndpoint', () => {
  it('uses loopback for all-interface binds', () => {
    expect(formatPublicEndpoint('0.0.0.0', 5273)).toBe('http://127.0.0.1:5273');
    expect(formatPublicEndpoint(' :: ', 5273)).toBe('http://127.0.0.1:5273');
  });

  it('publishes a specific interface address', () => {
    expect(formatPublicEndpoint(' 192.168.1.20 ', 5273)).toBe('http://192.168.1.20:5273');
    expect(formatPublicEndpoint('::1', 5273)).toBe('http://localhost:5273');
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
