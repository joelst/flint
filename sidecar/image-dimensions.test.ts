// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_NATIVE_IMAGE_PIXELS,
  detectImageFormat,
  parseImageDataUrl,
  readImageDimensions,
} from './image-dimensions.js';
import { TINY_PNG_BYTES, imageDataUrl, pngBytes, pngDataUrl } from './test-fixtures/images';

const bytes = (...parts: Array<number[] | string>) => new Uint8Array(parts.flatMap((part) =>
  typeof part === 'string' ? Array.from(part, (c) => c.charCodeAt(0)) : part));
const le16 = (v: number) => [v & 255, (v >>> 8) & 255];
const le24 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];
const le32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const be16 = (v: number) => [(v >>> 8) & 255, v & 255];

function gif({ screen = [10, 10], frames = [] as Array<[number, number, number, number]>, gct = false } = {}) {
  const out: Array<number[] | string> = ['GIF89a', le16(screen[0]), le16(screen[1]), [gct ? 0x80 : 0, 0, 0]];
  if (gct) out.push(new Array(6).fill(0));
  out.push([0x21, 0xf9, 4, 0, 0, 0, 0, 0]);
  for (const [left, top, width, height] of frames) {
    out.push([0x2c], le16(left), le16(top), le16(width), le16(height), [0x81], new Array(12).fill(0), [2, 1, 0, 0]);
  }
  out.push([0x3b]);
  return bytes(...out);
}

function jpeg(width: number, height: number, { app = 0, marker = 0xc0 } = {}) {
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe0], be16(app + 2), new Array(app).fill(0),
    [0xff, 0xff, marker], be16(17), [8], be16(height), be16(width), new Array(12).fill(0),
  );
}

const riff = (chunk: string, body: number[]) => bytes('RIFF', le32(4 + 8 + body.length), 'WEBP', chunk, le32(body.length), body);

describe('readImageDimensions', () => {
  it('reads PNG IHDR dimensions', () => {
    expect(readImageDimensions(pngBytes(10_000, 7))).toEqual({ format: 'png', width: 10_000, height: 7 });
    expect(readImageDimensions(pngBytes(0, 7))).toBeNull();
    expect(readImageDimensions(pngBytes(4, 4).slice(0, 20))).toBeNull();
    const notIhdr = pngBytes(4, 4);
    notIhdr[12] = 0x58;
    expect(readImageDimensions(notIhdr)).toBeNull();
  });

  it('uses the largest GIF frame extent, because decoders grow the canvas to fit it', () => {
    expect(readImageDimensions(gif({ screen: [10, 12] }))).toEqual({ format: 'gif', width: 10, height: 12 });
    expect(readImageDimensions(gif({ screen: [1, 1], frames: [[5, 6, 9000, 8000]], gct: true })))
      .toEqual({ format: 'gif', width: 9005, height: 8006 });
    expect(readImageDimensions(gif({ frames: [[0, 0, 4, 4]] }).slice(0, 24))).toBeNull();
    const unterminated = gif();
    expect(readImageDimensions(unterminated.slice(0, unterminated.length - 3))).toBeNull();
    const unknownBlock = gif();
    unknownBlock[unknownBlock.length - 1] = 0x99;
    expect(readImageDimensions(unknownBlock)).toBeNull();
  });

  it('finds the JPEG frame header after other segments and fill bytes', () => {
    expect(readImageDimensions(jpeg(4032, 3024, { app: 300 }))).toEqual({ format: 'jpeg', width: 4032, height: 3024 });
    expect(readImageDimensions(jpeg(640, 480, { marker: 0xc2 }))).toEqual({ format: 'jpeg', width: 640, height: 480 });
    // DHT (C4) shares the SOF range but is not a frame header.
    expect(readImageDimensions(jpeg(640, 480, { marker: 0xc4 }))).toBeNull();
    expect(readImageDimensions(jpeg(640, 0))).toBeNull();
    expect(readImageDimensions(bytes([0xff, 0xd8, 0xff, 0xd0, 0xff, 0xda, 0, 2]))).toBeNull();
    expect(readImageDimensions(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 1]))).toBeNull();
    expect(readImageDimensions(bytes([0xff, 0xd8, 0x00]))).toBeNull();
    expect(readImageDimensions(jpeg(640, 480).slice(0, 12))).toBeNull();
  });

  it('reads lossy, lossless, and extended WebP headers', () => {
    const lossy = [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(800 | 0xc000), ...le16(600), 0, 0];
    expect(readImageDimensions(riff('VP8 ', lossy))).toEqual({ format: 'webp', width: 800, height: 600 });
    const badStart = [...lossy];
    badStart[3] = 0;
    expect(readImageDimensions(riff('VP8 ', badStart))).toBeNull();

    const packed = ((1023 - 1) | ((767 - 1) << 14)) >>> 0;
    const lossless = [0x2f, ...le32(packed), 0, 0, 0, 0, 0];
    expect(readImageDimensions(riff('VP8L', lossless))).toEqual({ format: 'webp', width: 1023, height: 767 });
    const minimalLossless = riff('VP8L', [0x2f, ...le32(packed)]);
    expect(minimalLossless.length).toBe(25);
    expect(readImageDimensions(minimalLossless)).toEqual({ format: 'webp', width: 1023, height: 767 });
    expect(readImageDimensions(minimalLossless.slice(0, 24))).toBeNull();
    expect(readImageDimensions(riff('VP8L', [0, ...lossless.slice(1)]))).toBeNull();

    const extended = [0, 0, 0, 0, ...le24(20_000 - 1), ...le24(30 - 1), 0, 0];
    expect(readImageDimensions(riff('VP8X', extended))).toEqual({ format: 'webp', width: 20_000, height: 30 });
    expect(readImageDimensions(riff('ALPH', extended))).toBeNull();
    expect(readImageDimensions(riff('VP8X', [0]))).toBeNull();
  });

  it('reads core and info BMP headers, including top-down heights', () => {
    const core = bytes('BM', new Array(12).fill(0), le32(12), le16(64), le16(32), le16(1), new Array(6).fill(0));
    expect(readImageDimensions(core)).toEqual({ format: 'bmp', width: 64, height: 32 });
    const info = bytes('BM', new Array(12).fill(0), le32(40), le32(300), le32(-200), le16(1), new Array(6).fill(0));
    expect(readImageDimensions(info)).toEqual({ format: 'bmp', width: 300, height: 200 });
    const negativeWidth = bytes('BM', new Array(12).fill(0), le32(40), le32(-3), le32(2), le16(1), new Array(6).fill(0));
    expect(readImageDimensions(negativeWidth)).toBeNull();
    const unknownHeader = bytes('BM', new Array(12).fill(0), le32(20), le32(3), le32(2), le16(1), new Array(6).fill(0));
    expect(readImageDimensions(unknownHeader)).toBeNull();
    const zeroPlanes = bytes('BM', new Array(12).fill(0), le32(40), le32(3), le32(2), le16(0), new Array(6).fill(0));
    expect(readImageDimensions(zeroPlanes)).toBeNull();
    expect(readImageDimensions(bytes('BM', [0, 0]))).toBeNull();
  });

  it('does not mistake text that starts with "BM" for a bitmap', () => {
    for (const text of ['BM25 is a ranking function used by search engines.', 'BMW\n'.repeat(10)]) {
      const encoded = bytes(text);
      expect(detectImageFormat(encoded)).toBeNull();
      expect(readImageDimensions(encoded)).toBeNull();
    }
  });

  it('treats unrecognized and non-byte input as unknown', () => {
    expect(readImageDimensions(bytes([1, 2, 3]))).toBeNull();
    expect(readImageDimensions(new Uint8Array())).toBeNull();
    expect(readImageDimensions([0x89, 0x50] as unknown as Uint8Array)).toBeNull();
  });

  it('admits legacy phone photos but not decoder-sized bombs', () => {
    expect(4032 * 3024).toBeLessThanOrEqual(MAX_NATIVE_IMAGE_PIXELS);
    expect(10_000 * 10_000).toBeGreaterThan(MAX_NATIVE_IMAGE_PIXELS);
  });
});

describe('detectImageFormat', () => {
  it('names the format from a short signature prefix alone', () => {
    const head = (b: Uint8Array) => b.slice(0, 16);
    expect(detectImageFormat(head(pngBytes(1, 1)))).toBe('png');
    expect(detectImageFormat(head(gif()))).toBe('gif');
    expect(detectImageFormat(head(jpeg(1, 1)))).toBe('jpeg');
    expect(detectImageFormat(bytes('RIFF', [0, 0, 0, 0], 'WEBP'))).toBe('webp');
    expect(detectImageFormat(bytes('BM', new Array(12).fill(0), le32(40), le32(1), le32(1), le16(1)))).toBe('bmp');
    expect(detectImageFormat(bytes('BM'))).toBeNull();
    expect(detectImageFormat(bytes('<svg'))).toBeNull();
    expect(detectImageFormat(bytes([0, 0, 0, 0x18], 'ftypheic'))).toBeNull();
    expect(detectImageFormat('PNG' as unknown as Uint8Array)).toBeNull();
  });
});

describe('parseImageDataUrl', () => {
  it('returns the header format, dimensions, and decoded bytes of a bounded raster', () => {
    const parsed = parseImageDataUrl(imageDataUrl(TINY_PNG_BYTES, 'image/jpeg'));
    expect(parsed).toMatchObject({ ok: true, format: 'png', width: 1, height: 1 });
    expect(parsed.ok && Array.from(parsed.bytes)).toEqual(Array.from(TINY_PNG_BYTES));
  });

  it('names why a URL is refused, checking length before decoding anything', () => {
    expect(parseImageDataUrl(42)).toEqual({ ok: false, reason: 'size' });
    expect(parseImageDataUrl(`data:image/png;base64,${'A'.repeat(MAX_IMAGE_DATA_URL_CHARS)}`))
      .toEqual({ ok: false, reason: 'size' });
    expect(parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toEqual({ ok: false, reason: 'format' });
    expect(parseImageDataUrl('file:///private/image.png')).toEqual({ ok: false, reason: 'format' });
    expect(parseImageDataUrl('data:image/png;base64,A')).toEqual({ ok: false, reason: 'base64' });
    expect(parseImageDataUrl('data:image/png;base64,AQID')).toEqual({ ok: false, reason: 'header' });
    expect(parseImageDataUrl(pngDataUrl(10_000, 10_000)))
      .toEqual({ ok: false, reason: 'pixels', width: 10_000, height: 10_000 });
  });
});
