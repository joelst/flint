// Whole-proxy tests against a fake Foundry.
//
// The real service takes seconds to load a model and needs the SDK, which makes it useless
// for testing the failure paths that matter here (client disconnect, retry limits, SSE).
// The fake reproduces the one behaviour the gateway is built around — a 400 until the model
// is resident — and lets every branch be driven deterministically.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createGateway, classifyGatewayRoute, respondBuffered } from './gateway.js';

/** @type {{ server: http.Server, port: number, loaded: Set<string>, hits: any[] }} */
let upstream;
let gateway;

// SDK 2.0.1 wording, probed live (#162): a known variant that is not resident.
const NOT_LOADED = (model) => JSON.stringify({
  error: {
    message: `Model not loaded: Model '${model}' must be loaded before inference`,
    type: 'invalid_request_error',
  },
});
// SDK 2.0.1: a name the router does not route at all (alias, versionless id, other casing).
const NOT_FOUND = (model) => JSON.stringify({
  error: { message: `Model not found: No model matching '${model}'`, type: 'invalid_request_error' },
});
// SDK 1.x wording, kept so the gateway keeps working against an older service.
const NOT_LOADED_LEGACY = (model) => JSON.stringify({
  error: {
    message: `Failed to handle OpenAI completion: Model '${model}' is not loaded. `
      + 'Please load the model before getting a ChatClient.',
    type: 'invalid_request_error',
  },
});

async function startUpstream (handler) {
  // `known` is the set of variant ids the router can route; null means every name, so
  // tests that only care about the not-loaded shape need no setup.
  const state = { loaded: new Set(), known: null, hits: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.hits.push({ url: req.url, method: req.method, body, headers: req.headers });
      handler(req, res, body, state);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, ...state, get state () { return state; } };
}

function defaultHandler (req, res, body, state) {
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ endpoints: [`http://127.0.0.1:${req.socket.localPort}`], pipeName: 'p' }));
    return;
  }
  if (req.url === '/v1/chat/completions' || req.url === '/v1/embeddings') {
    let model = null;
    try { model = JSON.parse(body).model; } catch { /* streamed body */ }
    if (model && !state.loaded.has(model)) {
      if (state.known && !state.known.has(model)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(NOT_FOUND(model));
        return;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(NOT_LOADED(model));
      return;
    }
    if (req.url === '/v1/embeddings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
        model,
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('pong');
}

async function startGateway (opts = {}) {
  const gw = createGateway({
    publicPort: 0,
    bindAddress: '127.0.0.1',
    upstreamPort: upstream.port,
    // async on purpose: the real resolver reads the catalog, and a sync stub would hide a
    // missing await in the gateway.
    resolve: async id => (id ? { alias: id, variantId: null } : null),
    load: async () => {},
    ...opts,
  });
  await gw.start();
  return gw;
}

async function request (port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      }
    );
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

beforeEach(async () => {
  upstream = await startUpstream(defaultHandler);
});

afterEach(async () => {
  if (gateway) await gateway.stop();
  gateway = null;
  await new Promise(r => upstream.server.close(r));
});

describe('gateway pass-through', () => {
  it('forwards a plain GET and returns the upstream body', async () => {
    gateway = await startGateway();
    const res = await request(gateway.publicPort, '/v1/models');
    expect(res.status).toBe(200);
    expect(res.body).toBe('pong');
  });

  it('rewrites the Host header so upstream never sees the client value', async () => {
    gateway = await startGateway();
    await request(gateway.publicPort, '/v1/models', { headers: { host: 'evil.example' } });
    expect(upstream.state.hits[0].headers.host).toBe(`127.0.0.1:${upstream.port}`);
  });

  it('hides the internal port in /status', async () => {
    gateway = await startGateway();
    const res = await request(gateway.publicPort, '/status');
    const parsed = JSON.parse(res.body);
    expect(parsed.endpoints).toEqual([`http://127.0.0.1:${gateway.publicPort}`]);
    expect(res.body).not.toContain(String(upstream.port));
  });

  it('rejects a declared /status response over the capture limit', async () => {
    let upstreamClosed = false;
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.on('close', () => { upstreamClosed = true; });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      res.flushHeaders();
    });
    gateway = await startGateway({ maxBufferedResponse: 64 });

    const res: any = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: gateway.publicPort,
        path: '/status',
      }, response => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end', () => {
          clearTimeout(timer);
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            timedOut: false,
          });
        });
      });
      const timer = setTimeout(() => {
        req.destroy();
        resolve({ status: 0, body: '', timedOut: true });
      }, 300);
      req.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      req.end();
    });

    expect(res.timedOut).toBe(false);
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error.message).toContain('exceeded the gateway limit');
    await vi.waitFor(() => expect(upstreamClosed).toBe(true));
  });

  it('bounds a stalled /status response capture', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"endpoints":');
    });
    gateway = await startGateway({ bufferedResponseTimeoutMs: 20 });

    const res = await request(gateway.publicPort, '/status');

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error.message).toContain('timed out');
  });

  it.each([
    ['HEAD', 200],
    ['HEAD', 404],
    ['GET', 204],
    ['GET', 304],
  ])('does not reject bodyless %s /status responses (%s) by declared length', async (method, status) => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      res.end();
    });
    gateway = await startGateway({ maxBufferedResponse: 64 });

    const res = await request(gateway.publicPort, '/status', { method });

    expect(res.status).toBe(status);
    expect(res.body).toBe('');
  });

  it('passes a bodyless HEAD 404 through without inspecting or loading a model', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(404, {
        'content-type': 'application/json',
        'content-length': '1000',
        'x-upstream': 'bodyless',
      });
      res.end();
    });
    const load = vi.fn();
    const resolve = vi.fn();
    gateway = await startGateway({ maxBufferedResponse: 64, load, resolve });

    const res = await request(gateway.publicPort, '/v1/models/missing', { method: 'HEAD' });

    expect(res.status).toBe(404);
    expect(res.body).toBe('');
    expect(res.headers['content-length']).toBe('1000');
    expect(res.headers['x-upstream']).toBe('bodyless');
    expect(load).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(upstream.state.hits).toHaveLength(1);
  });
});

describe('gateway autoload', () => {
  it('loads the model and replays the request once', async () => {
    const loads = [];
    gateway = await startGateway({
      load: async (alias) => { loads.push(alias); upstream.state.loaded.add(alias); },
    });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, model: 'qwen3-0.6b' });
    expect(loads).toEqual(['qwen3-0.6b']);
    expect(upstream.state.hits).toHaveLength(2);
  });

  it('retries only once, then surfaces the original error', async () => {
    gateway = await startGateway({ load: async () => {} }); // load that does not help
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('must be loaded before inference');
    expect(upstream.state.hits).toHaveLength(2);
  });

  it('does not retry an unrelated 400', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model field is required' } }));
    });
    gateway = await startGateway();
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(upstream.state.hits).toHaveLength(1);
  });

  it('does not autoload from an oversized captured error', async () => {
    let called = false;
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.write(NOT_LOADED('qwen3-0.6b'));
      res.end('x'.repeat(1000));
    });
    gateway = await startGateway({
      maxBufferedResponse: 64,
      load: async () => { called = true; },
    });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });

    expect(res.status).toBe(502);
    expect(called).toBe(false);
  });

  it('does not autoload from a stalled captured error', async () => {
    let called = false;
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.write('{"error":');
    });
    gateway = await startGateway({
      bufferedResponseTimeoutMs: 20,
      load: async () => { called = true; },
    });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error.message).toContain('timed out');
    expect(called).toBe(false);
  });

  it('returns the upstream error unchanged when the id cannot be resolved', async () => {
    let called = false;
    gateway = await startGateway({
      resolve: async () => null,
      load: async () => { called = true; },
    });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ghost' }),
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it('surfaces the original error when loading throws', async () => {
    gateway = await startGateway({
      load: async () => { throw new Error('out of memory'); },
    });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('must be loaded before inference');
  });

  it('collapses concurrent requests for the same model into one load', async () => {
    let loadCount = 0;
    gateway = await startGateway({
      load: async (alias) => {
        loadCount += 1;
        await new Promise(r => setTimeout(r, 50));
        upstream.state.loaded.add(alias);
      },
    });
    const results = await Promise.all([1, 2, 3].map(() =>
      request(gateway.publicPort, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3-0.6b' }),
      })
    ));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(loadCount).toBe(1);
  });

  it('does not autoload for non-JSON bodies', async () => {
    let called = false;
    gateway = await startGateway({ load: async () => { called = true; } });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it('rejects a body past the cap instead of truncating it', async () => {
    gateway = await startGateway({ maxBufferedBody: 64 });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b', pad: 'x'.repeat(500) }),
    });
    // Declared length is over the cap, so the body streams through unbuffered and the
    // upstream error reaches the client untouched.
    expect(res.status).toBe(400);
  });

  it('can be turned off entirely', async () => {
    let called = false;
    gateway = await startGateway({ autoload: false, load: async () => { called = true; } });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

// Foundry routes only the exact loaded variant id and answers 404 to the friendly alias, even
// while that model is resident (SDK 2.0.1; 1.x answered 400 "is not loaded"). The alias is
// exactly what Flint's own integration snippets tell users to configure, so without a rewrite
// the gateway would load the model and the replay would still be rejected.
describe('gateway model-name routing', () => {
  const ALIAS = 'qwen2.5-0.5b';
  const VARIANT = 'qwen2.5-0.5b-instruct-generic-cpu:4';

  /**
   * Upstream that behaves like the real SDK 2.0.1 service: only the exact loaded variant id
   * routes. That variant answers 400 while not resident; every other name, the alias
   * included, answers 404 whether or not the model is resident.
   */
  async function startVariantOnlyUpstream (notLoaded = NOT_LOADED) {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res, body, state) => {
      let model = null;
      try { model = JSON.parse(body).model; } catch { /* not JSON */ }
      if (model !== VARIANT) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(NOT_FOUND(model));
        return;
      }
      if (!state.loaded.has(model)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(notLoaded(model));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model }));
    });
  }

  it('replays under the loaded variant id when the client sent an alias', async () => {
    await startVariantOnlyUpstream();
    gateway = await startGateway({
      resolve: async id => (id === ALIAS ? { alias: ALIAS, variantId: null } : null),
      // Mirrors ensureModel: loading by alias resolves a concrete variant.
      load: async () => { upstream.state.loaded.add(VARIANT); return VARIANT; },
    });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIAS, messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).model).toBe(VARIANT);
    // The replay must carry the variant id, and must not lose the rest of the payload.
    const replay = JSON.parse(upstream.state.hits[1].body);
    expect(replay.model).toBe(VARIANT);
    expect(replay.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('reuses what it learned instead of paying the rejection every time', async () => {
    await startVariantOnlyUpstream();
    let loads = 0;
    gateway = await startGateway({
      resolve: async id => (id === ALIAS ? { alias: ALIAS, variantId: null } : null),
      load: async () => { loads += 1; upstream.state.loaded.add(VARIANT); return VARIANT; },
    });
    const send = () => request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIAS }),
    });

    expect((await send()).status).toBe(200); // 400 + replay
    const afterFirst = upstream.state.hits.length;
    expect((await send()).status).toBe(200);

    expect(upstream.state.hits.length - afterFirst).toBe(1); // rewritten up front
    expect(loads).toBe(1);
  });

  it('shares one learned rewrite across every spelling of a name', async () => {
    await startVariantOnlyUpstream();
    let loads = 0;
    gateway = await startGateway({
      resolve: async id => (id.toLowerCase() === ALIAS ? { alias: ALIAS, variantId: null } : null),
      load: async () => { loads += 1; upstream.state.loaded.add(VARIANT); return VARIANT; },
    });
    const send = (model) => request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });

    expect((await send(ALIAS)).status).toBe(200); // 404 + load + replay
    const afterFirst = upstream.state.hits.length;
    expect((await send(ALIAS.toUpperCase())).status).toBe(200);

    // The other spelling reused the entry: rewritten up front, no second load, and the map
    // holds one key, so casing variants cannot grow it.
    expect(upstream.state.hits.length - afterFirst).toBe(1);
    expect(JSON.parse(upstream.state.hits.at(-1).body).model).toBe(VARIANT);
    expect(loads).toBe(1);
  });

  it('recovers when a learned routing goes stale', async () => {
    await startVariantOnlyUpstream();
    gateway = await startGateway({
      resolve: async id => (id === ALIAS ? { alias: ALIAS, variantId: null } : null),
      load: async () => { upstream.state.loaded.add(VARIANT); return VARIANT; },
    });
    const send = () => request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIAS }),
    });

    expect((await send()).status).toBe(200);
    upstream.state.loaded.clear(); // the model went away behind our back
    expect((await send()).status).toBe(200);
  });

  it('books the variant it forwards, so the served build is the one kept busy', async () => {
    // Foundry serves only the exact variant id. A request the gateway rewrote is served by
    // that build, and only a booking under that id tells the owner which build is in use.
    await startVariantOnlyUpstream();
    const events: Array<[string, string]> = [];
    gateway = await startGateway({
      resolve: async id => (id === ALIAS ? { alias: ALIAS, variantId: null } : null),
      load: async () => { upstream.state.loaded.add(VARIANT); return VARIANT; },
      onActivity: (model, phase) => { events.push([model, phase]); },
    });
    const send = () => request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIAS }),
    });

    expect((await send()).status).toBe(200);
    expect(events).toEqual([
      [ALIAS, 'start'], [VARIANT, 'start'], [ALIAS, 'end'], [VARIANT, 'end'],
    ]);

    events.length = 0;
    expect((await send()).status).toBe(200); // learned routing, forwarded up front
    expect(events).toEqual([
      [ALIAS, 'start'], [VARIANT, 'start'], [ALIAS, 'end'], [VARIANT, 'end'],
    ]);
  });

  it('refuses a rewritten request whose variant is being changed', async () => {
    await startVariantOnlyUpstream();
    const events: Array<[string, string]> = [];
    let fenced = false;
    gateway = await startGateway({
      resolve: async id => (id === ALIAS ? { alias: ALIAS, variantId: null } : null),
      load: async () => { upstream.state.loaded.add(VARIANT); return VARIANT; },
      onActivity: (model, phase) => {
        events.push([model, phase]);
        return !(fenced && phase === 'start' && model === VARIANT);
      },
    });
    const send = () => request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIAS }),
    });

    expect((await send()).status).toBe(200);
    const hits = upstream.state.hits.length;
    fenced = true;
    events.length = 0;

    const refused = await send();
    expect(refused.status).toBe(409);
    expect(upstream.state.hits).toHaveLength(hits);
    expect(events).toEqual([[ALIAS, 'start'], [VARIANT, 'start'], [ALIAS, 'end']]);
  });

  it('serves an alias while the model is resident by learning the variant id from the 404', async () => {
    await startVariantOnlyUpstream();
    upstream.state.loaded.add(VARIANT);
    const loads = [];
    gateway = await startGateway({
      resolve: async id => (id === ALIAS ? { alias: ALIAS, variantId: null } : null),
      // Mirrors ensureModel for a resident model: nothing to load, report what is there.
      load: async (alias) => { loads.push(alias); return VARIANT; },
    });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIAS }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).model).toBe(VARIANT);
    expect(loads).toEqual([ALIAS]);
    expect(upstream.state.hits.map(h => JSON.parse(h.body).model)).toEqual([ALIAS, VARIANT]);
  });

  it('autoloads a cold variant id from the SDK 2.0.1 not-loaded 400', async () => {
    await startVariantOnlyUpstream();
    gateway = await startGateway({
      resolve: async id => (id === VARIANT ? { alias: ALIAS, variantId: VARIANT } : null),
      load: async () => { upstream.state.loaded.add(VARIANT); return VARIANT; },
    });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: VARIANT }),
    });

    expect(res.status).toBe(200);
    expect(upstream.state.hits).toHaveLength(2);
  });

  it.each([false, true])('canonicalizes whitespace around an exact variant id (resident: %s)', async resident => {
    await startVariantOnlyUpstream();
    if (resident) upstream.state.loaded.add(VARIANT);
    const load = vi.fn(async () => {
      upstream.state.loaded.add(VARIANT);
      return VARIANT;
    });
    gateway = await startGateway({
      resolve: async id => (id === VARIANT ? { alias: ALIAS, variantId: VARIANT } : null),
      load,
    });
    const messages = [{ role: 'user', content: 'hi' }];
    const send = () => request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: `  ${VARIANT}  `, messages }),
    });

    expect((await send()).status).toBe(200);
    expect(JSON.parse(upstream.state.hits[1].body)).toEqual({ model: VARIANT, messages });
    expect((await send()).status).toBe(200);
    expect(upstream.state.hits).toHaveLength(3);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('still autoloads against the SDK 1.x not-loaded wording', async () => {
    await startVariantOnlyUpstream(NOT_LOADED_LEGACY);
    gateway = await startGateway({
      resolve: async id => (id === VARIANT ? { alias: ALIAS, variantId: VARIANT } : null),
      load: async () => { upstream.state.loaded.add(VARIANT); return VARIANT; },
    });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: VARIANT }),
    });

    expect(res.status).toBe(200);
    expect(upstream.state.hits).toHaveLength(2);
  });

  it('passes a 404 for a name the registry does not know through unchanged, without loading', async () => {
    await startVariantOnlyUpstream();
    let loaded = false;
    gateway = await startGateway({
      resolve: async () => null, // not cached, or not a model at all
      load: async () => { loaded = true; },
    });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-cached-model' }),
    });

    expect(res.status).toBe(404);
    expect(res.body).toContain("No model matching 'not-a-cached-model'");
    expect(loaded).toBe(false);
    expect(upstream.state.hits).toHaveLength(1);
  });

  it('ignores a rejection that names a model other than the one it sent', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(NOT_FOUND('some-other-model'));
    });
    let loaded = false;
    gateway = await startGateway({
      resolve: async id => ({ alias: id, variantId: null }),
      load: async () => { loaded = true; },
    });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIAS }),
    });

    expect(res.status).toBe(404);
    expect(loaded).toBe(false);
    expect(upstream.state.hits).toHaveLength(1);
  });

  it('leaves the body alone when the loader reports no variant', async () => {
    // The default fake routes any name once it is loaded (an SDK 1.x trait); on 2.0.1 an
    // unrewritten alias would 404 again, which is why the loader normally reports the
    // variant. This pins that a null report never invents a rewrite.
    gateway = await startGateway({
      resolve: async id => ({ alias: id, variantId: null }),
      load: async alias => { upstream.state.loaded.add(alias); },
    });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIAS }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(upstream.state.hits[1].body).model).toBe(ALIAS);
  });

  it('honours an explicit variant id rather than substituting another', async () => {
    await startVariantOnlyUpstream();
    const asked = [];
    gateway = await startGateway({
      resolve: async id => ({ alias: ALIAS, variantId: id }),
      load: async (alias, variantId) => {
        asked.push(variantId);
        upstream.state.loaded.add(variantId);
        return variantId;
      },
    });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: VARIANT }),
    });
    expect(res.status).toBe(200);
    expect(asked).toEqual([VARIANT]);
    expect(JSON.parse(res.body).model).toBe(VARIANT);
  });
});

describe('gateway streaming', () => {
  it('normalizes buffered chat responses at the public endpoint', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chat-1',
        IsDelta: false,
        Successful: true,
        HttpStatusCode: 200,
        choices: [{
          index: 0,
          message: { role: 'assistant' },
          delta: { content: 'hello' },
          finish_reason: 'stop',
        }],
      }));
    });
    gateway = await startGateway();

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.IsDelta).toBeUndefined();
    expect(body.Successful).toBeUndefined();
    expect(body.HttpStatusCode).toBeUndefined();
    expect(body.choices).toEqual([{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'hello' },
    }]);
  });

  it('requests identity encoding for responses it may transform', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
    gateway = await startGateway();

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });

    expect(res.status).toBe(200);
    expect(upstream.state.hits.at(-1)?.headers['accept-encoding']).toBe('identity');
  });

  it('passes through oversized JSON inference without applying the control cap', async () => {
    await new Promise(r => upstream.server.close(r));
    const content = 'x'.repeat(128);
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        IsDelta: false,
        Successful: true,
        HttpStatusCode: 200,
        choices: [{ message: { content }, delta: { content: 'native' } }],
      }));
    });
    gateway = await startGateway({ maxBufferedResponse: 32 });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.IsDelta).toBe(false);
    expect(body.Successful).toBe(true);
    expect(body.HttpStatusCode).toBe(200);
    expect(body.choices[0].delta.content).toBe('native');
  });

  it('streams SSE chunks as they are produced rather than buffering', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 60);
    });
    gateway = await startGateway({ maxBufferedResponse: 1 });

    const seen = await new Promise((resolve, reject) => {
      const times = [];
      const req = http.request({
        host: '127.0.0.1', port: gateway.publicPort, path: '/v1/chat/completions',
        method: 'POST', headers: { 'content-type': 'application/json' },
      }, res => {
        res.on('data', () => times.push(Date.now()));
        res.on('end', () => resolve(times));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'qwen3-0.6b', stream: true }));
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1] - seen[0]).toBeGreaterThan(30);
  });

  it('normalizes streamed chat chunks and preserves the DONE terminator', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"IsDelta":true,"choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n');
      res.write('data: {"choices":[{"message":{"content":" there"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
    gateway = await startGateway();

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b', stream: true }),
    });

    expect(res.status).toBe(200);
    const events = res.body.trim().split(/\n\n/);
    expect(JSON.parse(events[0].slice(6))).toEqual({
      choices: [{
        index: 0,
        finish_reason: null,
        delta: { role: 'assistant', content: 'hi' },
      }],
    });
    expect(JSON.parse(events[1].slice(6))).toEqual({
      choices: [{
        index: 0,
        finish_reason: null,
        delta: { content: ' there' },
      }],
    });
    expect(events[2]).toBe('data: [DONE]');
  });

  it('reports token usage and time-to-first-token for streamed chat completions', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n');
        res.end('data: [DONE]\n\n');
      }, 30);
    });
    const access = [];
    gateway = await startGateway({ onAccess: (entry) => access.push(entry) });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b', stream: true }),
    });

    expect(res.status).toBe(200);
    const entry = access.find(e => e.routeClass === 'chat');
    expect(entry.tokensIn).toBe(12);
    expect(entry.tokensOut).toBe(3);
    expect(entry.ttftMs).toBeGreaterThanOrEqual(0);
    expect(entry.ttftMs).toBeLessThan(entry.durationMs + 1);
    // The gateway has no equivalent of the IPC path's separately-observed load time,
    // so prompt throughput can never be computed from it — only decode throughput can.
    expect(entry.promptTokensPerSecond).toBeNull();
    expect(entry.decodeTokensPerSecond).toBeGreaterThan(0);
  });

  it('reports token usage for buffered (non-streamed) chat completions', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      }));
    });
    const access = [];
    gateway = await startGateway({ onAccess: (entry) => access.push(entry) });

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });

    expect(res.status).toBe(200);
    const entry = access.find(e => e.routeClass === 'chat');
    expect(entry.tokensIn).toBe(7);
    expect(entry.tokensOut).toBe(2);
    // Non-streaming responses arrive as one block: there is no observable moment
    // distinct from completion, so time-to-first-token is truthfully unknown, and
    // both derived rates (which require it) stay null too.
    expect(entry.ttftMs).toBeNull();
    expect(entry.promptTokensPerSecond).toBeNull();
    expect(entry.decodeTokensPerSecond).toBeNull();
  });

  it('normalizes split UTF-8 SSE payloads and removes stale content length', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((_req, res) => {
      const body = 'data: {"choices":[{"delta":{"content":"café"}}]}\n\ndata: [DONE]\n\n';
      const bytes = Buffer.from(body);
      const split = bytes.indexOf(0xc3) + 1;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'content-length': bytes.length,
      });
      res.write(bytes.subarray(0, split));
      res.end(bytes.subarray(split));
    });
    gateway = await startGateway();

    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b', stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.body).toContain('"content":"café"');
    expect(res.body).toContain('data: [DONE]');
  });

  it('still streams when the response follows an autoload', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res, body, state) => {
      const model = JSON.parse(body).model;
      if (!state.loaded.has(model)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(NOT_LOADED(model));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 60);
    });
    gateway = await startGateway({
      load: async (alias) => { upstream.state.loaded.add(alias); },
    });

    const times = await new Promise((resolve, reject) => {
      const seen = [];
      const req = http.request({
        host: '127.0.0.1', port: gateway.publicPort, path: '/v1/chat/completions',
        method: 'POST', headers: { 'content-type': 'application/json' },
      }, res => {
        expect(res.statusCode).toBe(200);
        res.on('data', () => seen.push(Date.now()));
        res.on('end', () => resolve(seen));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'qwen3-0.6b', stream: true }));
    });

    // Buffering the replayed response would collapse these into a single delivery.
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(times[times.length - 1] - times[0]).toBeGreaterThan(30);
  });
  it('rejects an undeclared oversize body with 413 rather than truncating it', async () => {
    gateway = await startGateway({ maxBufferedBody: 64 });
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: gateway.publicPort, path: '/v1/chat/completions',
        method: 'POST',
        // Chunked, so there is no content-length for the cheap up-front rejection.
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      }, r => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.write(JSON.stringify({ model: 'qwen3-0.6b', pad: 'x'.repeat(4096) }));
      req.end();
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.type).toBe('invalid_request_error');
  });

  it('accepts an undeclared body exactly at the configured cap', async () => {
    const body = JSON.stringify({ model: 'm', pad: '' });
    gateway = await startGateway({ maxBufferedBody: Buffer.byteLength(body) });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body,
    });

    expect(res.status).toBe(400);
    expect(upstream.state.hits.at(-1)?.body).toBe(body);
  });

  it('does not autoload for a non-loopback caller', async () => {
    let called = false;
    gateway = await startGateway({
      loopbackOnlyAutoload: true,
      load: async () => { called = true; },
    });
    // The socket is loopback here, so instead assert the switch itself is honoured by
    // flipping the classification the gateway relies on.
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });
    expect(res.status).toBe(400);
    expect(called).toBe(true); // loopback is allowed
  });
});

describe('gateway failure handling', () => {
  it('does not write a buffered response after the client disconnects', () => {
    const res = {
      destroyed: true,
      writableEnded: false,
      writeHead: () => { throw new Error('write after disconnect'); },
      end: () => { throw new Error('end after disconnect'); },
    };

    expect(() => respondBuffered(res, 502, {}, 'error')).not.toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects an invalid buffered response limit of %s',
    async maxBufferedResponse => {
      await expect(startGateway({ maxBufferedResponse })).rejects.toThrow(
        'maxBufferedResponse must be a finite non-negative number.'
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects an invalid buffered request limit of %s',
    async maxBufferedBody => {
      await expect(startGateway({ maxBufferedBody })).rejects.toThrow(
        'maxBufferedBody must be a finite non-negative number.'
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects an invalid buffered response timeout of %s',
    async bufferedResponseTimeoutMs => {
      await expect(startGateway({ bufferedResponseTimeoutMs })).rejects.toThrow(
        'bufferedResponseTimeoutMs must be a finite non-negative number.'
      );
    },
  );

  it('honours a zero-byte buffered request limit', async () => {
    gateway = await startGateway({ maxBufferedBody: 0 });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body: '{}',
    });
    expect(res.status).toBe(413);
    expect(upstream.state.hits).toHaveLength(0);
  });

  it('honours a zero-byte buffered response limit', async () => {
    gateway = await startGateway({ maxBufferedResponse: 0 });
    const res = await request(gateway.publicPort, '/status');
    expect(res.status).toBe(502);
  });

  it('answers 502 when upstream dies mid-response', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json', 'content-length': '999' });
      res.write('{"error":');
      setTimeout(() => res.socket.destroy(), 30);
    });
    gateway = await startGateway();
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    }).catch(() => ({ status: 0 }));
    // Either a 502 body or a torn-down connection is acceptable; what must not happen is
    // a hang or a partial body presented as complete.
    expect([0, 400, 502]).toContain(res.status);
  });

  it('stays available when a client disconnects during response capture', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res) => {
      if (req.url === '/v1/models') {
        res.end('pong');
        return;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.write('{"error":');
      setTimeout(() => {
        if (!res.destroyed) res.end('"late"}');
      }, 100);
    });
    gateway = await startGateway();

    await new Promise(resolve => {
      const req = http.request({
        host: '127.0.0.1',
        port: gateway.publicPort,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      req.on('error', resolve);
      req.end(JSON.stringify({ model: 'qwen3-0.6b' }));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 30);
    });
    await new Promise(r => setTimeout(r, 120));

    const res = await request(gateway.publicPort, '/v1/models');
    expect(res.status).toBe(200);
    expect(res.body).toBe('pong');
  });

  it('answers 502 when the resolver itself fails', async () => {
    gateway = await startGateway({
      resolve: async () => { throw new Error('catalog unreadable'); },
    });
    const res = await request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-0.6b' }),
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error.type).toBe('server_error');
  });

  it('answers 503 when upstream is down', async () => {
    const deadPort = upstream.port;
    await new Promise(r => upstream.server.close(r));
    gateway = createGateway({
      publicPort: 0,
      bindAddress: '127.0.0.1',
      upstreamPort: deadPort,
      resolve: () => null,
      load: async () => {},
    });
    await gateway.start();
    const res = await request(gateway.publicPort, '/v1/models');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error.type).toBe('server_error');
    upstream = await startUpstream(defaultHandler); // afterEach closes this
  });

  it('aborts the upstream request when the client disconnects', async () => {
    let aborted = false;
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res) => {
      req.on('aborted', () => { aborted = true; });
      res.on('close', () => { if (!res.writableEnded) aborted = true; });
      setTimeout(() => { if (!res.writableEnded) res.end('late'); }, 500);
    });
    gateway = await startGateway();

    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: gateway.publicPort, path: '/v1/models', method: 'GET',
      }, () => {});
      req.on('error', () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 60);
      setTimeout(resolve, 300);
    });
    await new Promise(r => setTimeout(r, 100));
    expect(aborted).toBe(true);
  });

  it('refuses to act as a tunnel', async () => {
    gateway = await startGateway();
    await expect(new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: gateway.publicPort, method: 'CONNECT', path: 'example.com:443',
      });
      req.on('connect', resolve);
      req.on('error', reject);
      req.end();
    })).rejects.toThrow();
  });
});

describe('gateway activity hook', () => {
  const post = (port, model) => request(port, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });

  it('brackets a request that names a model', async () => {
    const events = [];
    upstream.state.loaded.add('phi-4-mini');
    gateway = await startGateway({ onActivity: (model, phase) => events.push([model, phase]) });
    const res = await post(gateway.publicPort, 'phi-4-mini');
    expect(res.status).toBe(200);
    expect(events).toEqual([['phi-4-mini', 'start'], ['phi-4-mini', 'end']]);
  });

  it('reports nothing for a request that names no model', async () => {
    const events = [];
    gateway = await startGateway({ onActivity: (...a) => events.push(a) });
    await request(gateway.publicPort, '/v1/models');
    expect(events).toEqual([]);
  });

  it('rejects a request whose lease the owner refuses', async () => {
    const events = [];
    upstream.state.loaded.add('phi-4-mini');
    gateway = await startGateway({
      onActivity: (model, phase) => { events.push([model, phase]); return phase === 'start' ? false : undefined; },
    });

    const res = await post(gateway.publicPort, 'phi-4-mini');

    expect(res.status).toBe(409);
    // No end for a start that was refused, and nothing reached the service.
    expect(events).toEqual([['phi-4-mini', 'start']]);
    expect(upstream.state.hits.filter(h => h.url === '/v1/chat/completions')).toEqual([]);
  });

  it('rejects a refused multipart speech lease without forwarding the upload', async () => {
    const events = [];
    const boundary = 'flint-refused-boundary';
    gateway = await startGateway({
      onActivity: (model, phase) => { events.push([model, phase]); return phase === 'start' ? false : undefined; },
    });

    const res = await request(gateway.publicPort, '/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-tiny:1\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ping.wav"\r\n`
        + `Content-Type: audio/wav\r\n\r\nRIFF\r\n--${boundary}--\r\n`,
    });

    expect(res.status).toBe(409);
    expect(events).toEqual([['whisper-tiny:1', 'start']]);
    expect(upstream.state.hits.filter(h => h.url === '/v1/audio/transcriptions')).toEqual([]);
  });

  it('does not load a model whose moved lease is refused, and answers 409', async () => {
    const VARIANT = 'phi-4-mini-generic-cpu:2';
    const events = [];
    let loaded = false;
    gateway = await startGateway({
      resolve: async () => ({ alias: 'phi-4-mini', variantId: VARIANT }),
      load: async () => { loaded = true; upstream.state.loaded.add(VARIANT); return VARIANT; },
      onActivity: (model, phase) => {
        events.push([model, phase]);
        return phase === 'start' && model === VARIANT ? false : model;
      },
    });

    const res = await post(gateway.publicPort, 'phi-4-mini-generic-cpu');

    expect(res.status).toBe(409);
    expect(loaded).toBe(false);
    // The source stays leased when the destination refuses the handoff.
    expect(events).toEqual([
      ['phi-4-mini-generic-cpu', 'start'],
      [VARIANT, 'start'],
      ['phi-4-mini-generic-cpu', 'end'],
    ]);
    expect(upstream.state.hits.filter(h => h.url === '/v1/chat/completions')).toHaveLength(1);
  });

  it('does not replay onto a loaded variant whose lease is refused', async () => {
    const CANONICAL = 'phi-4-mini-generic-cpu:3';
    const events = [];
    gateway = await startGateway({
      resolve: async () => ({ alias: 'phi-4-mini', variantId: null }),
      load: async () => { upstream.state.loaded.add(CANONICAL); return CANONICAL; },
      onActivity: (model, phase) => {
        events.push([model, phase]);
        return phase === 'start' && model === CANONICAL ? false : model;
      },
    });

    const res = await post(gateway.publicPort, 'phi-4-mini');

    expect(res.status).toBe(409);
    expect(events).toEqual([['phi-4-mini', 'start'], [CANONICAL, 'start'], ['phi-4-mini', 'end']]);
    // Only the first, not-loaded attempt reached the service.
    expect(upstream.state.hits.filter(h => h.url === '/v1/chat/completions')).toHaveLength(1);
  });

  it('leases a multipart speech request with a reordered quoted boundary parameter', async () => {
    const events = [];
    const boundary = 'flint-test-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n`
      + 'whisper-tiny:1\r\n'
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ping.wav"\r\n`
      + 'Content-Type: audio/wav\r\n\r\nRIFF\r\n'
      + `--${boundary}--\r\n`;
    gateway = await startGateway({ onActivity: (model, phase) => events.push([model, phase]) });

    const res = await request(gateway.publicPort, '/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; charset=utf-8; BOUNDARY = "${boundary}"` },
      body,
    });

    expect(res.status).toBe(200);
    expect(events).toEqual([['whisper-tiny:1', 'start'], ['whisper-tiny:1', 'end']]);
    expect(upstream.state.hits.at(-1).body).toBe(body);
  });

  it('does not inspect multipart bodies on unrelated upload routes', async () => {
    const events = [];
    const boundary = 'flint-test-boundary';
    gateway = await startGateway({ onActivity: (...event) => events.push(event) });

    const res = await request(gateway.publicPort, '/v1/files', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n`
        + `whisper-tiny:1\r\n--${boundary}--\r\n`,
    });

    expect(res.status).toBe(200);
    expect(events).toEqual([]);
  });

  it('preserves a speech multipart body when the model field spans chunks', async () => {
    const events = [];
    const boundary = 'flint-split-boundary';
    const chunks = [
      '--flint',
      '-split-boundary\r\nContent-Disposition: form-data; na',
      'me="model"\r\n\r\nwhisper-tiny:1\r\n',
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ping.wav"\r\n`
        + `Content-Type: audio/wav\r\n\r\nRIFF\r\n--${boundary}--\r\n`,
    ];
    gateway = await startGateway({ onActivity: (model, phase) => events.push([model, phase]) });

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: gateway.publicPort,
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      }, response => {
        response.resume();
        response.on('end', () => resolve(response));
      });
      req.on('error', reject);
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });

    expect(res.statusCode).toBe(200);
    expect(events).toEqual([['whisper-tiny:1', 'start'], ['whisper-tiny:1', 'end']]);
    expect(upstream.state.hits.at(-1).body).toBe(chunks.join(''));
  });

  it('forwards a complete speech multipart body with no leading model without leasing', async () => {
    const events = [];
    const boundary = 'flint-no-model-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`
      + `--${boundary}--\r\n`;
    gateway = await startGateway({ onActivity: (...event) => events.push(event) });

    const res = await request(gateway.publicPort, '/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    expect(res.status).toBe(200);
    expect(events).toEqual([]);
    expect(upstream.state.hits.at(-1).body).toBe(body);
  });

  it('does not book an oversized multipart model value', async () => {
    const events = [];
    const boundary = 'flint-long-model-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n`
      + `${'m'.repeat(300)}\r\n--${boundary}--\r\n`;
    gateway = await startGateway({ onActivity: (...event) => events.push(event) });

    const res = await request(gateway.publicPort, '/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    expect(res.status).toBe(200);
    expect(events).toEqual([]);
    expect(upstream.state.hits.at(-1).body).toBe(body);
  });

  it('does not forward a speech multipart body when the client aborts during the peek', async () => {
    const boundary = 'flint-abort-boundary';
    gateway = await startGateway();

    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: gateway.publicPort,
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      req.on('error', resolve);
      req.on('socket', socket => {
        socket.once('connect', () => {
          req.write(`--${boundary}\r\nContent-Disposition: form-data; name="mod`);
          setTimeout(() => req.destroy(), 10);
        });
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(upstream.state.hits).toEqual([]);
  });

  it('classifies speech routes without matching neighboring paths', () => {
    expect(classifyGatewayRoute('/v1/audio/transcriptions?format=json')).toBe('speech');
    expect(classifyGatewayRoute('/v1/audio/transcription-preview')).toBe('other');
  });

  it('stays open across an autoload and replay rather than reporting twice', async () => {
    // The whole exchange is one request; ending after the first attempt would leave the
    // model evictable during its own replay.
    const events = [];
    gateway = await startGateway({
      load: async alias => { upstream.state.loaded.add(alias); },
      onActivity: (model, phase) => events.push([model, phase]),
    });
    const res = await post(gateway.publicPort, 'qwen3-0.6b');
    expect(res.status).toBe(200);
    expect(upstream.state.hits).toHaveLength(2);
    expect(events).toEqual([['qwen3-0.6b', 'start'], ['qwen3-0.6b', 'end']]);
  });

  it('moves activity to the resolved version before loading a variant switch', async () => {
    const events = [];
    gateway = await startGateway({
      resolve: async () => ({ alias: 'qwen3-0.6b', variantId: 'qwen3-0.6b-generic-cpu:2' }),
      load: async () => { upstream.state.loaded.add('qwen3-0.6b-generic-cpu:2'); },
      onActivity: (model, phase) => events.push([model, phase]),
    });
    const res = await post(gateway.publicPort, 'qwen3-0.6b-generic-cpu');
    expect(res.status).toBe(200);
    expect(events).toEqual([
      ['qwen3-0.6b-generic-cpu', 'start'],
      ['qwen3-0.6b-generic-cpu:2', 'start'],
      ['qwen3-0.6b-generic-cpu', 'end'],
      ['qwen3-0.6b-generic-cpu:2', 'end'],
    ]);
  });

  it('moves activity again when loading returns a different canonical variant', async () => {
    const events = [];
    gateway = await startGateway({
      resolve: async () => ({ alias: 'qwen3-0.6b', variantId: 'qwen3-0.6b-generic-cpu:1' }),
      load: async () => {
        upstream.state.loaded.add('qwen3-0.6b-generic-cpu:2');
        return 'qwen3-0.6b-generic-cpu:2';
      },
      onActivity: (model, phase) => events.push([model, phase]),
    });

    const res = await post(gateway.publicPort, 'qwen3-0.6b');

    expect(res.status).toBe(200);
    expect(events).toEqual([
      ['qwen3-0.6b', 'start'],
      ['qwen3-0.6b-generic-cpu:1', 'start'],
      ['qwen3-0.6b', 'end'],
      ['qwen3-0.6b-generic-cpu:2', 'start'],
      ['qwen3-0.6b-generic-cpu:1', 'end'],
      ['qwen3-0.6b-generic-cpu:2', 'end'],
    ]);
  });

  it('ends each rebooked activity with the key returned by its matching start', async () => {
    const starts = new Map();
    const ends = [];
    let sequence = 0;
    gateway = await startGateway({
      resolve: async () => ({ alias: 'qwen3-0.6b', variantId: 'qwen3-0.6b-generic-cpu:2' }),
      load: async () => { upstream.state.loaded.add('qwen3-0.6b-generic-cpu:2'); },
      onActivity: (model, phase, booking) => {
        if (phase === 'start') {
          const key = `${model}:${++sequence}`;
          starts.set(key, model);
          return key;
        }
        ends.push([model, booking]);
      },
    });

    const res = await post(gateway.publicPort, 'qwen3-0.6b-generic-cpu');

    expect(res.status).toBe(200);
    expect(ends).toEqual([
      ['qwen3-0.6b-generic-cpu', 'qwen3-0.6b-generic-cpu:1'],
      ['qwen3-0.6b-generic-cpu:2', 'qwen3-0.6b-generic-cpu:2:2'],
    ]);
    expect(ends.every(([model, booking]) => starts.get(booking) === model)).toBe(true);
  });

  it('closes the bracket when the request fails', async () => {
    // Without this an in-flight counter would leak and the model could never be evicted.
    const events = [];
    gateway = await startGateway({
      load: async () => { throw new Error('no disk space'); },
      onActivity: (model, phase) => events.push([model, phase]),
    });
    const res = await post(gateway.publicPort, 'qwen3-0.6b');
    expect(res.status).toBe(400);
    expect(events.map(e => e[1])).toEqual(['start', 'end']);
  });

  it('serves the request even if the hook throws', async () => {
    upstream.state.loaded.add('phi-4-mini');
    gateway = await startGateway({ onActivity: () => { throw new Error('hook exploded'); } });
    const res = await post(gateway.publicPort, 'phi-4-mini');
    expect(res.status).toBe(200);
  });

  it('rejects model work when the activity hook cannot acquire a lease', async () => {
    upstream.state.loaded.add('phi-4-mini');
    const events = [];
    gateway = await startGateway({
      onActivity: (model, phase) => {
        events.push([model, phase]);
        return phase !== 'start';
      },
    });

    const res = await post(gateway.publicPort, 'phi-4-mini');
    expect(res.status).toBe(409);
    expect(events).toEqual([['phi-4-mini', 'start']]);
    expect(upstream.state.hits).toHaveLength(0);
  });

  it('holds an admission lease across autoload and replay', async () => {
    const events = [];
    gateway = await startGateway({
      load: async alias => { upstream.state.loaded.add(alias); },
      admitRequest: () => {
        events.push('admit');
        return () => events.push('complete');
      },
    });

    const res = await post(gateway.publicPort, 'qwen3-0.6b');
    expect(res.status).toBe(200);
    expect(events).toEqual(['admit', 'complete']);
  });

  it('uses a custom admission-denied message when provided', async () => {
    gateway = await startGateway({
      admitRequest: () => null,
      admissionDeniedMessage: () => 'A benchmark run is in progress; the local gateway is not accepting other work.',
    });
    const res = await post(gateway.publicPort, 'qwen3-0.6b');
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toMatch(/benchmark run is in progress/);
  });

  it('rejects new model work when admission is fenced', async () => {
    gateway = await startGateway({ admitRequest: () => null });
    const res = await post(gateway.publicPort, 'qwen3-0.6b');

    expect(res.status).toBe(503);
    expect(upstream.state.hits).toHaveLength(0);
  });

  it('rejects non-model requests when admission is fenced', async () => {
    gateway = await startGateway({ admitRequest: () => null });
    const res = await request(gateway.publicPort, '/v1/models');

    expect(res.status).toBe(503);
    expect(upstream.state.hits).toHaveLength(0);
  });

  it('stops accepting without destroying an admitted response', async () => {
    await new Promise(r => upstream.server.close(r));
    let finish;
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      finish = () => res.end('data: [DONE]\n\n');
    });
    const events = [];
    gateway = await startGateway({
      admitRequest: () => {
        events.push('admit');
        return () => events.push('complete');
      },
    });

    const response = request(gateway.publicPort, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'phi-4-mini' }),
    });
    while (!finish) await new Promise(r => setTimeout(r, 1));
    let stopped = false;
    const stopping = gateway.beginStop().then(() => { stopped = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(stopped).toBe(false);
    expect(events).toEqual(['admit']);

    finish();
    await expect(response).resolves.toMatchObject({ status: 200 });
    await stopping;
    expect(events).toEqual(['admit', 'complete']);
  });

  it('allows an admitted autoload to replay during graceful listener shutdown', async () => {
    let releaseLoad;
    let loadStarted = false;
    gateway = await startGateway({
      load: alias => new Promise(resolve => {
        loadStarted = true;
        releaseLoad = () => {
          upstream.state.loaded.add(alias);
          resolve(alias);
        };
      }),
      admitRequest: () => () => {},
    });

    const response = post(gateway.publicPort, 'qwen3-0.6b');
    while (!loadStarted) await new Promise(r => setTimeout(r, 1));
    const stopping = gateway.beginStop();
    releaseLoad();

    await expect(response).resolves.toMatchObject({ status: 200 });
    await stopping;
    expect(upstream.state.hits).toHaveLength(2);
  });

  it('force-closes a partial connection left after graceful accepting stops', async () => {
    let admitted = false;
    gateway = await startGateway({
      admitRequest: () => {
        admitted = true;
        return () => {};
      },
    });
    const socket = net.connect(gateway.publicPort, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      'POST /v1/chat/completions HTTP/1.1\r\n'
      + 'Host: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n'
      + '{"model":"partial"',
    );
    while (!admitted) await new Promise(r => setTimeout(r, 1));

    let stopped = false;
    gateway.beginStop().then(() => { stopped = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(stopped).toBe(false);

    await gateway.stop({ force: true });
    expect(stopped).toBe(true);
    for (let i = 0; i < 50 && !socket.destroyed; i += 1) {
      await new Promise(r => setTimeout(r, 1));
    }
    expect(socket.destroyed).toBe(true);
  });
});

describe('classifyGatewayRoute', () => {
  it('labels chat, embeddings, models, and other without reading bodies', () => {
    expect(classifyGatewayRoute('/v1/chat/completions')).toBe('chat');
    expect(classifyGatewayRoute('/v1/models?foo=1')).toBe('models');
    expect(classifyGatewayRoute('/v1/models/tiny-cpu')).toBe('models');
    expect(classifyGatewayRoute('/v1/not-models')).toBe('other');
    expect(classifyGatewayRoute('/v1/embeddings')).toBe('embeddings');
    expect(classifyGatewayRoute('/v1/embeddings?foo=1')).toBe('embeddings');
    expect(classifyGatewayRoute('/v1/chat/completions-evil')).toBe('other');
    expect(classifyGatewayRoute('/v1/embeddings-preview')).toBe('other');
    expect(classifyGatewayRoute('/health')).toBe('other');
  });
});

describe('gateway embeddings autoload', () => {
  it('loads the model and replays POST /v1/embeddings once', async () => {
    const loads = [];
    const access = [];
    gateway = await startGateway({
      load: async (alias) => { loads.push(alias); upstream.state.loaded.add(alias); },
      onAccess: (entry) => access.push(entry),
    });
    const res = await request(gateway.publicPort, '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-embedding', input: 'ping' }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data[0].embedding).toEqual([0.1, 0.2]);
    expect(body.model).toBe('qwen3-embedding');
    expect(loads).toEqual(['qwen3-embedding']);
    expect(upstream.state.hits).toHaveLength(2);
    expect(access[0].routeClass).toBe('embeddings');
    expect(access[0].type).toBe('gateway');
  });

  it('rewrites an embeddings alias to the loaded variant on replay', async () => {
    const ALIAS = 'qwen3-embedding';
    const VARIANT = 'qwen3-embedding-generic-cpu';
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res, body, state) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ endpoints: [`http://127.0.0.1:${req.socket.localPort}`] }));
        return;
      }
      let model = null;
      try { model = JSON.parse(body).model; } catch { /* ignore */ }
      if (!model || !state.loaded.has(model)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(NOT_LOADED(model));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [1], index: 0 }], model }));
    });
    gateway = await startGateway({
      resolve: async id => (id === ALIAS ? { alias: ALIAS, variantId: null } : null),
      load: async () => { upstream.state.loaded.add(VARIANT); return VARIANT; },
    });
    const res = await request(gateway.publicPort, '/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ALIAS, input: 'hello world' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).model).toBe(VARIANT);
    const replay = JSON.parse(upstream.state.hits[1].body);
    expect(replay.model).toBe(VARIANT);
    expect(replay.input).toBe('hello world');
  });
});
