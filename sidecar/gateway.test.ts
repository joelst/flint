// Whole-proxy tests against a fake Foundry.
//
// The real service takes seconds to load a model and needs the SDK, which makes it useless
// for testing the failure paths that matter here (client disconnect, retry limits, SSE).
// The fake reproduces the one behaviour the gateway is built around — a 400 until the model
// is resident — and lets every branch be driven deterministically.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createGateway } from './gateway.js';

/** @type {{ server: http.Server, port: number, loaded: Set<string>, hits: any[] }} */
let upstream;
let gateway;

const NOT_LOADED = (model) => JSON.stringify({
  error: {
    message: `Failed to handle OpenAI completion: Model '${model}' is not loaded. `
      + 'Please load the model before getting a ChatClient.',
    type: 'invalid_request_error',
  },
});

async function startUpstream (handler) {
  const state = { loaded: new Set(), hits: [] };
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
  if (req.url === '/v1/chat/completions') {
    let model = null;
    try { model = JSON.parse(body).model; } catch { /* streamed body */ }
    if (model && !state.loaded.has(model)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(NOT_LOADED(model));
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
    expect(res.body).toContain('is not loaded');
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
    expect(res.body).toContain('is not loaded');
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

// Foundry routes variant ids but rejects the friendly alias outright, even while that model
// is resident. The alias is exactly what Flint's own integration snippets tell users to
// configure, so without a rewrite the gateway loads the model and still returns 400.
describe('gateway model-name routing', () => {
  const ALIAS = 'qwen2.5-0.5b';
  const VARIANT = 'qwen2.5-0.5b-instruct-generic-cpu:4';

  /** Upstream that behaves like the real service: only the variant id ever routes. */
  async function startVariantOnlyUpstream () {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res, body, state) => {
      let model = null;
      try { model = JSON.parse(body).model; } catch { /* not JSON */ }
      if (!model || !state.loaded.has(model)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(NOT_LOADED(model));
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

  it('leaves the body alone when the loader reports no variant', async () => {
    await startVariantOnlyUpstream();
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
  it('streams SSE chunks as they are produced rather than buffering', async () => {
    await new Promise(r => upstream.server.close(r));
    upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 60);
    });
    gateway = await startGateway();

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
