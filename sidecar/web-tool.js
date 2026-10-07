import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import {
  canonicalHostname,
  ipLiteralFamily,
  isDeniedAddress,
  isLocalHostname,
} from './web-address-policy.js';
import { detectImageFormat } from './image-dimensions.js';

export { isDeniedAddress, MAX_OUTPUT_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_OUTPUT_BYTES };

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
/** 1.5 MiB of image bytes. Base64 of that is 2 MiB; the JSON frame needs a little more. */
const MAX_IMAGE_BYTES = 1_572_864;
const MAX_IMAGE_OUTPUT_BYTES = 2_200_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;
/** Matches SEARCH_URL_CHARS. A longer address is omitted, not sliced. */
const SEARCH_URL_CHARS = 2048;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;
const OVERALL_TIMEOUT_MS = 10_000;
const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'application/json',
  'application/ld+json',
];

function decodeEntities(value) {
  const named = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
  };
  return value.replace(/&(?:#(x?[0-9a-f]+)|(amp|quot|apos|lt|gt));/gi, (_match, raw, name) => {
    if (name) return named[name.toLowerCase()];
    const radix = raw[0].toLowerCase() === 'x' ? 16 : 10;
    const digits = radix === 16 ? raw.slice(1) : raw;
    const codePoint = Number.parseInt(digits, radix);
    return Number.isInteger(codePoint)
      && codePoint >= 0
      && codePoint <= 0x10ffff
      && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : '';
  });
}

function stripMarkup(value) {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ')
    .trim();
}

/**
 * Hidden page regions must not become model text. Browsers do not show HTML comments or the
 * body of an active element; a comment that contains `>` and an unclosed comment or tag are
 * both still hidden, and `stripMarkup` would otherwise keep that text.
 */
function stripHiddenContent(html) {
  const withoutComments = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!--[\s\S]*$/g, ' ');
  const open = /<(script|style|noscript|svg|iframe|form)\b[^>]*>/gi;
  let result = '';
  let cursor = 0;
  for (const match of withoutComments.matchAll(open)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    result += withoutComments.slice(cursor, start);
    const tag = match[1].toLowerCase();
    const rest = withoutComments.slice(start + match[0].length);
    const close = new RegExp(`</${tag}\\s*>`, 'i').exec(rest);
    if (!close) return result;
    cursor = start + match[0].length + close.index + close[0].length;
  }
  return result + withoutComments.slice(cursor);
}

function readableText(html) {
  return stripMarkup(stripHiddenContent(html));
}

function normalizePublicUrl(raw) {
  const parsed = new URL(String(raw).trim());
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed');
  if (parsed.username || parsed.password) throw new Error('URL credentials are not allowed');
  if (parsed.port && parsed.port !== '443') throw new Error('Only the standard HTTPS port is allowed');
  // Trailing root dots name the same host ("localhost." is localhost), and RFC 6761 reserves
  // every *.localhost name for loopback.
  const hostname = canonicalHostname(parsed.hostname);
  if (isLocalHostname(hostname)) {
    throw new Error('Local hostnames are not allowed');
  }
  // Search results never resolve DNS. isDeniedAddress is true for every non-IP, so only
  // literals are checked here. WHATWG IPv6 hostnames include brackets.
  const literal = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const family = ipLiteralFamily(literal);
  if ((family === 4 || family === 6) && isDeniedAddress(literal)) {
    throw new Error('IP literals that are private or special are not allowed');
  }
  parsed.hash = '';
  return parsed;
}

/** Same site after case and trailing-dot folding. IPv6 hostnames keep brackets in WHATWG. */
function comparableHost(url) {
  const host = canonicalHostname(url.hostname);
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Request must be an object');
  }
  if (raw.operation === 'search') {
    if (Object.keys(raw).some((key) => !['operation', 'query', 'maxResults'].includes(key))) {
      throw new Error('Search request contains an unsupported field');
    }
    const query = typeof raw.query === 'string' ? raw.query.trim() : '';
    if (!query || query.length > 500) throw new Error('Search query must contain 1-500 characters');
    const requested = Number.isInteger(raw.maxResults) ? raw.maxResults : 5;
    return { operation: 'search', query, maxResults: Math.min(5, Math.max(1, requested)) };
  }
  if (raw.operation === 'fetch') {
    if (Object.keys(raw).some((key) => !['operation', 'url', 'maxChars', 'followCrossOriginRedirects'].includes(key))) {
      throw new Error('Fetch request contains an unsupported field');
    }
    const url = normalizePublicUrl(raw.url).toString();
    const requested = Number.isInteger(raw.maxChars) ? raw.maxChars : 20_000;
    return {
      operation: 'fetch',
      url,
      maxChars: Math.min(MAX_TEXT_CHARS, Math.max(1_000, requested)),
      followCrossOriginRedirects: raw.followCrossOriginRedirects === true,
    };
  }
  if (raw.operation === 'image') {
    if (raw.followCrossOriginRedirects) {
      throw new Error('Image requests cannot follow a cross-origin redirect');
    }
    if (Object.keys(raw).some((key) => !['operation', 'url'].includes(key))) {
      throw new Error('Image request contains an unsupported field');
    }
    return { operation: 'image', url: normalizePublicUrl(raw.url).toString() };
  }
  throw new Error('Operation must be search, fetch, or image');
}

async function resolvePublic(hostname, resolve = dns.lookup) {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const family = net.isIP(unwrapped);
  const addresses = family
    ? [{ address: unwrapped, family }]
    : await resolve(unwrapped, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('Hostname did not resolve');
  }
  if (addresses.some(({ address }) => isDeniedAddress(address))) {
    throw new Error('Hostname resolves to a private or special address');
  }
  return addresses[0];
}

function withDeadline(promise, deadlineAt, message) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(message));
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), remaining);
      timer.unref?.();
    }),
  ]);
}

/** Last `charset` parameter, or null when the header does not declare one. `''` means it was empty. */
function declaredCharset(header) {
  const pattern = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/gi;
  let found = false;
  let value = '';
  for (const match of String(header).matchAll(pattern)) {
    found = true;
    value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  }
  return found ? value : null;
}

function decodeResponseBody(body, truncated, charset) {
  const label = charset == null ? 'utf-8' : charset;
  let decoder;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Unsupported response charset: ${label}`);
    }
    throw error;
  }
  try {
    // A bounded prefix may end mid-character. Streaming keeps that tail buffered instead of
    // inserting a replacement character; a finished body must be valid for its charset.
    return decoder.decode(body, { stream: truncated === true });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Response body is not valid ${decoder.encoding}`);
    }
    throw error;
  }
}

export function requestPinned(url, resolved, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(options.body) : null;
    const literalHost = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const request = https.request({
      protocol: 'https:',
      hostname: resolved.address,
      family: resolved.family,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      // RFC 6066 forbids IP literals in SNI; without it Node verifies the pinned IP against the certificate's IP SANs.
      servername: net.isIP(literalHost) ? undefined : url.hostname,
      headers: {
        Accept: options.accept ?? 'text/html,text/plain,application/json;q=0.9',
        'Accept-Encoding': 'identity',
        'User-Agent': 'Flint-Web-Tool/1.0 (+https://github.com/joelst/flint)',
        Host: url.host,
        ...(body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(body.length),
        } : {}),
      },
      timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      let settled = false;
      const finish = (truncated) => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
          truncated,
        });
      };
      response.on('data', (chunk) => {
        const remaining = (options.maxBytes ?? MAX_BODY_BYTES) - bytes;
        if (remaining <= 0) {
          response.destroy();
          finish(true);
          return;
        }
        if (chunk.length > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          bytes += remaining;
          response.destroy();
          finish(true);
          return;
        }
        bytes += chunk.length;
        chunks.push(chunk);
      });
      response.on('end', () => finish(false));
      response.on('error', (error) => {
        if (!settled) reject(error);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Request timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function fetchPublicText(rawUrl, dependencies = {}) {
  const resolve = dependencies.resolve ?? dns.lookup;
  const request = dependencies.request ?? requestPinned;
  const deadlineAt = Date.now() + (dependencies.overallTimeoutMs ?? OVERALL_TIMEOUT_MS);
  // Consent approved the host already requested. Stop before a different host so
  // the app can ask again. Search leaves this on and still follows public redirects.
  const followCrossOriginRedirects = dependencies.followCrossOriginRedirects !== false;
  let current = normalizePublicUrl(rawUrl);
  let method = dependencies.method ?? 'GET';
  let body = dependencies.body ?? null;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const resolved = await withDeadline(
      resolvePublic(current.hostname, resolve),
      deadlineAt,
      'Web request timed out while resolving the host',
    );
    const response = await withDeadline(request(current, resolved, {
      maxBytes: dependencies.maxBytes ?? MAX_BODY_BYTES,
      timeoutMs: Math.min(
        dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS,
        Math.max(1, deadlineAt - Date.now()),
      ),
      method,
      body,
    }), deadlineAt, 'Web request timed out');
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      if (!location) throw new Error('Redirect response has no destination');
      if (redirects === MAX_REDIRECTS) throw new Error('Too many redirects');
      const next = normalizePublicUrl(new URL(location, current).toString());
      if (!followCrossOriginRedirects && comparableHost(next) !== comparableHost(current)) {
        return { redirectTo: next.toString() };
      }
      const dropsBody = [301, 302, 303].includes(response.statusCode);
      if (!dropsBody && body && method !== 'GET' && next.origin !== current.origin) {
        throw new Error('Cross-origin redirects cannot receive a request body');
      }
      current = next;
      if (dropsBody) {
        method = 'GET';
        body = null;
      }
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Remote server returned HTTP ${response.statusCode}`);
    }
    const rawContentType = String(response.headers['content-type'] ?? '');
    const contentType = rawContentType.split(';', 1)[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new Error(`Unsupported response content type: ${contentType || 'missing'}`);
    }
    const contentEncoding = String(response.headers['content-encoding'] ?? 'identity')
      .trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') {
      throw new Error(`Unsupported response content encoding: ${contentEncoding}`);
    }
    const charset = declaredCharset(rawContentType);
    if (charset === '') throw new Error('Unsupported response charset');
    return {
      url: current.toString(),
      statusCode: response.statusCode,
      contentType,
      body: decodeResponseBody(response.body, response.truncated === true, charset),
      truncated: response.truncated === true,
    };
  }
  throw new Error('Too many redirects');
}

function firstPageImage(html, pageUrl) {
  let page;
  try {
    page = normalizePublicUrl(pageUrl);
  } catch {
    return null;
  }
  const tags = String(html).matchAll(/<img\b[^>]*>/gi);
  for (const tag of tags) {
    const source = tag[0].match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const raw = decodeEntities(source?.[1] || source?.[2] || source?.[3] || '');
    if (!raw || /^data:/i.test(raw) || /\.svg(?:$|[?#])/i.test(raw)) continue;
    try {
      const normalized = normalizePublicUrl(new URL(raw, page).toString());
      if (comparableHost(normalized) !== comparableHost(page)) continue;
      const alt = tag[0].match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      return {
        url: normalized.toString(),
        alt: readableText(alt?.[1] || alt?.[2] || alt?.[3] || ''),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function extractPageText(html, pageUrl = '') {
  const visible = stripHiddenContent(html);
  const titleMatch = visible.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const image = pageUrl ? firstPageImage(visible, pageUrl) : null;
  return {
    title: titleMatch ? readableText(titleMatch[1]) : '',
    text: readableText(visible),
    imageUrls: image ? [image.url] : [],
    imageAlt: image?.alt || '',
  };
}

function unwrapDuckDuckGoUrl(raw) {
  const candidate = decodeEntities(raw);
  const absolute = candidate.startsWith('//') ? `https:${candidate}` : candidate;
  const parsed = new URL(absolute, 'https://html.duckduckgo.com/');
  const isDuckDuckGo = parsed.hostname === 'duckduckgo.com'
    || parsed.hostname.endsWith('.duckduckgo.com');
  if (isDuckDuckGo && parsed.pathname === '/y.js') {
    throw new Error('DuckDuckGo advertising redirects are not search results');
  }
  const unwrapped = isDuckDuckGo && parsed.searchParams.get('uddg')
    ? parsed.searchParams.get('uddg')
    : parsed.toString();
  return normalizePublicUrl(unwrapped).toString();
}

export function decodeSearchResults(html, maxResults) {
  const results = [];
  const blockPattern = /<div[^>]+class=["']([^"']*\bresult\b[^"']*)["'][^>]*>([\s\S]*?)(?=<div[^>]+class=["'][^"']*\bresult\b[^"']*["'][^>]*>|$)/gi;
  for (const match of html.matchAll(blockPattern)) {
    if (/\bresult--ad\b/i.test(match[1])) continue;
    const block = match[2];
    const link = block.match(/<a[^>]+class=["'][^"']*\bresult__a\b[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    try {
      const url = unwrapDuckDuckGoUrl(link[1]);
      if (url.length > SEARCH_URL_CHARS) continue;
      const snippetMatch = block.match(/<(?:a|div)[^>]+class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
      results.push({
        title: readableText(link[2]).slice(0, 300),
        url,
        snippet: snippetMatch ? readableText(snippetMatch[1]).slice(0, 1_000) : '',
      });
    } catch {
      continue;
    }
    if (results.length >= maxResults) break;
  }
  return results;
}

export async function executeWebRequest(raw, dependencies = {}) {
  const request = normalizeRequest(raw);
  if (request.operation === 'search') {
    const body = new URLSearchParams({ q: request.query }).toString();
    const page = await fetchPublicText('https://html.duckduckgo.com/html/', {
      ...dependencies,
      method: 'POST',
      body,
    });
    // The challenge page is identified by its markup. The sentence "bots use DuckDuckGo too"
    // also appears in ordinary result snippets and must not fail a completed search.
    if (page.statusCode !== 200 || /anomaly-modal|challenge-form/i.test(page.body)) {
      throw new Error('Public search service returned a bot challenge');
    }
    return {
      operation: 'search',
      query: request.query,
      results: decodeSearchResults(page.body, request.maxResults),
    };
  }
  if (request.operation === 'image') {
    return fetchPublicImage(request.url, dependencies);
  }
  // Model fetches and URL-chip fetches omit the flag, so a different host
  // comes back as a redirect. The chip checks the device blocklist before each hop.
  // Same-origin redirects still stay inside this request.
  const page = await fetchPublicText(request.url, {
    ...dependencies,
    followCrossOriginRedirects: request.followCrossOriginRedirects === true,
  });
  if (page.redirectTo) {
    return { operation: 'redirect', url: page.redirectTo };
  }
  const extracted = page.contentType === 'text/html'
    ? extractPageText(page.body, page.url)
    : { title: '', text: page.body.replace(/\s+/g, ' ').trim(), imageUrls: [], imageAlt: '' };
  const truncated = page.truncated || extracted.text.length > request.maxChars;
  return {
    operation: 'fetch',
    url: page.url,
    title: extracted.title.slice(0, 300),
    text: extracted.text.slice(0, request.maxChars),
    truncated,
    charCount: Math.min(extracted.text.length, request.maxChars),
    imageUrls: extracted.imageUrls ?? [],
    imageAlt: extracted.imageAlt ?? '',
  };
}

async function fetchPublicImage(rawUrl, dependencies = {}) {
  const resolve = dependencies.resolve ?? dns.lookup;
  const request = dependencies.request ?? requestPinned;
  const deadlineAt = Date.now() + (dependencies.overallTimeoutMs ?? OVERALL_TIMEOUT_MS);
  let current = normalizePublicUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const resolved = await withDeadline(
      resolvePublic(current.hostname, resolve),
      deadlineAt,
      'Web request timed out while resolving the host',
    );
    const response = await withDeadline(request(current, resolved, {
      maxBytes: MAX_BODY_BYTES,
      timeoutMs: Math.min(REQUEST_TIMEOUT_MS, Math.max(1, deadlineAt - Date.now())),
      method: 'GET',
      accept: 'image/jpeg,image/png,image/webp,image/gif,image/bmp;q=0.9',
    }), deadlineAt, 'Web request timed out');
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      if (!location) throw new Error('Redirect response has no destination');
      if (redirects === MAX_REDIRECTS) throw new Error('Too many redirects');
      const next = normalizePublicUrl(new URL(location, current).toString());
      if (comparableHost(next) !== comparableHost(current)) {
        return { operation: 'redirect', url: next.toString() };
      }
      current = next;
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Remote server returned HTTP ${response.statusCode}`);
    }
    const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      throw new Error(`Unsupported response content encoding: ${encoding}`);
    }
    const body = response.body;
    if (!Buffer.isBuffer(body)) throw new Error('Image response was not bytes');
    if (body.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the byte limit');
    const format = detectImageFormat(new Uint8Array(body));
    if (!format || format === 'svg') throw new Error('Unsupported image');
    return {
      operation: 'image',
      url: current.toString(),
      mediaType: `image/${format}`,
      dataBase64: body.toString('base64'),
    };
  }
  throw new Error('Too many redirects');
}

async function readInput(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Input exceeds the byte limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Run one request from `input` and write one JSON line. Resolves to the process exit code. */
export async function runHelper(
  input = process.stdin,
  write = (line) => process.stdout.write(line),
  dependencies = {},
) {
  try {
    const raw = JSON.parse(await readInput(input));
    const result = await executeWebRequest(raw, dependencies);
    const output = JSON.stringify({ ok: true, result });
    const outputLimit = raw?.operation === 'image' ? MAX_IMAGE_OUTPUT_BYTES : MAX_OUTPUT_BYTES;
    if (Buffer.byteLength(output) > outputLimit) throw new Error('Output exceeds the byte limit');
    write(`${output}\n`);
    return 0;
  } catch (error) {
    write(`${JSON.stringify({ ok: false, error: error?.message || String(error) })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runHelper();
}
