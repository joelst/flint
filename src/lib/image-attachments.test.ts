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
  clipboardAttachmentFiles,
  partitionAttachmentFiles,
  rejectedAttachmentNotice,
  withVisionCapability,
  storageCharsExcluding,
} from "./image-attachments";
import { pngBytes, pngDataUrl, TINY_PNG_DATA_URL } from "../../sidecar/test-fixtures/images";

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

  it("rejects a storage value that changes between the two inventory passes", () => {
    let reads = 0;
    const storage = {
      length: 1,
      key: () => "settings",
      getItem: () => (++reads === 1 ? "small" : "x".repeat(10_000)),
    };
    expect(() => storageCharsExcluding(storage, "archive")).toThrow("changed while");
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

  it("gives a failed image's slot to the next file and counts only what found no room", async () => {
    const attached: string[] = [];
    const failures: string[] = [];
    const started: string[] = [];
    const skipped = await prepareImageBatch(
      ["bad", "good", "late1", "late2"],
      () => true,
      async (file) => {
        started.push(file);
        if (file === "bad") throw new Error("corrupt");
        return `data:${file}`;
      },
      (dataUrl) => attached.push(dataUrl),
      (file) => failures.push(file),
      () => {},
      () => {},
      () => attached.length < 1,
    );

    expect(failures).toEqual(["bad"]);
    expect(attached).toEqual(["data:good"]);
    expect(started).toEqual(["bad", "good"]);
    expect(skipped).toBe(2);
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

  it("ignores the declared type and stores what the header proves", async () => {
    installFileReader();
    const decode = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
    const png = pngDataUrl(100, 100);
    const payload = png.slice(png.indexOf(","));
    const cases: Array<[string, string]> = [
      ["", `data:application/octet-stream;base64${payload}`],
      ["application/octet-stream", `data:application/octet-stream;base64${payload}`],
      ["image/heic", `data:image/heic;base64${payload}`],
      ["", `data:;base64${payload}`],
    ];
    for (const [type, dataUrl] of cases) {
      const file = { ...fileWithDataUrl(dataUrl), type } as File;
      await expect(compactImageAttachment(file)).resolves.toBe(png);
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it("decodes a resized source under the header's type, not the declared one", async () => {
    installFileReader();
    const close = vi.fn();
    const decode = vi.fn(async (_blob: Blob) => ({ width: 2000, height: 1000, close }));
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: decode });
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) =>
        callback(Object.assign(new Blob(), { __dataUrl: "data:image/jpeg;base64,AQID" })),
    };
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "canvas" ? canvas : originalCreateElement(tag)) as typeof document.createElement);
    const png = pngDataUrl(2000, 1000);
    const file = { ...fileWithDataUrl(png.replace("image/png", "application/octet-stream")), type: "" } as File;
    await expect(compactImageAttachment(file)).resolves.toBe("data:image/jpeg;base64,AQID");
    expect(decode.mock.calls[0][0].type).toBe("image/png");
  });

  it("partitions files by their leading bytes, not their name or declared type", async () => {
    const png = pngBytes(10, 10);
    const untyped = new File([png], "photo", { type: "" });
    const generic = new File([png], "photo.bin", { type: "application/octet-stream" });
    const misnamed = new File([png], "notes.txt", { type: "text/plain" });
    const code = new File(["const x = 1;"], "a.ts", { type: "" });
    const svg = new File(['<svg width="9" height="9"/>'], "a.svg", { type: "image/svg+xml" });
    const heicNamed = new File([png], "a.heic", { type: "image/heic" });
    const unreadable = {
      name: "notes.md",
      type: "",
      slice: () => { throw new Error("gone"); },
    } as unknown as File;

    const vision = await partitionAttachmentFiles(
      [untyped, generic, misnamed, code, svg, heicNamed, unreadable],
      true,
    );
    expect(vision.images).toEqual([untyped, generic, misnamed, heicNamed]);
    expect(vision.texts).toEqual([code, unreadable]);
    expect(vision.unsupported).toEqual([svg]);

    const text = await partitionAttachmentFiles([untyped, code], false);
    expect(text.images).toEqual([]);
    expect(text.texts).toEqual([code]);
    expect(text.needsVision).toEqual([untyped]);
    expect(text.unsupported).toEqual([]);

    const bm25 = new File(["BM25 is a ranking function used by search engines.\n"], "ranking.md");
    for (const visionEnabled of [true, false]) {
      expect((await partitionAttachmentFiles([bm25], visionEnabled)).texts).toEqual([bm25]);
    }
  });

  it("names refused files, even when others in the batch were attached", async () => {
    const png = new File([pngBytes(4, 4)], "shot.png", { type: "image/png" });
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    const pdf = new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" });

    const partial = await partitionAttachmentFiles([notes, pdf, png], false);
    expect(partial.texts).toEqual([notes]);
    expect(rejectedAttachmentNotice(partial)).toBe(
      "Not attached (not a supported text, code, or image file): report.pdf. "
      + "Not attached (images need a vision model): shot.png.",
    );
    expect(rejectedAttachmentNotice(await partitionAttachmentFiles([notes, png], true))).toBeNull();

    const many = ["a", "b", "c", "d", "e"].map((n) => new File(["x"], `${n}.pdf`));
    expect(rejectedAttachmentNotice({ needsVision: [], unsupported: many }))
      .toBe("Not attached (not a supported text, code, or image file): a.pdf, b.pdf, c.pdf and 2 more.");
  });

  it("applies the vision capability current at admission, not at partition", async () => {
    const png = new File([pngBytes(4, 4)], "shot.png", { type: "image/png" });
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    const pdf = new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" });

    const underVision = await partitionAttachmentFiles([png, notes, pdf], true);
    const switchedAway = withVisionCapability(underVision, false);
    expect(switchedAway.images).toEqual([]);
    expect(switchedAway.needsVision).toEqual([png]);
    expect(switchedAway.texts).toEqual([notes]);
    expect(switchedAway.unsupported).toEqual([pdf]);
    expect(rejectedAttachmentNotice(switchedAway)).toContain("images need a vision model): shot.png.");

    const switchedTo = withVisionCapability(await partitionAttachmentFiles([png, notes], false), true);
    expect(switchedTo.images).toEqual([png]);
    expect(switchedTo.needsVision).toEqual([]);
    expect(rejectedAttachmentNotice(switchedTo)).toBeNull();
    expect(rejectedAttachmentNotice({ needsVision: [], unsupported: [], modelChanged: [png] })).toBe(
      "Not attached (the model changed while images were being prepared; attach them again): shot.png.",
    );
  });
  it("pastes clipboard files but keeps a text paste that carries a picture rendering", () => {
    const image = new File([pngBytes(1, 1)], "image.png", { type: "image/png" });
    const fileItem = { kind: "file", type: "image/png", getAsFile: () => image };
    const emptyFile = { kind: "file", type: "", getAsFile: () => null };
    const plain = { kind: "string", type: "text/plain", getAsFile: () => null };
    const html = { kind: "string", type: "text/html", getAsFile: () => null };

    expect(clipboardAttachmentFiles([fileItem, emptyFile])).toEqual([image]);
    expect(clipboardAttachmentFiles([html, fileItem])).toEqual([image]);
    expect(clipboardAttachmentFiles([plain, html, fileItem])).toEqual([]);
    expect(clipboardAttachmentFiles([plain])).toEqual([]);
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
