import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;
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
    if (raw) {
      const radix = raw[0].toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? raw.slice(1) : raw;
      const codePoint = Number.parseInt(digits, radix);
      return Number.isInteger(codePoint)
        && codePoint >= 0
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : '';
    }
    return '';
  });
}

function stripMarkup(value) {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ')
    .trim();
}

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Range(address, base, prefix) {
  const value = ipv4Number(address);
  const baseValue = ipv4Number(base);
  if (value === null || baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function ipv6Number(address) {
  const withoutZone = address.split('%', 1)[0].toLowerCase();
  let value = withoutZone;
  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Tail) {
    const ipv4 = ipv4Number(ipv4Tail[1]);
    if (ipv4 === null) return null;
    value = `${value.slice(0, -ipv4Tail[1].length)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
}

function inV6Range(address, base, prefix) {
  const value = ipv6Number(address);
  const baseValue = ipv6Number(base);
  if (value === null || baseValue === null) return false;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (baseValue >> shift);
}

export function isDeniedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) => inV4Range(address, base, prefix));
  }
  if (family === 6) {
    if (inV6Range(address, '::', 96)) {
      const value = ipv6Number(address);
      const ipv4 = Number(value & 0xffffffffn);
      return isDeniedAddress([
        (ipv4 >>> 24) & 0xff,
        (ipv4 >>> 16) & 0xff,
        (ipv4 >>> 8) & 0xff,
        ipv4 & 0xff,
      ].join('.'));
    }
    if (inV6Range(address, '::ffff:0:0', 96)) {
      const value = ipv6Number(address);
      const ipv4 = Number(value & 0xffffffffn);
      return isDeniedAddress([
        (ipv4 >>> 24) & 0xff,
        (ipv4 >>> 16) & 0xff,
        (ipv4 >>> 8) & 0xff,
        ipv4 & 0xff,
      ].join('.'));
    }
    return [
      ['::', 128],
      ['::1', 128],
      ['64:ff9b::', 96],
      ['::ffff:0:0:0', 96],
      ['64:ff9b:1::', 48],
      ['100::', 64],
      ['2001::', 23],
      ['2001:db8::', 32],
      ['2002::', 16],
      ['3fff::', 20],
      ['5f00::', 16],
      ['fc00::', 7],
      ['fec0::', 10],
      ['fe80::', 10],
      ['ff00::', 8],
    ].some(([base, prefix]) => inV6Range(address, base, prefix));
  }
  return true;
}

function normalizePublicUrl(raw) {
  const parsed = new URL(String(raw).trim());
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed');
  if (parsed.username || parsed.password) throw new Error('URL credentials are not allowed');
  if (parsed.port && parsed.port !== '443') throw new Error('Only the standard HTTPS port is allowed');
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Local hostnames are not allowed');
  }
  parsed.hash = '';
  return parsed;
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
    if (Object.keys(raw).some((key) => !['operation', 'url', 'maxChars'].includes(key))) {
      throw new Error('Fetch request contains an unsupported field');
    }
    const url = normalizePublicUrl(raw.url).toString();
    const requested = Number.isInteger(raw.maxChars) ? raw.maxChars : 20_000;
    return { operation: 'fetch', url, maxChars: Math.min(MAX_TEXT_CHARS, Math.max(1_000, requested)) };
  }
  throw new Error('Operation must be search or fetch');
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

function decodeResponseBody(body, truncated) {
  if (!truncated) return body.toString('utf8');
  const decoder = new StringDecoder('utf8');
  return decoder.write(body);
}

export function requestPinned(url, resolved, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(options.body) : null;
    const request = https.request({
      protocol: 'https:',
      hostname: resolved.address,
      family: resolved.family,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      servername: url.hostname,
      headers: {
        Accept: 'text/html,text/plain,application/json;q=0.9',
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
    const contentType = String(response.headers['content-type'] ?? '')
      .split(';', 1)[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new Error(`Unsupported response content type: ${contentType || 'missing'}`);
    }
    const contentEncoding = String(response.headers['content-encoding'] ?? 'identity')
      .trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') {
      throw new Error(`Unsupported response content encoding: ${contentEncoding}`);
    }
    return {
      url: current.toString(),
      statusCode: response.statusCode,
      contentType,
      body: decodeResponseBody(response.body, response.truncated === true),
      truncated: response.truncated === true,
    };
  }
  throw new Error('Too many redirects');
}

function extractPageText(html) {
  const withoutActive = html
    .replace(/<(script|style|noscript|svg|iframe|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const titleMatch = withoutActive.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: titleMatch ? stripMarkup(titleMatch[1]) : '',
    text: stripMarkup(withoutActive),
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
      const snippetMatch = block.match(/<(?:a|div)[^>]+class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
      results.push({
        title: stripMarkup(link[2]).slice(0, 300),
        url,
        snippet: snippetMatch ? stripMarkup(snippetMatch[1]).slice(0, 1_000) : '',
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
    if (page.statusCode !== 200
      || /anomaly-modal|challenge-form|bots use duckduckgo too/i.test(page.body)) {
      throw new Error('Public search service returned a bot challenge');
    }
    return {
      operation: 'search',
      query: request.query,
      results: decodeSearchResults(page.body, request.maxResults),
    };
  }
  const page = await fetchPublicText(request.url, dependencies);
  const extracted = page.contentType === 'text/html'
    ? extractPageText(page.body)
    : { title: '', text: page.body.replace(/\s+/g, ' ').trim() };
  const truncated = page.truncated || extracted.text.length > request.maxChars;
  return {
    operation: 'fetch',
    url: page.url,
    title: extracted.title.slice(0, 300),
    text: extracted.text.slice(0, request.maxChars),
    truncated,
    charCount: Math.min(extracted.text.length, request.maxChars),
  };
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Input exceeds the byte limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  try {
    const raw = JSON.parse(await readStdin());
    const result = await executeWebRequest(raw);
    const output = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error('Output exceeds the byte limit');
    process.stdout.write(`${output}\n`);
  } catch (error) {
    const output = JSON.stringify({ ok: false, error: error?.message || String(error) });
    process.stdout.write(`${output}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
