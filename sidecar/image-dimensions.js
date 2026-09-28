// Reads raster dimensions from encoded header bytes without decoding pixels.
//
// Encoded size says nothing about decoded size: a 10,000 x 10,000 1-bit PNG compresses to a
// few kilobytes but expands to hundreds of megabytes in a decoder. Every boundary that hands
// image bytes to a decoder (the webview's createImageBitmap, the native ChatSession image
// item) must therefore bound pixels from the header first.
//
// Imports nothing, not even Node builtins, so the browser bundle and the sidecar apply the
// identical rules (same convention as prompt-template.js).

/** Native decoder budget. 4096 x 4096 admits legacy phone photos stored before compaction. */
export const MAX_NATIVE_IMAGE_PIXELS = 4096 * 4096;

/**
 * Images one request may carry. Each is bounded by MAX_NATIVE_IMAGE_PIXELS, so this bounds the
 * whole request's decode (4 x 64 MiB RGBA). Matches the composer's per-turn cap, so the turn
 * being sent always fits; the request builder keeps the newest images and omits older ones.
 */
export const MAX_REQUEST_IMAGES = 4;

/** Whole-conversation webview preview budget: at most 64 MiB of RGBA pixels and four images. */
export const MAX_CONVERSATION_PREVIEW_PIXELS = MAX_NATIVE_IMAGE_PIXELS;
export const MAX_CONVERSATION_PREVIEW_IMAGES = MAX_REQUEST_IMAGES;

/** Largest stored image data URL Flint will decode, preview, or send. */
export const MAX_IMAGE_DATA_URL_CHARS = 350_000;

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const ascii = (b, i, s) => {
  if (i + s.length > b.length) return false;
  for (let k = 0; k < s.length; k += 1) if (b[i + k] !== s.charCodeAt(k)) return false;
  return true;
};

function result (format, width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { format, width, height }
    : null;
}

function png (b) {
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
  return result('png', u32be(b, 16), u32be(b, 20));
}

// Decoders grow the canvas to fit any frame that exceeds the logical screen, so the extent
// is the maximum over the screen and every image descriptor.
function gif (b) {
  if (b.length < 13) return null;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  let i = 13;
  if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 0x07) + 1));
  const skipSubBlocks = () => {
    while (i < b.length) {
      const size = b[i];
      i += 1;
      if (size === 0) return true;
      i += size;
    }
    return false;
  };
  while (i < b.length) {
    const block = b[i];
    if (block === 0x3b) break;
    if (block === 0x21) {
      i += 2;
      if (!skipSubBlocks()) return null;
    } else if (block === 0x2c) {
      if (i + 10 > b.length) return null;
      width = Math.max(width, u16le(b, i + 1) + u16le(b, i + 5));
      height = Math.max(height, u16le(b, i + 3) + u16le(b, i + 7));
      const packed = b[i + 9];
      i += 10;
      if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1));
      i += 1;
      if (!skipSubBlocks()) return null;
    } else {
      return null;
    }
  }
  return result('gif', width, height);
}

function jpeg (b) {
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i += 1;
    if (i >= b.length) return null;
    const marker = b[i];
    i += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (i + 2 > b.length) return null;
    const length = u16be(b, i);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 7 > b.length) return null;
      // A zero height defers to a later DNL marker; treat it as unknown rather than guess.
      return result('jpeg', u16be(b, i + 5), u16be(b, i + 3));
    }
    i += length;
  }
  return null;
}

function webp (b) {
  if (b.length < 30) return null;
  if (ascii(b, 12, 'VP8 ')) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return result('webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return result('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, 'VP8X')) {
    return result('webp', u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return null;
}

function bmp (b) {
  if (b.length < 26) return null;
  const headerSize = b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24);
  if (headerSize === 12) return result('bmp', u16le(b, 18), u16le(b, 20));
  if (headerSize < 40) return null;
  return result('bmp', i32le(b, 18), Math.abs(i32le(b, 22)));
}

const BMP_HEADER_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

// "BM" alone is two printable letters (a Markdown file can open with "BM25"), so a BMP is only
// recognized with a known DIB header size and a colour-plane count of exactly one.
function isBmp (b) {
  if (!ascii(b, 0, 'BM') || b.length < 18) return false;
  const headerSize = (b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24)) >>> 0;
  if (!BMP_HEADER_SIZES.has(headerSize)) return false;
  const planes = headerSize === 12 ? 22 : 26;
  return b.length >= planes + 2 && u16le(b, planes) === 1;
}

/**
 * The raster format the leading bytes announce, or null. A match says what a decoder would
 * try, not that the header is complete. The first 28 bytes suffice for every format.
 */
export function detectImageFormat (bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n')) return 'png';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'gif';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (isBmp(b)) return 'bmp';
  return null;
}

const HEADER_READERS = { png, gif, jpeg, webp, bmp };

/**
 * Dimensions and the format the bytes actually encode, or null when the header is not a
 * complete, recognizable PNG, GIF, JPEG, WebP, or BMP header. Callers must treat null as
 * unbounded, never as small.
 */
export function readImageDimensions (bytes) {
  const format = detectImageFormat(bytes);
  return format ? HEADER_READERS[format](bytes) : null;
}

const IMAGE_DATA_URL = /^data:image\/(bmp|gif|jpeg|jpg|png|webp);base64,([a-z0-9+/]*={0,2})$/i;

/**
 * Validate a stored image data URL before anything decodes it: encoded length, a raster label,
 * base64 payload, a readable header, and the native pixel budget. The label is only a gate;
 * `format` is what the header encodes. Stored and imported images never passed composer
 * compaction, so every consumer (webview preview, native request) must go through this.
 *
 * Returns `{ ok: true, format, width, height, bytes }` or `{ ok: false, reason }` with reason
 * one of 'size', 'format', 'base64', 'header', 'pixels' ('pixels' also carries dimensions).
 */
export function parseImageDataUrl (url) {
  if (typeof url !== 'string' || url.length > MAX_IMAGE_DATA_URL_CHARS) return { ok: false, reason: 'size' };
  const match = IMAGE_DATA_URL.exec(url);
  if (!match) return { ok: false, reason: 'format' };
  let decoded;
  try {
    decoded = atob(match[2]);
  } catch {
    return { ok: false, reason: 'base64' };
  }
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
  const dimensions = readImageDimensions(bytes);
  if (!dimensions) return { ok: false, reason: 'header' };
  if (dimensions.width * dimensions.height > MAX_NATIVE_IMAGE_PIXELS) {
    return { ok: false, reason: 'pixels', width: dimensions.width, height: dimensions.height };
  }
  return { ok: true, ...dimensions, bytes };
}
