import { detectImageFormat, readImageDimensions } from "../../sidecar/image-dimensions.js";
import { isSupportedTextAttachment } from "./text-attachments";

export const MAX_ATTACHED_IMAGES = 4;
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_DATA_URL_CHARS = 350_000;
export const MAX_OPTIMIZED_IMAGE_BYTES = 200 * 1024;
export const MAX_CONVERSATION_STORAGE_CHARS = 4_000_000;
/** Largest source the webview is asked to decode for resizing (about 256 MB of RGBA). */
export const MAX_SOURCE_IMAGE_PIXELS = 64 * 1024 * 1024;

export const MAX_IMAGE_DIMENSION = 1600;
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
  const firstValues = new Map<string, string | null>();
  for (const key of firstKeys) {
    const value = storage.getItem(key);
    firstValues.set(key, value);
    chars += key.length + (key === excludedKey ? 0 : (value?.length ?? 0));
  }
  const secondKeys = listStorageKeys(storage);
  if (!sameKeys(firstKeys, secondKeys)) {
    throw new Error("Local storage changed while its size was being checked.");
  }
  for (const key of secondKeys) {
    if (storage.getItem(key) !== firstValues.get(key)) {
      throw new Error("Local storage changed while its size was being checked.");
    }
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

/**
 * Prepares files one at a time while the batch is still owned. `hasRoom` is consulted before each
 * file, so a failed preparation leaves its slot to the next file; returns how many files were
 * skipped because there was no room.
 */
export async function prepareImageBatch<TFile>(
  files: readonly TFile[],
  isOwned: () => boolean,
  prepare: (file: TFile) => Promise<string>,
  onPrepared: (dataUrl: string) => void,
  onError: (file: TFile, error: unknown) => void,
  onStart: () => void,
  onFinish: () => void,
  hasRoom: () => boolean = () => true,
): Promise<number> {
  for (const [index, file] of files.entries()) {
    if (!isOwned()) return 0;
    if (!hasRoom()) return files.length - index;
    onStart();
    try {
      const dataUrl = await prepare(file);
      if (!isOwned()) return 0;
      onPrepared(dataUrl);
    } catch (error) {
      if (!isOwned()) return 0;
      onError(file, error);
    } finally {
      onFinish();
    }
  }
  return 0;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

const SIGNATURE_BYTES = 32;

function readBlobHead(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob.slice(0, SIGNATURE_BYTES));
  });
}

/**
 * Files a paste should attach, or an empty list when the default paste must run. A clipboard
 * that also carries plain text (Office copies a picture rendering alongside cells or
 * paragraphs) keeps its text paste, so the user's text is never swallowed.
 */
export function clipboardAttachmentFiles(
  items: ArrayLike<Pick<DataTransferItem, "kind" | "type" | "getAsFile">>,
): File[] {
  const list = Array.from(items);
  if (list.some((item) => item.kind === "string" && item.type === "text/plain")) return [];
  return list
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export interface PartitionedAttachments {
  images: File[];
  texts: File[];
  /** Supported images that arrived while no vision model is selected. */
  needsVision: File[];
  unsupported: File[];
}

const NOTICE_NAME_LIMIT = 3;

function namedList(files: readonly File[]): string {
  const names = files.slice(0, NOTICE_NAME_LIMIT).map((file) => file.name || "unnamed file");
  const extra = files.length - names.length;
  return extra > 0 ? `${names.join(", ")} and ${extra} more` : names.join(", ");
}

/**
 * What to tell the user about files a batch did not attach, or null when nothing was refused.
 * Reported even when other files in the same batch were attached, so a refusal is never silent.
 */
export function rejectedAttachmentNotice(
  { needsVision, unsupported, modelChanged = [] }:
    Pick<PartitionedAttachments, "needsVision" | "unsupported"> & { modelChanged?: readonly File[] },
): string | null {
  const notices: string[] = [];
  if (unsupported.length > 0) {
    notices.push(`Not attached (not a supported text, code, or image file): ${namedList(unsupported)}.`);
  }
  if (needsVision.length > 0) {
    notices.push(`Not attached (images need a vision model): ${namedList(needsVision)}.`);
  }
  if (modelChanged.length > 0) {
    notices.push(
      `Not attached (the model changed while images were being prepared; attach them again): ${namedList(modelChanged)}.`,
    );
  }
  return notices.length > 0 ? notices.join(" ") : null;
}

/**
 * Re-applies vision capability to a partition. Capability can change while the partition reads
 * file heads, so the caller applies the capability current at admission: supported rasters
 * attach with a vision model and are refused as `needsVision` without one.
 */
export function withVisionCapability(
  partitioned: PartitionedAttachments,
  visionEnabled: boolean,
): PartitionedAttachments {
  const rasters = [...partitioned.images, ...partitioned.needsVision];
  return {
    ...partitioned,
    images: visionEnabled ? rasters : [],
    needsVision: visionEnabled ? [] : rasters,
  };
}

/**
 * Sorts candidate files for the composer. `File.type` and the name are guesses (a valid PNG
 * can arrive with an empty or generic type), so a supported raster signature in the file's
 * own bytes decides "image" and wins over any name. Everything else falls back to the
 * name-based text rules. Images are only admitted while a vision model is selected.
 */
export async function partitionAttachmentFiles(
  files: readonly File[],
  visionEnabled: boolean,
): Promise<PartitionedAttachments> {
  const heads = await Promise.all(
    files.map((file) => readBlobHead(file).then((head) => head, () => null)),
  );
  const result: PartitionedAttachments = { images: [], texts: [], needsVision: [], unsupported: [] };
  files.forEach((file, index) => {
    const head = heads[index];
    if (head && detectImageFormat(head)) {
      (visionEnabled ? result.images : result.needsVision).push(file);
    } else if (isSupportedTextAttachment(file)) {
      result.texts.push(file);
    } else {
      result.unsupported.push(file);
    }
  });
  return result;
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
  const label = file.name || "The selected image";
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`${label} is larger than 20 MB.`);
  }

  const original = await readBlobAsDataUrl(file);
  // Encoded size does not bound decoded size, so every decision below starts from the
  // dimensions in the file's own header. `File.type` is not consulted: it is a guess that
  // can be empty for a valid PNG or wrong for any file. Anything this module cannot parse
  // (SVG, HEIC, AVIF, corrupt data) is refused rather than handed to a decoder that might
  // expand it without limit.
  const comma = original.indexOf(",");
  const payload = /^data:[^,]*;base64,/i.test(original) ? dataUrlPayloadBytes(original) : null;
  const header = payload ? readImageDimensions(payload) : null;
  if (!payload || !header) {
    throw new Error(`${label} is not a readable PNG, JPEG, GIF, WebP, or BMP image.`);
  }
  if (header.width * header.height > MAX_SOURCE_IMAGE_PIXELS) {
    throw new Error(`${label} is ${header.width}x${header.height}, too large to prepare safely.`);
  }
  // Stored and decoded under the type the bytes carry, never the declared one.
  const mimeType = `image/${header.format}`;
  const labelled = `data:${mimeType};base64,${original.slice(comma + 1)}`;
  if (
    labelled.length <= MAX_ATTACHMENT_DATA_URL_CHARS
    && payload.length <= MAX_OPTIMIZED_IMAGE_BYTES
    && Math.max(header.width, header.height) <= MAX_IMAGE_DIMENSION
  ) {
    return labelled;
  }

  const bitmap = await createImageBitmap(new Blob([file], { type: mimeType }));
  try {
    if (bitmap.width < 1 || bitmap.height < 1) {
      throw new Error(`${label} has invalid dimensions.`);
    }
    let scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const qualities = [0.86, 0.65, 0.48];

    for (let resizeAttempt = 0; resizeAttempt < 5; resizeAttempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image compression is unavailable in this webview.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      let lowestQualityBytes: number | null = null;
      for (const quality of qualities) {
        const compacted = await readBlobAsDataUrl(await canvasBlob(canvas, quality));
        const compactedBytes = imageDataUrlBytes(compacted);
        if (
          compacted.length <= MAX_ATTACHMENT_DATA_URL_CHARS
          && compactedBytes !== null
          && compactedBytes <= MAX_OPTIMIZED_IMAGE_BYTES
        ) return compacted;
        lowestQualityBytes = compactedBytes;
      }

      const ratio = lowestQualityBytes && lowestQualityBytes > 0
        ? Math.sqrt(MAX_OPTIMIZED_IMAGE_BYTES / lowestQualityBytes) * 0.92
        : 0.78;
      const nextScale = scale * Math.min(0.78, Math.max(0.35, ratio));
      const nextWidth = Math.max(1, Math.round(bitmap.width * nextScale));
      const nextHeight = Math.max(1, Math.round(bitmap.height * nextScale));
      if (nextWidth === canvas.width && nextHeight === canvas.height) break;
      scale = nextScale;
    }
  } finally {
    bitmap.close();
  }

  throw new Error(`${label} could not be reduced enough to save safely.`);
}
