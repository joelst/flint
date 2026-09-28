export type ImageHeaderFormat = "png" | "jpeg" | "gif" | "webp" | "bmp";

export interface ImageDimensions {
  format: ImageHeaderFormat;
  width: number;
  height: number;
}

export const MAX_NATIVE_IMAGE_PIXELS: number;
export const MAX_REQUEST_IMAGES: number;
export const MAX_CONVERSATION_PREVIEW_PIXELS: number;
export const MAX_CONVERSATION_PREVIEW_IMAGES: number;
export const MAX_IMAGE_DATA_URL_CHARS: number;
export function detectImageFormat(bytes: Uint8Array): ImageHeaderFormat | null;
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null;

export type ParsedImageDataUrl =
  | (ImageDimensions & { ok: true; bytes: Uint8Array })
  | { ok: false; reason: "size" | "format" | "base64" | "header" }
  | { ok: false; reason: "pixels"; width: number; height: number };
export function parseImageDataUrl(url: unknown): ParsedImageDataUrl;
