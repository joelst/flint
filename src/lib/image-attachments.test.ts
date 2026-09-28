import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTACHMENT_DATA_URL_CHARS,
  MAX_CONVERSATION_STORAGE_CHARS,
  MAX_SOURCE_IMAGE_BYTES,
  compactImageAttachment,
  prepareImageBatch,
  preparedImageStillOwned,
  imageAttachmentFitsArchive,
  imageDataUrlBytes,
  storageCharsExcluding,
} from "./image-attachments";
import { pngDataUrl, TINY_PNG_DATA_URL } from "../../sidecar/test-fixtures/images";

// A real 3200x1600 header padded past the fast-path size limit.
const LARGE_PNG = pngDataUrl(3200, 1600, MAX_ATTACHMENT_DATA_URL_CHARS);

const originalFileReader = globalThis.FileReader;
const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalCreateElement = document.createElement.bind(document);

function fileWithDataUrl(dataUrl: string, size = 10): File {
  return {
    name: "picture.png",
    type: "image/png",
    size,
    __dataUrl: dataUrl,
  } as unknown as File;
}

function installFileReader() {
  class MockFileReader {
    result: string | null = null;
    error: Error | null = null;
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    readAsDataURL(blob: Blob & { __dataUrl?: string }) {
      this.result = blob.__dataUrl ?? "";
      this.onload?.();
    }
  }
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: MockFileReader });
}

afterEach(() => {
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: originalFileReader });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: originalCreateImageBitmap,
  });
  vi.restoreAllMocks();
});

describe("image attachment storage limits", () => {
  it("counts decoded image bytes without treating the base64 expansion as free", () => {
    expect(imageDataUrlBytes("data:image/png;base64,AQID")).toBe(3);
    expect(imageDataUrlBytes("https://example.test/image.png")).toBeNull();
  });

  it("reserves storage headroom for settings and localStorage bookkeeping", () => {
    expect(imageAttachmentFitsArchive(MAX_CONVERSATION_STORAGE_CHARS - 1, 0)).toBe(true);
    expect(imageAttachmentFitsArchive(MAX_CONVERSATION_STORAGE_CHARS, 1)).toBe(false);
  });

  it("rejects an unstable same-length storage inventory", () => {
    const snapshots = [
      ["first", "second"],
      ["first", "large-new-key"],
    ];
    let listing = 0;
    let index = 0;
    const storage = {
      get length() { return 2; },
      key(current: number) {
        const key = snapshots[listing][current] ?? null;
        index += 1;
        if (index === 2) {
          listing = 1;
          index = 0;
        }
        return key;
      },
      getItem(key: string) {
        return key === "large-new-key" ? "x".repeat(10_000) : "x";
      },
    };
    expect(() => storageCharsExcluding(storage, "excluded")).toThrow("changed while");
  });

  it("does not commit a prepared image after switching away from a vision model", () => {
    expect(preparedImageStillOwned("c1", "c1", 1, 1, true)).toBe(true);
    expect(preparedImageStillOwned("c1", "c1", 1, 1, false)).toBe(false);
  });

  it("stops a multi-image batch when a failed preparation loses ownership", async () => {
    let rejectFirst!: (error: Error) => void;
    let ownerIsCurrent = true;
    let processingCount = 0;
    const started: string[] = [];
    const failures: string[] = [];
    const firstPreparation = new Promise<string>((_, reject) => {
      rejectFirst = reject;
    });

    const batch = prepareImageBatch(
      ["first", "second"],
      () => ownerIsCurrent,
      async (file) => {
        started.push(file);
        return file === "first" ? firstPreparation : `data:${file}`;
      },
      () => {},
      (file) => failures.push(file),
      () => { processingCount += 1; },
      () => {
        processingCount = ownerIsCurrent ? Math.max(0, processingCount - 1) : processingCount;
      },
    );

    await Promise.resolve();
    expect(processingCount).toBe(1);
    ownerIsCurrent = false;
    processingCount = 0;
    rejectFirst(new Error("stale image read failed"));
    await batch;

    expect(processingCount).toBe(0);
    expect(started).toEqual(["first"]);
    expect(failures).toEqual([]);
  });

  it("returns an already-small safe image without decoding it", async () => {
    installFileReader();
    const decode = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
    await expect(compactImageAttachment(fileWithDataUrl(TINY_PNG_DATA_URL)))
      .resolves.toBe(TINY_PNG_DATA_URL);
    expect(decode).not.toHaveBeenCalled();
  });

  it("resizes a small-but-high-resolution image instead of returning it", async () => {
    installFileReader();
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 2000, height: 1000, close }));
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
    const compacted = "data:image/jpeg;base64,AQID";
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) =>
        callback(Object.assign(new Blob(), { __dataUrl: compacted })),
    };
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "canvas" ? canvas : originalCreateElement(tag)) as typeof document.createElement);

    const small = pngDataUrl(2000, 1000);
    expect(small.length).toBeLessThan(MAX_ATTACHMENT_DATA_URL_CHARS);
    await expect(compactImageAttachment(fileWithDataUrl(small))).resolves.toBe(compacted);
    expect(decode).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(1600);
  });

  it("refuses a pixel bomb and an unreadable header without decoding", async () => {
    installFileReader();
    const decode = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
    const bomb = pngDataUrl(10_000, 10_000);
    expect(bomb.length).toBeLessThan(MAX_ATTACHMENT_DATA_URL_CHARS);
    await expect(compactImageAttachment(fileWithDataUrl(bomb)))
      .rejects.toThrow("10000x10000, too large to prepare safely");
    await expect(compactImageAttachment(fileWithDataUrl("data:image/png;base64,AQID")))
      .rejects.toThrow("not a readable PNG");
    await expect(compactImageAttachment(fileWithDataUrl("data:image/png;base64,***")))
      .rejects.toThrow("not a readable PNG");
    const svg = { ...fileWithDataUrl(`data:image/svg+xml;base64,${btoa('<svg width="99999" height="99999"/>')}`), type: "image/svg+xml" } as File;
    await expect(compactImageAttachment(svg)).rejects.toThrow("not a readable PNG");
    expect(decode).not.toHaveBeenCalled();
  });

  it("uses the header, not the declared type, to bound and re-encode a mislabelled image", async () => {
    installFileReader();
    const close = vi.fn();
    const decode = vi.fn(async () => ({ width: 100, height: 100, close }));
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
    const compacted = "data:image/jpeg;base64,AQID";
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) =>
        callback(Object.assign(new Blob(), { __dataUrl: compacted })),
    };
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "canvas" ? canvas : originalCreateElement(tag)) as typeof document.createElement);
    const heicLabelled = { ...fileWithDataUrl(pngDataUrl(100, 100).replace("image/png", "image/heic")), type: "image/heic" } as File;
    await expect(compactImageAttachment(heicLabelled)).resolves.toBe(compacted);
    expect(decode).toHaveBeenCalledOnce();
  });

  it("rejects oversized source files before reading them", async () => {
    await expect(compactImageAttachment(
      fileWithDataUrl(TINY_PNG_DATA_URL, MAX_SOURCE_IMAGE_BYTES + 1),
    )).rejects.toThrow("larger than 20 MB");
  });

  it("re-encodes a large image and closes its bitmap", async () => {
    installFileReader();
    const close = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({ width: 3200, height: 1600, close })),
    });
    const compacted = "data:image/jpeg;base64,AQID";
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) =>
        callback(Object.assign(new Blob(), { __dataUrl: compacted })),
    };
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "canvas" ? canvas : originalCreateElement(tag)) as typeof document.createElement);

    await expect(compactImageAttachment(
      fileWithDataUrl(LARGE_PNG),
    )).resolves.toBe(compacted);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(800);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects invalid decoded dimensions and unavailable canvas drawing", async () => {
    installFileReader();
    const close = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({ width: 0, height: 10, close })),
    });
    const large = fileWithDataUrl(LARGE_PNG);
    await expect(compactImageAttachment(large)).rejects.toThrow("invalid dimensions");
    expect(close).toHaveBeenCalledOnce();

    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({ width: 100, height: 100, close })),
    });
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "canvas"
        ? { width: 0, height: 0, getContext: () => null }
        : originalCreateElement(tag)) as typeof document.createElement);
    await expect(compactImageAttachment(large)).rejects.toThrow("compression is unavailable");
  });

  it("fails when repeated compression cannot reach the storage cap", async () => {
    installFileReader();
    const close = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({ width: 2000, height: 1000, close })),
    });
    const stillLarge = `data:image/jpeg;base64,${"A".repeat(MAX_ATTACHMENT_DATA_URL_CHARS)}`;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) =>
        callback(Object.assign(new Blob(), { __dataUrl: stillLarge })),
    };
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "canvas" ? canvas : originalCreateElement(tag)) as typeof document.createElement);

    await expect(compactImageAttachment(
      fileWithDataUrl(LARGE_PNG),
    )).rejects.toThrow("could not be reduced enough");
    expect(close).toHaveBeenCalledOnce();
  });
});
