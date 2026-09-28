export type ImageHeaderFormat = "png" | "jpeg" | "gif" | "webp" | "bmp";

export interface ImageDimensions {
  format: ImageHeaderFormat;
  width: number;
  height: number;
}

export const MAX_NATIVE_IMAGE_PIXELS: number;
export function detectImageFormat(bytes: Uint8Array): ImageHeaderFormat | null;
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null;
