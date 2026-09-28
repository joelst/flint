// Minimal encoded image headers for tests. Only the header fields dimension readers inspect
// are meaningful; nothing here is decodable pixel data.

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const be32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];

export function pngBytes(width: number, height: number, padding = 0): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ...be32(width), ...be32(height),
    8, 6, 0, 0, 0, 0, 0, 0, 0,
    ...new Array(padding).fill(0),
  ]);
}

export function imageDataUrl(bytes: Uint8Array, mime = 'image/png'): string {
  return `data:${mime};base64,${toBase64(bytes)}`;
}

export function pngDataUrl(width: number, height: number, padding = 0): string {
  return imageDataUrl(pngBytes(width, height, padding));
}

export const TINY_PNG_BYTES = pngBytes(1, 1);
export const TINY_PNG_DATA_URL = pngDataUrl(1, 1);
