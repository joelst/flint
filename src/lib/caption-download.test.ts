import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadCaptionArtifact } from './caption-download';
import { buildCaptionArtifact } from './transcript-format';
import type { TranscriptExportState } from './transcript-format';

const NOW = new Date('2026-09-27T01:02:03.000Z');

function state(overrides: Partial<TranscriptExportState> = {}): TranscriptExportState {
  return {
    segments: [{ index: 0, startSec: 0, endSec: 2, text: 'hello there' }],
    gaps: [],
    emptyRecognitionRanges: [],
    overlapOnlyRanges: [],
    ...overrides,
  } as TranscriptExportState;
}

function captureDownload(run: () => void) {
  const createObjectURL = vi.fn(() => 'blob:caption');
  const revokeObjectURL = vi.fn();
  const blobs: Blob[] = [];
  const RealBlob = globalThis.Blob;
  class RecordingBlob extends RealBlob {
    constructor(parts: any, options: any) {
      super(parts, options);
      blobs.push(this as unknown as Blob);
    }
  }
  vi.stubGlobal('Blob', RecordingBlob);
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const downloads: string[] = [];
  const setAttribute = vi
    .spyOn(HTMLAnchorElement.prototype, 'download', 'set')
    .mockImplementation(function (value: string) {
      downloads.push(value);
    });

  run();

  return { click, createObjectURL, revokeObjectURL, blobs, downloads, setAttribute };
}

describe('downloadCaptionArtifact', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests exactly one download for an SRT export that carries a timing note', () => {
    const artifact = buildCaptionArtifact('srt', state(), NOW)!;
    expect(artifact.contents).toHaveLength(2);

    const { click, createObjectURL } = captureDownload(() => downloadCaptionArtifact(artifact));

    // The whole point: a second click can be refused without the page ever learning.
    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'srt bundle', format: 'srt' as const, transcriptState: state(), type: 'application/zip' },
    {
      name: 'vtt captions',
      format: 'vtt' as const,
      transcriptState: state(),
      type: 'text/plain;charset=utf-8',
    },
  ])('sends the $name as a single blob of the declared type', ({ format, transcriptState, type }) => {
    const artifact = buildCaptionArtifact(format, transcriptState, NOW)!;
    const { blobs, downloads } = captureDownload(() => downloadCaptionArtifact(artifact));

    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe(type);
    expect(downloads).toEqual([artifact.fileName]);
  });

  it('revokes the URL only after the download delay', () => {
    vi.useFakeTimers();
    const artifact = buildCaptionArtifact('srt', state(), NOW)!;
    const { revokeObjectURL } = captureDownload(() => downloadCaptionArtifact(artifact));

    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:caption');
  });
});

describe('buildCaptionArtifact', () => {
  /** Reads entry names and bodies straight out of the archive's central directory. */
  function readEntries(zip: Uint8Array): Record<string, string> {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let end = zip.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    const count = view.getUint16(end + 10, true);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const out: Record<string, string> = {};
    let cursor = view.getUint32(end + 16, true);
    for (let index = 0; index < count; index++) {
      const size = view.getUint32(cursor + 20, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const offset = view.getUint32(cursor + 42, true);
      const name = decoder.decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
      const dataStart =
        offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
      out[name] = decoder.decode(zip.subarray(dataStart, dataStart + size));
      cursor +=
        46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    }
    return out;
  }

  it('keeps the captions and the derived-timing qualification in one archive', () => {
    const artifact = buildCaptionArtifact('srt', state(), NOW)!;
    expect(artifact.fileName).toMatch(/\.zip$/);

    const entries = readEntries(artifact.body);
    const names = Object.keys(entries).sort();
    expect(names).toHaveLength(2);
    expect(names.some((name) => name.endsWith('.srt'))).toBe(true);

    const note = entries[names.find((name) => name.endsWith('.timing.txt'))!];
    // Captions must never circulate without the statement that Flint derived the times.
    expect(note).toContain('not timings reported by the model');
    expect(entries[names.find((name) => name.endsWith('.srt'))!]).toContain('hello there');
  });

  it('sends a lone file directly rather than wrapping one file in an archive', () => {
    const artifact = buildCaptionArtifact('vtt', state(), NOW)!;
    expect(artifact.fileName).toMatch(/\.vtt$/);
    expect(artifact.contents).toHaveLength(1);
    expect(new TextDecoder().decode(artifact.body)).toContain('WEBVTT');
  });

  it('still exports the qualification when there are no captions at all', () => {
    const artifact = buildCaptionArtifact('srt', state({ segments: [], gaps: [] }), NOW);
    // An SRT with no cues and nothing to report has nothing to say.
    expect(artifact).toBeNull();

    const withDiagnostic = buildCaptionArtifact(
      'srt',
      state({ segments: [], gaps: [{ startSec: 0, endSec: 4, kind: 'failed' }] as any }),
      NOW,
    )!;
    // Only the note survives, so it ships on its own rather than in an archive.
    expect(withDiagnostic.contents).toEqual([expect.stringMatching(/\.timing\.txt$/)]);
    expect(new TextDecoder().decode(withDiagnostic.body)).toContain(
      'not timings reported by the model',
    );
  });
});
