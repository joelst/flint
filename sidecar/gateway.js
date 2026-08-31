// Flint's reverse proxy in front of Foundry Local's HTTP server.
//
// Why this exists: Foundry only serves a model that is already resident in memory. Any
// other OpenAI-compatible client — a coding agent, an IDE plugin, a curl one-liner — reads
// `GET /v1/models`, posts to a model it found there, and gets back
// `400 Model 'X' is not loaded`. There is no HTTP route to load a model (probed: every
// plausible load path 404s), so a client has no way to recover on its own. Loading is only
// reachable through the SDK, in this process.
//
// So Flint listens on the port the user configured, forwards everything to Foundry on an
// internal loopback port, and when — and only when — that exact rejection comes back, it
// loads the model through the SDK and replays the request once.
//
// Reactive rather than proactive: the request is forwarded first and inspected only after
// it fails. Checking "is this loaded?" up front would put an SDK call on every hot-path
// request, and would happily spend five seconds loading a multi-gigabyte model for a
// request that was going to be rejected for a bad route or malformed body anyway. Letting
// Foundry validate first means we only ever load in response to a request it accepted.

import http from 'node:http';
import { pipeline } from 'node:stream';
import {
  stripHopByHopHeaders,
  isModelNotLoadedError,
  shouldBufferBody,
  extractModelName,
  openAiError,
  rewriteStatusEndpoints,
  isLoopbackAddress,
  DEFAULT_MAX_BUFFERED_BODY,
} from './gateway-http.js';

/** Upstream is on loopback, so a long timeout only ever means the model is thinking. */
const UPSTREAM_TIMEOUT_MS = 0; // no timeout: generation can legitimately run for minutes

/**
 * @param {object} options
 * @param {number} options.publicPort        port clients connect to
 * @param {string} options.bindAddress       interface to listen on
 * @param {number} options.upstreamPort      loopback port Foundry was started on
 * @param {(id: string) => Promise<{alias: string, variantId: string|null}|null>} options.resolve
 * @param {(alias: string, variantId: string|null) => Promise<void>} options.load
 * @param {(level: string, msg: string) => void} [options.log]
 * @param {boolean} [options.autoload]       default true
 * @param {boolean} [options.loopbackOnlyAutoload] default true
 * @param {number} [options.maxBufferedBody]
 */
export function createGateway (options) {
  const {
    publicPort,
    bindAddress = '127.0.0.1',
    upstreamPort,
    resolve,
    load,
    log = () => {},
    autoload = true,
    loopbackOnlyAutoload = true,
    maxBufferedBody = DEFAULT_MAX_BUFFERED_BODY,
  } = options;

  // Keep-alive to upstream: without it every request pays a fresh TCP handshake, and a
  // busy client can exhaust ephemeral ports with sockets stuck in TIME_WAIT.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

  /** @type {Map<string, Promise<void>>} in-flight loads, keyed by alias+variant */
  const inflight = new Map();
  // A cold load is memory-bound, not CPU-bound: two at once can exhaust VRAM and fail both.
  // One at a time, queued.
  let loadChain = Promise.resolve();

  let generation = 0; // bumped on stop, so a load resolving late cannot trigger a replay
  let boundPort = null; // actual port, which differs from publicPort when 0 was requested

  function loadOnce (alias, variantId) {
    const key = `${alias}::${variantId ?? ''}`;
    const existing = inflight.get(key);
    if (existing) return existing;

    const run = loadChain.then(async () => {
      log('info', `Gateway autoload: ${alias}${variantId ? ` (${variantId})` : ''}`);
      await load(alias, variantId);
    });
    // The chain must not break on failure, or every later load would reject immediately.
    loadChain = run.catch(() => {});
    const tracked = run.finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
    inflight.set(key, tracked);
    return tracked;
  }

  const server = http.createServer({ joinDuplicateHeaders: false }, (req, res) => {
    handleRequest(req, res).catch(err => {
      log('warn', `Gateway request error: ${err?.message ?? err}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(openAiError('Gateway failure contacting the local service.', 'server_error'));
      } else {
        res.destroy();
      }
    });
  });

  // A proxy that answers CONNECT or upgrades a connection becomes a tunnel to anywhere.
  // Foundry serves neither, so refusing is both correct and the safe default.
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());

  async function handleRequest (req, res) {
    const buffered = await maybeBufferBody(req, res);
    if (buffered === ABORTED) return;

    const attempt = await forward(req, res, buffered, { captureNotLoaded: true });
    if (attempt === SENT) return;

    // Only reached when upstream returned the exact not-loaded rejection and the body was
    // buffered, so replaying it is safe.
    const requested = extractModelName(buffered);
    const target = requested ? await resolve(requested) : null;
    if (!target) {
      // Nothing to load: hand back what upstream said rather than inventing an error.
      return respondBuffered(res, attempt.status, attempt.headers, attempt.body);
    }

    const gen = generation;
    try {
      await loadOnce(target.alias, target.variantId);
    } catch (err) {
      log('warn', `Gateway autoload failed for ${target.alias}: ${err?.message ?? err}`);
      return respondBuffered(res, attempt.status, attempt.headers, attempt.body);
    }
    if (gen !== generation || res.writableEnded || res.destroyed) return;

    // captureNotLoaded: false — the retry already happened, so a second rejection is the
    // real answer and belongs to the client rather than being swallowed again.
    const second = await forward(req, res, buffered, { captureNotLoaded: false });
    if (second !== SENT) {
      respondBuffered(res, attempt.status, attempt.headers, attempt.body);
    }
  }

  /**
   * Read the body when it is small JSON, since that is the only case a replay is possible.
   * Anything else is streamed and simply cannot be retried.
   * @returns {Promise<string|null|typeof ABORTED>}
   */
  function maybeBufferBody (req, res) {
    const declared = Number(req.headers['content-length']);
    const wanted = autoload && shouldBufferBody({
      method: req.method,
      contentType: req.headers['content-type'],
      contentLength: Number.isFinite(declared) ? declared : null,
      maxBytes: maxBufferedBody,
    }) && autoloadAllowedFor(req);

    if (!wanted) return Promise.resolve(null);

    return new Promise(resolve2 => {
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = value => { if (!done) { done = true; resolve2(value); } };

      req.on('data', chunk => {
        size += chunk.length;
        if (size > maxBufferedBody) {
          // Undeclared oversize. The stream is already partly consumed, so it can no
          // longer be forwarded faithfully; refusing is the only honest answer.
          //
          // The response must go out before the socket dies, so the connection is closed
          // by the `connection: close` header rather than by destroying the request — a
          // destroy here would take the 413 down with it.
          if (!res.headersSent) {
            res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
            res.end(openAiError('Request body too large.', 'invalid_request_error'));
          }
          req.resume(); // drain rather than stall; the close header bounds how much arrives
          finish(ABORTED);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => finish(ABORTED));
      req.on('aborted', () => finish(ABORTED));
    });
  }

  /** Autoload is a remotely triggerable memory allocation, so keep it to local callers. */
  function autoloadAllowedFor (req) {
    if (!loopbackOnlyAutoload) return true;
    return isLoopbackAddress(req.socket?.remoteAddress);
  }

  /**
   * Send one request upstream.
   *
   * `captureNotLoaded` decides who owns a not-loaded rejection. On the first attempt we
   * hold it back, because the client must not see an error we are about to fix. On the
   * replay we let it through: the load already happened, so a second rejection is the
   * genuine outcome. There is no third attempt — one load is either enough or it is not.
   *
   * Returns SENT when the client response has already been written; otherwise a
   * `{ status, headers, body }` record the caller may replay after loading.
   */
  function forward (req, res, buffered, { captureNotLoaded }) {
    return new Promise(resolve2 => {
      const headers = stripHopByHopHeaders(req.headers);
      // Upstream is addressed by us, never derived from the client's Host header — that
      // would let a request choose its own destination.
      headers.host = `127.0.0.1:${upstreamPort}`;
      if (buffered !== null) headers['content-length'] = String(Buffer.byteLength(buffered));

      const upstream = http.request({
        host: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
        agent,
        timeout: UPSTREAM_TIMEOUT_MS || undefined,
      });

      const onClientClose = () => {
        // The client gave up; generation upstream would otherwise keep burning compute.
        if (!upstream.destroyed) upstream.destroy();
      };
      res.on('close', onClientClose);

      upstream.on('error', err => {
        res.off('close', onClientClose);
        if (res.headersSent || res.writableEnded) {
          res.destroy();
        } else {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(openAiError(
            `Local service unavailable: ${err?.message ?? err}`, 'server_error'
          ));
        }
        resolve2(SENT);
      });

      upstream.on('response', upRes => {
        const status = upRes.statusCode ?? 502;
        const outHeaders = stripHopByHopHeaders(upRes.headers);

        // Two cases need the whole body before anything reaches the client: a possible
        // retry (the client must never see the error we intend to paper over) and /status
        // (whose contents we rewrite). Everything else streams, which keeps SSE tokens
        // flowing as they are produced.
        const mayRetry = captureNotLoaded && buffered !== null && status === 400;
        const isStatus = isStatusPath(req.url);

        if (!mayRetry && !isStatus) {
          res.writeHead(status, outHeaders);
          pipeline(upRes, res, () => {
            res.off('close', onClientClose);
          });
          resolve2(SENT);
          return;
        }

        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('error', () => {
          res.off('close', onClientClose);
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
          res.end(openAiError('Upstream response failed.', 'server_error'));
          resolve2(SENT);
        });
        upRes.on('end', () => {
          res.off('close', onClientClose);
          const body = Buffer.concat(chunks).toString('utf8');

          if (mayRetry && isModelNotLoadedError(status, body)) {
            resolve2({ status, headers: outHeaders, body });
            return;
          }

          const finalBody = isStatus
            ? rewriteStatusEndpoints(body, `http://127.0.0.1:${boundPort ?? publicPort}`)
            : body;
          respondBuffered(res, status, outHeaders, finalBody);
          resolve2(SENT);
        });
      });

      if (buffered !== null) upstream.end(buffered);
      else pipeline(req, upstream, () => {});
    });
  }

  return {
    get publicPort () { return boundPort ?? publicPort; },
    /** Bind before Foundry starts so a port clash surfaces as a clear error, not a hang. */
    start () {
      return new Promise((resolve2, reject) => {
        const onError = err => { server.off('listening', onListening); reject(err); };
        const onListening = () => {
          server.off('error', onError);
          boundPort = server.address()?.port ?? publicPort;
          resolve2();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(publicPort, bindAddress);
      });
    },
    stop () {
      generation += 1;
      return new Promise(resolve2 => {
        agent.destroy();
        server.close(() => resolve2());
        server.closeAllConnections?.();
      });
    },
  };
}

const SENT = Symbol('sent');
const ABORTED = Symbol('aborted');

function isStatusPath (url) {
  const path = String(url || '').split('?')[0];
  return path === '/status' || path === '/v1/status';
}

function respondBuffered (res, status, headers, body) {
  if (res.writableEnded || res.destroyed) return;
  const out = { ...headers };
  delete out['content-length'];
  delete out['Content-Length'];
  res.writeHead(status, { ...out, 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}
