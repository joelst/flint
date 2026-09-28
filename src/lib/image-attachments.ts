import { readImageDimensions } from "../../sidecar/image-dimensions.js";

export const MAX_ATTACHED_IMAGES = 4;
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_DATA_URL_CHARS = 350_000;
export const MAX_CONVERSATION_STORAGE_CHARS = 4_000_000;
/** Largest source the webview is asked to decode for resizing (about 256 MB of RGBA). */
export const MAX_SOURCE_IMAGE_PIXELS = 64 * 1024 * 1024;

export const MAX_IMAGE_DIMENSION = 1600;
/** File-picker filter for the formats `compactImageAttachment` can bound before decoding. */
export const IMAGE_ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/bmp";
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:bmp|gif|jpeg|jpg|png|webp);base64,/i;

function dataUrlPayloadBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  let decoded: string;
  try {
    decoded = atob(dataUrl.slice(comma + 1));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

export function imageDataUrlBytes(dataUrl: string): number | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !SAFE_IMAGE_DATA_URL.test(dataUrl)) return null;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

export function imageAttachmentFitsArchive(
  archiveChars: number,
  otherStorageChars: number,
): boolean {
  return archiveChars >= 0
    && otherStorageChars >= 0
    && archiveChars + otherStorageChars < MAX_CONVERSATION_STORAGE_CHARS;
}

export function storageCharsExcluding(
  storage: Pick<Storage, "length" | "key" | "getItem">,
  excludedKey: string,
): number {
  const firstKeys = listStorageKeys(storage);
  let chars = 0;
  for (const key of firstKeys) {
    if (key === excludedKey) continue;
    chars += key.length + (storage.getItem(key)?.length ?? 0);
  }
  const secondKeys = listStorageKeys(storage);
  if (!sameKeys(firstKeys, secondKeys)) {
    throw new Error("Local storage changed while its size was being checked.");
  }
  return chars;
}

function listStorageKeys(storage: Pick<Storage, "length" | "key">): Set<string> {
  const count = storage.length;
  const keys = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const key = storage.key(index);
    if (key === null || keys.has(key)) {
      throw new Error("Local storage changed while its size was being checked.");
    }
    keys.add(key);
  }
  if (storage.length !== count) {
    throw new Error("Local storage changed while its size was being checked.");
  }
  return keys;
}

function sameKeys(first: Set<string>, second: Set<string>): boolean {
  if (first.size !== second.size) return false;
  for (const key of first) if (!second.has(key)) return false;
  return true;
}

export function preparedImageStillOwned(
  ownerConversation: string | null,
  currentConversation: string | null,
  ownerEpoch: number,
  currentEpoch: number,
  visionEnabled: boolean,
): boolean {
  return ownerConversation === currentConversation
    && ownerEpoch === currentEpoch
    && visionEnabled;
}

export async function prepareImageBatch<TFile>(
  files: readonly TFile[],
  isOwned: () => boolean,
  prepare: (file: TFile) => Promise<string>,
  onPrepared: (dataUrl: string) => void,
  onError: (file: TFile, error: unknown) => void,
  onStart: () => void,
  onFinish: () => void,
): Promise<void> {
  for (const file of files) {
    if (!isOwned()) return;
    onStart();
    try {
      const dataUrl = await prepare(file);
      if (!isOwned()) return;
      onPrepared(dataUrl);
    } catch (error) {
      if (!isOwned()) return;
      onError(file, error);
    } finally {
      onFinish();
    }
  }
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("The image could not be compressed.")),
      "image/jpeg",
      quality,
    );
  });
}

export async function compactImageAttachment(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error(`${file.name || "The selected file"} is not an image.`);
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`${file.name || "The selected image"} is larger than 20 MB.`);
  }

  const original = await readBlobAsDataUrl(file);
  const label = file.name || "The selected image";
  // Encoded size does not bound decoded size, so every decision below starts from the
  // dimensions in the file's own header, whatever MIME type it declares. A file this module
  // cannot parse (SVG, HEIC, AVIF, corrupt data) is refused rather than handed to a decoder
  // that might expand it without limit.
  const payload = dataUrlPayloadBytes(original);
  const header = payload ? readImageDimensions(payload) : null;
  if (!header) {
    throw new Error(`${label} is not a readable PNG, JPEG, GIF, WebP, or BMP image.`);
  }
  if (header.width * header.height > MAX_SOURCE_IMAGE_PIXELS) {
    throw new Error(`${label} is ${header.width}x${header.height}, too large to prepare safely.`);
  }
  if (
    SAFE_IMAGE_DATA_URL.test(original)
    && original.length <= MAX_ATTACHMENT_DATA_URL_CHARS
    && Math.max(header.width, header.height) <= MAX_IMAGE_DIMENSION
  ) {
    return original;
  }

  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width < 1 || bitmap.height < 1) {
      throw new Error(`${label} has invalid dimensions.`);
    }
    let scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    let quality = 0.86;
    let lastLength = Number.POSITIVE_INFINITY;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image compression is unavailable in this webview.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      const compacted = await readBlobAsDataUrl(await canvasBlob(canvas, quality));
      if (compacted.length <= MAX_ATTACHMENT_DATA_URL_CHARS) return compacted;
      if (compacted.length >= lastLength && scale <= 0.35) break;
      lastLength = compacted.length;
      scale *= 0.78;
      quality = Math.max(0.48, quality - 0.08);
    }
  } finally {
    bitmap.close();
  }

  throw new Error(`${label} could not be reduced enough to save safely.`);
}
