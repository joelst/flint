// Flint's reverse proxy in front of Foundry Local's HTTP server.
//
// Why this exists: Foundry only serves a model that is already resident in memory, and only
// under its exact loaded variant id. Any other OpenAI-compatible client — a coding agent, an
// IDE plugin, a curl one-liner — reads `GET /v1/models`, posts to a name it found there, and
// gets back `400 Model 'X' must be loaded before inference` for a known variant that is not
// resident, or `404 Model not found: No model matching 'X'` for an alias or a versionless id
// (SDK 1.x said `400 Model 'X' is not loaded` for both). There is no HTTP route to load a
// model (probed: every plausible load path 404s), so a client has no way to recover on its
// own. Loading is only reachable through the SDK, in this process.
//
// So Flint listens on the port the user configured, forwards everything to Foundry on an
// internal loopback port, and when — and only when — one of those two rejections comes back
// naming the model this request sent, and the cached-model registry knows that name, it
// loads the model through the SDK and replays the request once under the loaded variant id.
//
// Reactive rather than proactive: the request is forwarded first and inspected only after
// it fails. Checking "is this loaded?" up front would put an SDK call on every hot-path
// request, and would happily spend five seconds loading a multi-gigabyte model for a
// request that was going to be rejected for a bad route or malformed body anyway. Letting
// Foundry answer first means we load only after it rejected the request for naming a model
// that is not loaded. SDK 1.x sent that rejection after body validation; SDK 2.0.1 routes by
// name first and answers 404 to an alias before reading the rest of the body, so an alias
// request with an otherwise invalid body can cost one load before Foundry rejects the body.

import http from 'node:http';
import { Transform, pipeline } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { normalizeChatResponse } from './chat-response.js';
import {
  stripHopByHopHeaders,
  modelRejection,
  rejectionNames,
  shouldBufferBody,
  extractModelName,
  openAiError,
  rewriteModelName,
  rewriteStatusEndpoints,
  formatPublicEndpoint,
  isLoopbackAddress,
  isJsonContentType,
  DEFAULT_BUFFERED_RESPONSE_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BODY,
  DEFAULT_MAX_BUFFERED_RESPONSE,
} from './gateway-http.js';

/** Upstream is on loopback, so a long timeout only ever means the model is thinking. */
const UPSTREAM_TIMEOUT_MS = 0; // no timeout: generation can legitimately run for minutes
const MULTIPART_MODEL_PEEK_BYTES = 16 * 1024;
const MULTIPART_MODEL_MAX_CHARS = 256;
const multipartModel = Symbol('multipartModel');
const multipartPrefix = Symbol('multipartPrefix');
const multipartEnded = Symbol('multipartEnded');

/**
 * Classify OpenAI-compatible routes for metadata-only access logging.
 *
 * Treat `/models` as a path segment so `/v1/models` and `/v1/models/<id>` are
 * grouped together without matching unrelated names that merely contain it.
 */
export function classifyGatewayRoute (urlPath) {
  const path = String(urlPath || '').split('?')[0];
  if (/(^|\/)chat\/completions(\/|$)/.test(path)) return 'chat';
  if (/(^|\/)embeddings(\/|$)/.test(path)) return 'embeddings';
  if (/(^|\/)audio\/transcriptions(\/|$)/.test(path)) return 'speech';
  if (/(^|\/)models(\/|$)/.test(path)) return 'models';
  return 'other';
}

/**
 * Returns undefined while the leading field is incomplete, null when it is not `model`, or
 * the submitted model value once its terminating boundary is available.
 */
function extractLeadingMultipartModel (body, boundary) {
  const opening = `--${boundary}\r\n`;
  if (!body.startsWith(opening)) {
    return body.length < opening.length && opening.startsWith(body) ? undefined : null;
  }
  const headersEnd = body.indexOf('\r\n\r\n', opening.length);
  if (headersEnd < 0) return undefined;
  const headers = body.slice(opening.length, headersEnd);
  if (!/^content-disposition:[^\r\n]*\bname="model"(?:;|\r?$)/im.test(headers)) return null;
  const valueStart = headersEnd + 4;
  const valueEnd = body.indexOf(`\r\n--${boundary}`, valueStart);
  if (valueEnd < 0) return undefined;
  const value = body.slice(valueStart, valueEnd).trim();
  if (value.length > MULTIPART_MODEL_MAX_CHARS) return null;
  return value || null;
}

/**
 * @param {object} options
 * @param {number} options.publicPort        port clients connect to
 * @param {string} options.bindAddress       interface to listen on
 * @param {number} options.upstreamPort      loopback port Foundry was started on
 * @param {(id: string) => Promise<{alias: string, variantId: string|null}|null>} options.resolve
 * @param {(alias: string, variantId: string|null) => Promise<string|null|void>} options.load
 *        resolves to the variant id actually loaded, which the replay needs to name
 * @param {(level: string, msg: string) => void} [options.log]
 * @param {(model: string, phase: 'start'|'end', booking?: unknown) => unknown} [options.onActivity]
 *        called around every request that names a model, so the owner can keep a model
 *        alive while it is being served and record when it was last used. The value returned
 *        for start is supplied to its matching end call; returning exactly `false` refuses the
 *        lease (the model is being unloaded), which rejects the request with 409 and books
 *        no matching end.
 * @param {(entry: object) => void} [options.onAccess]
 *        metadata-only access log (no bodies, no headers) after each request finishes
 * @param {() => (() => void)|null} [options.admitRequest]
 *        atomically admits a request and returns its completion callback; null rejects it
 * @param {string|(() => string)} [options.admissionDeniedMessage]
 * @param {boolean} [options.autoload]       default true
 * @param {boolean} [options.loopbackOnlyAutoload] default true
 * @param {number} [options.maxBufferedBody]
 * @param {number} [options.maxBufferedResponse]
 * @param {number} [options.bufferedResponseTimeoutMs]
 */
export function createGateway (options) {
  const {
    publicPort,
    bindAddress = '127.0.0.1',
    upstreamPort,
    resolve,
    load,
    log = () => {},
    onActivity = () => {},
    onAccess = () => {},
    admitRequest,
    admissionDeniedMessage,
    autoload = true,
    loopbackOnlyAutoload = true,
    maxBufferedBody = DEFAULT_MAX_BUFFERED_BODY,
    maxBufferedResponse = DEFAULT_MAX_BUFFERED_RESPONSE,
    bufferedResponseTimeoutMs = DEFAULT_BUFFERED_RESPONSE_TIMEOUT_MS,
  } = options;
  if (typeof maxBufferedResponse !== 'number'
      || !Number.isFinite(maxBufferedResponse)
      || maxBufferedResponse < 0) {
    throw new RangeError('maxBufferedResponse must be a finite non-negative number.');
  }
  if (typeof maxBufferedBody !== 'number'
      || !Number.isFinite(maxBufferedBody)
      || maxBufferedBody < 0) {
    throw new RangeError('maxBufferedBody must be a finite non-negative number.');
  }
  if (typeof bufferedResponseTimeoutMs !== 'number'
      || !Number.isFinite(bufferedResponseTimeoutMs)
      || bufferedResponseTimeoutMs < 0) {
    throw new RangeError('bufferedResponseTimeoutMs must be a finite non-negative number.');
  }
  const bufferedBodyLimit = Math.floor(maxBufferedBody);
  const bufferedResponseLimit = Math.floor(maxBufferedResponse);
  const bufferedResponseTimeout = Math.floor(bufferedResponseTimeoutMs);

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

  // Identifiers we have learned need rewriting before Foundry will route them, mapped to
  // the variant id that works. Keyed case-insensitively, like the registry, so the map is
  // bounded by the catalog: a key is only recorded after resolving against the cached-model
  // index, and every spelling of one name shares an entry.
  const rewrites = new Map();
  const rewriteKey = (name) => String(name).trim().toLowerCase();

  function loadOnce (alias, variantId) {
    const key = `${alias}::${variantId ?? ''}`;
    const existing = inflight.get(key);
    if (existing) return existing;

    const run = loadChain.then(async () => {
      log('info', `Gateway autoload: ${alias}${variantId ? ` (${variantId})` : ''}`);
      return await load(alias, variantId);
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

  /** A hook the owner supplied must never be able to take a request down with it. */
  function notifyActivity (model, phase, booking) {
    try {
      return onActivity(model, phase, booking);
    } catch (err) {
      log('warn', `Gateway activity hook failed: ${err?.message ?? err}`);
      return undefined;
    }
  }

  function notifyAccess (entry) {
    try {
      onAccess(entry);
    } catch (err) {
      log('warn', `Gateway access hook failed: ${err?.message ?? err}`);
    }
  }

  async function handleRequest (req, res) {
    const completeAdmission = admitRequest?.();
    if (admitRequest && !completeAdmission) {
      const denied = typeof admissionDeniedMessage === 'function'
        ? admissionDeniedMessage()
        : (admissionDeniedMessage || 'The local runtime is draining and is not accepting new work.');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(openAiError(denied, 'server_error'));
      return;
    }
    try {
      return await handleAdmittedRequest(req, res);
    } finally {
      completeAdmission?.();
    }
  }

  async function handleAdmittedRequest (req, res) {
    const startedAt = Date.now();
    const buffered = await maybeBufferBody(req, res);
    if (buffered === ABORTED) return;

    const requested = buffered === null ? req[multipartModel] ?? null : extractModelName(buffered);
    let activeModel = requested;
    let activeBooking;
    let booked = false;
    try {
      if (!requested) return await route(req, res, buffered, requested);

      // Mark the model busy for the whole life of the request, not just the load. Gateway
      // traffic is proxied straight to Foundry, so the sidecar has no other way to tell a
      // model generating a long completion apart from one sitting idle — and unloading the
      // former would kill a live request.
      activeBooking = notifyActivity(requested, 'start');
      // An explicit `false` is the owner refusing the lease because that model is being
      // unloaded. Forwarding anyway would race the teardown, and the unleased request would
      // later decrement an in-flight count it never took.
      if (activeBooking === false) return respondUnloading(req, res, requested);
      booked = true;
      try {
        return await route(req, res, buffered, requested, (model) => {
          if (!model || model === activeModel) return true;
          const nextBooking = notifyActivity(model, 'start');
          // route stops before loading or replaying when this is refused. Nothing has been
          // sent to the client yet, so it gets the same 409 as a refused first booking.
          if (nextBooking === false) return false;
          if (booked) notifyActivity(activeModel, 'end', activeBooking);
          activeModel = model;
          activeBooking = nextBooking;
          booked = true;
          return true;
        });
      } finally {
        if (booked) notifyActivity(activeModel, 'end', activeBooking);
      }
    } finally {
      const completedAt = Date.now();
      notifyAccess({
        ts: startedAt,
        type: 'gateway',
        method: req.method || null,
        routeClass: classifyGatewayRoute(req.url),
        modelAlias: requested,
        status: res.statusCode || null,
        source: 'gateway',
        ok: typeof res.statusCode === 'number' ? res.statusCode < 400 : null,
        durationMs: completedAt >= startedAt ? completedAt - startedAt : null,
        ttftMs: null,
        promptTokensPerSecond: null,
        decodeTokensPerSecond: null,
        tokensIn: null,
        tokensOut: null,
      });
    }
  }

  /** The owner refused a lease because the model is being unloaded. */
  function respondUnloading (req, res, model) {
    res.writeHead(409, { 'content-type': 'application/json', connection: 'close' });
    res.end(openAiError(
      `Model ${model} is unavailable because an unload or deletion is in progress.`,
      'server_error',
    ));
    req.resume();
  }

  /**
   * @param {(model: string) => boolean} [setActivityModel] moves the request's lease to
   *        `model`; false means the owner refused it, and the request must not load or replay.
   */
  async function route (req, res, buffered, requested, setActivityModel = () => true) {

    // An identifier that needed rewriting once needs it on every later request, and the
    // upstream rejection that teaches us costs a round trip each time. Reuse it, and let
    // the not-loaded path below correct the entry if it has gone stale.
    let outgoing = buffered;
    const known = requested ? rewrites.get(rewriteKey(requested)) : null;
    if (known) {
      outgoing = rewriteModelName(buffered, known) ?? buffered;
      if (!setActivityModel(known)) return respondUnloading(req, res, known);
    }

    // Upstream's rejection must name the model we sent, which is the rewritten id when a
    // rewrite was applied, not the client's own wording.
    const sentModel = known ?? requested;
    const attempt = await forward(req, res, outgoing, { captureNotLoaded: true, sentModel });
    if (attempt === SENT) return;

    // Only reached when upstream rejected the model we named as not loaded or not found, and
    // the body was buffered, so replaying it is safe. The registry indexes cached models
    // only, so a name it does not know is handed back as upstream answered it: a stray
    // identifier must never start a download.
    const target = requested ? await resolve(requested) : null;
    if (!target) {
      // Nothing to load: hand back what upstream said rather than inventing an error.
      return respondBuffered(res, attempt.status, attempt.headers, attempt.body);
    }
    // `requested` can be a versionless variant id that aliases a resident model even when
    // the catalog resolves it to a different version. Move the activity lease to the exact
    // resolved id before loading so the switch does not mistake this request for work against
    // the build it is replacing.
    if (target.variantId && !setActivityModel(target.variantId)) {
      return respondUnloading(req, res, target.variantId);
    }

    const gen = generation;
    let loadedId = null;
    try {
      loadedId = await loadOnce(target.alias, target.variantId);
    } catch (err) {
      log('warn', `Gateway autoload failed for ${target.alias}: ${err?.message ?? err}`);
      return respondBuffered(res, attempt.status, attempt.headers, attempt.body);
    }
    if (gen !== generation || res.writableEnded || res.destroyed) return;

    // Name the variant that was actually loaded. Foundry routes only that exact id and
    // answers 404 to the alias even when the model is resident, so replaying the client's
    // own wording would reproduce the very error the load was meant to resolve.
    let replayBody = buffered;
    const canonical = typeof loadedId === 'string' && loadedId ? loadedId : target.variantId;
    if (canonical && canonical !== target.variantId && !setActivityModel(canonical)) {
      return respondUnloading(req, res, canonical);
    }
    if (canonical) {
      const rewritten = rewriteModelName(buffered, canonical);
      if (rewritten !== null) {
        replayBody = rewritten;
        rewrites.set(rewriteKey(requested), canonical);
        log('info', `Gateway routing ${requested} → ${canonical}`);
      }
    }

    // captureNotLoaded: false — the retry already happened, so a second rejection is the
    // real answer and belongs to the client rather than being swallowed again.
    const second = await forward(req, res, replayBody, { captureNotLoaded: false });
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
      maxBytes: bufferedBodyLimit,
    }) && autoloadAllowedFor(req);

    const contentType = Array.isArray(req.headers['content-type'])
      ? req.headers['content-type'][0]
      : req.headers['content-type'];
    if (
      !wanted
      && classifyGatewayRoute(req.url) === 'speech'
      && typeof contentType === 'string'
      && /^multipart\/form-data(?:;|$)/i.test(contentType)
    ) {
      return peekMultipartModel(req).then(model => {
        if (model === ABORTED) return ABORTED;
        req[multipartModel] = model;
        return null;
      });
    }
    if (!wanted) return Promise.resolve(null);

    return new Promise(resolve2 => {
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = value => { if (!done) { done = true; resolve2(value); } };

      req.on('data', chunk => {
        size += chunk.length;
        if (size > bufferedBodyLimit) {
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

  /**
   * Peek only the leading multipart field so we can lease known speech work without buffering
   * or replaying the audio upload. Flint's own probe writes `model` first; requests whose first
   * part is anything else remain opaque pass-through traffic.
   */
  function peekMultipartModel (req) {
    const contentType = Array.isArray(req.headers['content-type'])
      ? req.headers['content-type'][0]
      : req.headers['content-type'];
    const boundaryMatch = typeof contentType === 'string'
      ? /(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
      : null;
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
    if (!boundary) return Promise.resolve(null);

    return new Promise(resolve2 => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const finish = model => {
        if (settled) return;
        settled = true;
        req.off('data', onData);
        req.off('error', onAbort);
        req.off('aborted', onAbort);
        req.off('end', onEnd);
        req.pause();
        req[multipartPrefix] = Buffer.concat(chunks);
        resolve2(model);
      };
      const onEnd = () => {
        req[multipartEnded] = true;
        finish(null);
      };
      const onAbort = () => finish(ABORTED);
      const onData = chunk => {
        req.pause();
        chunks.push(chunk);
        size += chunk.length;
        const model = extractLeadingMultipartModel(
          Buffer.concat(chunks).toString('latin1'),
          boundary,
        );
        if (model !== undefined || size >= MULTIPART_MODEL_PEEK_BYTES) {
          finish(model ?? null);
          return;
        }
        req.resume();
      };
      req.on('data', onData);
      req.once('error', onAbort);
      req.once('aborted', onAbort);
      req.once('end', onEnd);
      req.resume();
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
  function forward (req, res, buffered, { captureNotLoaded, sentModel = null }) {
    return new Promise(resolve2 => {
      const headers = stripHopByHopHeaders(req.headers);
      // Upstream is addressed by us, never derived from the client's Host header — that
      // would let a request choose its own destination.
      headers.host = `127.0.0.1:${upstreamPort}`;
      headers['accept-encoding'] = 'identity';
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
        // 400 is a known variant that is not resident; 404 is a name the router does not
        // route (alias, versionless id, other casing). Both are tiny JSON bodies, and only a
        // rejection that names the model we sent is acted on below.
        const mayRetry = captureNotLoaded && buffered !== null && (status === 400 || status === 404);
        const isStatus = isStatusPath(req.url);

        const isChatJson = isChatCompletionPath(req.url) && isJsonContentType(upRes.headers['content-type']);
        const isChatStream = isChatCompletionPath(req.url) && isEventStream(upRes.headers['content-type']);
        if (!mayRetry && !isStatus && !isChatJson) {
          if (isChatStream) {
            delete outHeaders['content-length'];
            delete outHeaders['Content-Length'];
          }
          res.writeHead(status, outHeaders);
          // Resolve only when the pipeline finishes, not when it is registered. The caller
          // brackets the activity lease around this promise, so resolving early reports the
          // model idle while it is still streaming tokens — long enough for the eviction
          // sweep to unload it mid-generation.
          const done = () => {
            res.off('close', onClientClose);
            resolve2(SENT);
          };
          if (isChatStream) pipeline(upRes, normalizeChatStream(), res, done);
          else pipeline(upRes, res, done);
          return;
        }

        if (isChatJson && !mayRetry) {
          delete outHeaders['content-length'];
          delete outHeaders['Content-Length'];
          res.writeHead(status, outHeaders);
          pipeline(upRes, normalizeChatJsonStream(bufferedResponseLimit), res, () => {
            res.off('close', onClientClose);
            resolve2(SENT);
          });
          return;
        }

        const chunks = [];
        let size = 0;
        let settled = false;
        let captureTimer = null;
        const finish = callback => {
          if (settled) return;
          settled = true;
          if (captureTimer) clearTimeout(captureTimer);
          res.off('close', onClientClose);
          callback();
        };
        const failBufferedResponse = () => finish(() => {
          upRes.destroy();
          respondBuffered(
            res,
            502,
            { 'content-type': 'application/json' },
            openAiError('Upstream control response exceeded the gateway limit.', 'server_error'),
          );
          resolve2(SENT);
        });
        const failBufferedResponseTimeout = () => finish(() => {
          upRes.destroy();
          respondBuffered(
            res,
            502,
            { 'content-type': 'application/json' },
            openAiError('Upstream control response timed out.', 'server_error'),
          );
          resolve2(SENT);
        });
        captureTimer = setTimeout(failBufferedResponseTimeout, bufferedResponseTimeout);
        const declaredLength = Number(upRes.headers['content-length']);
        const bodyAllowed = req.method !== 'HEAD'
          && status !== 204
          && status !== 304
          && (status < 100 || status >= 200);
        if (bodyAllowed
            && Number.isFinite(declaredLength)
            && declaredLength > bufferedResponseLimit) {
          failBufferedResponse();
          return;
        }
        upRes.on('data', c => {
          size += c.length;
          if (size > bufferedResponseLimit) {
            failBufferedResponse();
            return;
          }
          chunks.push(c);
        });
        upRes.on('error', () => finish(() => {
          respondBuffered(
            res,
            502,
            { 'content-type': 'application/json' },
            openAiError('Upstream response failed.', 'server_error'),
          );
          resolve2(SENT);
        }));
        upRes.on('end', () => finish(() => {
          const body = Buffer.concat(chunks).toString('utf8');

          if (mayRetry && rejectionNames(modelRejection(status, body), sentModel)) {
            resolve2({ status, headers: outHeaders, body });
            return;
          }

          const finalBody = isStatus
            ? rewriteStatusEndpoints(body, formatPublicEndpoint(bindAddress, boundPort ?? publicPort))
            : body;
          respondBuffered(res, status, outHeaders, finalBody);
          resolve2(SENT);
        }));
      });

      if (buffered !== null) {
        upstream.end(buffered);
      } else if (req[multipartPrefix]) {
        upstream.write(req[multipartPrefix]);
        if (req[multipartEnded]) upstream.end();
        else pipeline(req, upstream, () => {});
      } else {
        pipeline(req, upstream, () => {});
      }
    });
  }

  function isChatCompletionPath (url) {
    return String(url || '').split('?')[0].replace(/\/+$/, '') === '/v1/chat/completions';
  }

  function isEventStream (contentType) {
    return String(contentType || '').split(';')[0].trim().toLowerCase() === 'text/event-stream';
  }

  function normalizeChatJsonStream (normalizationLimit) {
    let chunks = [];
    let size = 0;
    let passthrough = normalizationLimit === 0;
    return new Transform({
      transform (chunk, _encoding, callback) {
        if (passthrough) {
          callback(null, chunk);
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
        if (size > normalizationLimit) {
          passthrough = true;
          callback(null, Buffer.concat(chunks));
          chunks = [];
          return;
        }
        callback();
      },
      flush (callback) {
        if (passthrough) {
          callback();
          return;
        }
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          callback(null, JSON.stringify(normalizeChatResponse(JSON.parse(body))));
        } catch {
          callback(null, body);
        }
      },
    });
  }

  function normalizeChatStream () {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    return new Transform({
      transform (chunk, _encoding, callback) {
        pending += decoder.write(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        callback(null, lines.map(normalizeSseLine).join('\n') + (lines.length ? '\n' : ''));
      },
      flush (callback) {
        pending += decoder.end();
        callback(null, pending ? normalizeSseLine(pending) : null);
      },
    });
  }

  function normalizeSseLine (line) {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trimStart();
    if (payload === '[DONE]') return line;
    try {
      return `data: ${JSON.stringify(normalizeChatResponse(JSON.parse(payload), { stream: true }))}`;
    } catch {
      return line;
    }
  }

  let closePromise = null;

  function beginStop () {
    if (closePromise) return closePromise;
    closePromise = new Promise(resolve2 => {
      if (!server.listening) {
        resolve2();
        return;
      }
      server.close(() => resolve2());
      server.closeIdleConnections?.();
    });
    closePromise.then(() => rewrites.clear());
    return closePromise;
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
    beginStop,
    stop ({ force = true } = {}) {
      const closing = beginStop();
      if (force) {
        generation += 1;
        rewrites.clear();
        agent.destroy();
        server.closeAllConnections?.();
      }
      return closing;
    },
  };
}

const SENT = Symbol('sent');
const ABORTED = Symbol('aborted');

function isStatusPath (url) {
  const path = String(url || '').split('?')[0];
  return path === '/status' || path === '/v1/status';
}

export function respondBuffered (res, status, headers, body) {
  if (res.writableEnded || res.destroyed) return;
  const out = { ...headers };
  delete out['content-length'];
  delete out['Content-Length'];
  res.writeHead(status, { ...out, 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}
