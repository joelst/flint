// Pure helpers for Flint's reverse proxy.
//
// Flint sits in front of Foundry Local's own HTTP server so it can load a model that a
// client asked for but that is not resident. Being a proxy brings obligations that have
// nothing to do with that goal — header hygiene, error shapes, response rewriting — and
// they are collected here so they can be tested without sockets.

/**
 * Headers that describe a single network hop and must not be copied to the next one.
 * Forwarding `transfer-encoding` or `connection` verbatim produces a message whose framing
 * contradicts what the proxy actually sends, which is the classic request-smuggling shape.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Strip hop-by-hop headers, including any the message itself nominates via `Connection`.
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @returns {Record<string, string|string[]>}
 */
export function stripHopByHopHeaders (headers) {
  const source = headers && typeof headers === 'object' ? headers : {};

  // `Connection: X, Y` marks X and Y as hop-by-hop for this message only.
  const nominated = new Set();
  const connection = source.connection ?? source.Connection;
  const raw = Array.isArray(connection) ? connection.join(',') : connection;
  for (const token of String(raw || '').split(',')) {
    const name = token.trim().toLowerCase();
    if (name) nominated.add(name);
  }

  /** @type {Record<string, string|string[]>} */
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || nominated.has(lower)) continue;
    out[key] = value;
  }
  return out;
}

/** Media type only, so `application/json; charset=utf-8` still counts as JSON. */
export function isJsonContentType (contentType) {
  const media = String(contentType || '').split(';')[0].trim().toLowerCase();
  return media === 'application/json';
}

/**
 * Foundry's "not loaded" rejection, which is the whole reason this proxy exists.
 *
 * Matched narrowly and only on 400: a retry is a second execution of the client's request,
 * so it must not be triggered by an unrelated failure that happens to mention a model.
 *
 * @param {number} status
 * @param {string} body
 */
export function isModelNotLoadedError (status, body) {
  if (status !== 400) return false;
  const text = String(body || '');
  // Foundry wraps the message as {"error":{"message":...}}, but some callers pass the
  // extracted message on its own. Fall back to the raw text unless a message is found.
  let message = text;
  try {
    const parsed = JSON.parse(text)?.error?.message;
    if (typeof parsed === 'string') message = parsed;
  } catch {
    // Not JSON: treat the body as the message itself.
  }
  // Keyed to the quoted model name, the one part of the sentence that cannot appear by
  // accident. Anchoring the whole sentence instead would silently disable autoload the
  // first time Foundry reworded the surrounding text.
  return /\bModel '[^']+' is not loaded\b/i.test(message);
}

/** Bodies are only buffered so a request can be replayed; a giant upload is streamed. */
export const DEFAULT_MAX_BUFFERED_BODY = 32 * 1024 * 1024;

/**
 * Decide whether a request body should be held in memory for a possible replay.
 *
 * Only JSON is worth buffering: the identifier lives in a JSON field, and audio uploads are
 * both large and shaped so the model name cannot be read without parsing multipart.
 *
 * @param {{ method?: string, contentType?: string, contentLength?: number|null, maxBytes?: number }} input
 */
export function shouldBufferBody (input) {
  const method = String(input?.method || '').toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return false;
  if (!isJsonContentType(input?.contentType)) return false;

  const max = input?.maxBytes ?? DEFAULT_MAX_BUFFERED_BODY;
  const declared = input?.contentLength;
  // A declared length over the cap is rejected before a single byte is read.
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > max) return false;
  return true;
}

/** Read the `model` field without letting a malformed body throw into the request path. */
export function extractModelName (body) {
  try {
    const parsed = JSON.parse(typeof body === 'string' ? body : String(body));
    const name = parsed?.model;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/** OpenAI-shaped error, so a client's normal error handling still applies. */
export function openAiError (message, type = 'server_error', code = null) {
  return JSON.stringify({ error: { message: String(message), type, code } });
}

/**
 * Replace the `model` field of a buffered JSON body.
 *
 * Foundry routes by variant id (`qwen2.5-0.5b-instruct-generic-cpu`, with or without the
 * `:<version>` suffix) and refuses the friendly alias (`qwen2.5-0.5b`) outright, returning
 * "is not loaded" even while that very model is resident. A replay after an autoload must
 * therefore name the variant that was actually loaded, or it fails exactly as the first
 * attempt did — having spent the memory to load the model.
 *
 * Returns null when the body is not a JSON object, so the caller can send it untouched.
 *
 * @param {string} body
 * @param {string} name
 * @returns {string|null}
 */
export function rewriteModelName (body, name) {
  if (typeof body !== 'string' || typeof name !== 'string' || !name.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  // Already correct: return the original rather than a re-serialised equivalent.
  if (parsed.model === name) return body;
  parsed.model = name;
  return JSON.stringify(parsed);
}

/**
 * Rewrite Foundry's `/status` payload so it advertises the address clients actually use.
 *
 * Foundry is started on an internal loopback port and reports that port back. Echoing it
 * would hand every caller an endpoint that is wrong, and on a LAN binding, unreachable.
 *
 * @param {string} body
 * @param {string} publicEndpoint e.g. "http://127.0.0.1:5273"
 * @returns {string} rewritten body, or the original when it is not the expected shape
 */
export function rewriteStatusEndpoints (body, publicEndpoint) {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.endpoints)) return body;
    parsed.endpoints = [publicEndpoint];
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/** Loopback callers are trusted for autoload; see gateway.js for why that matters. */
export function isLoopbackAddress (address) {
  const addr = String(address || '').replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.');
}
