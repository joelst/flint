import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatSrtTime,
  formatVttTime,
  formatClockTime,
  buildSrt,
  buildSrtTimingMetadata,
  buildCaptionDownloads,
  buildTimingDisclaimer,
  buildVtt,
  buildTimestampedText,
  TIMESTAMP_DISCLAIMER,
  type TranscriptSegment,
  type TranscriptExportState,
} from './transcript-format';

const segments: TranscriptSegment[] = [
  {
    index: 0,
    startSec: 0,
    endSec: 27.5,
    text: 'The quick brown fox.',
    startBoundary: 'recording-edge',
    endBoundary: 'pause-snapped',
  },
  {
    index: 1,
    startSec: 27.5,
    endSec: 61.25,
    text: 'Jumps over the lazy dog.',
    startBoundary: 'pause-snapped',
    endBoundary: 'recording-edge',
  },
];

const cleanState: TranscriptExportState = {
  segments,
  gaps: [],
  emptyRecognitionRanges: [],
  overlapOnlyRanges: [],
};

const exhaustiveState: TranscriptExportState = {
  segments,
  gaps: [
    { startSec: 24, endSec: 52, kind: 'failed', uncertain: false },
    { startSec: 48, endSec: 76, kind: 'failed', uncertain: true },
    { startSec: 72, endSec: 100, kind: 'unprocessed', uncertain: false },
  ],
  emptyRecognitionRanges: [{ startSec: 96, endSec: 124 }],
  overlapOnlyRanges: [{ startSec: 120, endSec: 148 }],
};

describe('time formatting', () => {
  it('formats SRT timestamps with a comma separator', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(61.25)).toBe('00:01:01,250');
    expect(formatSrtTime(3661.5)).toBe('01:01:01,500');
  });

  it('formats VTT timestamps with a dot separator', () => {
    expect(formatVttTime(0)).toBe('00:00:00.000');
    expect(formatVttTime(61.25)).toBe('00:01:01.250');
  });

  it('formats short clock labels', () => {
    expect(formatClockTime(0)).toBe('0:00');
    expect(formatClockTime(61.25)).toBe('1:01');
    expect(formatClockTime(3661)).toBe('1:01:01');
  });

  it('clamps negative and non-finite values to zero', () => {
    expect(formatSrtTime(-5)).toBe('00:00:00,000');
    expect(formatSrtTime(Number.NaN)).toBe('00:00:00,000');
    expect(formatVttTime(Number.POSITIVE_INFINITY)).toBe('00:00:00.000');
  });
});

describe('buildSrt', () => {
  it('emits sequentially numbered cues', () => {
    const srt = buildSrt(segments);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:27,500\nThe quick brown fox.');
    expect(srt).toContain('2\n00:00:27,500 --> 00:01:01,250\nJumps over the lazy dog.');
    expect(srt.endsWith('\n')).toBe(true);
  });

  it('skips blank segments and renumbers the rest', () => {
    const srt = buildSrt([
      { index: 0, startSec: 0, endSec: 5, text: '   ' },
      { index: 1, startSec: 5, endSec: 10, text: 'Real text.' },
    ]);
    expect(srt).toContain('1\n00:00:05,000 --> 00:00:10,000\nReal text.');
    expect(srt).not.toContain('2\n');
  });

  it('returns empty string when there is nothing to export', () => {
    expect(buildSrt([])).toBe('');
    expect(buildSrt([{ index: 0, startSec: 0, endSec: 1, text: '' }])).toBe('');
  });

  it('provides truthful timing-source metadata to accompany SRT exports', () => {
    const note = buildSrtTimingMetadata(cleanState);
    expect(note).toContain('Flint');
    expect(note).toContain('snapped to detected pauses');
    expect(note).toContain('not timings reported by the model');
    expect(note.endsWith('\n')).toBe(true);
  });

  it('guarantees a non-zero cue duration so players accept the file', () => {
    const srt = buildSrt([{ index: 0, startSec: 10, endSec: 10, text: 'Instant.' }]);
    expect(srt).toContain('00:00:10,000 --> 00:00:10,050');
  });

  it('never emits overlapping cues', () => {
    // Hard-split windows can hand us overlapping ranges; captions must not collide.
    const srt = buildSrt([
      { index: 0, startSec: 0, endSec: 28, text: 'First window.' },
      { index: 1, startSec: 24, endSec: 52, text: 'Second window.' },
    ]);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:28,000\nFirst window.');
    expect(srt).toContain('2\n00:00:28,000 --> 00:00:52,000\nSecond window.');
  });

  it('keeps displayed ranges non-overlapping when overlap text differs only by punctuation', () => {
    const srt = buildSrt([
      { index: 0, startSec: 0, endSec: 28, text: 'Wait, what?' },
      { index: 1, startSec: 24, endSec: 52, text: 'Wait what happens next.' },
    ]);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:28,000\nWait, what?');
    expect(srt).toContain('2\n00:00:28,000 --> 00:00:52,000\nWait what happens next.');
  });

  it('orders cues chronologically even if given out of order', () => {
    const srt = buildSrt([
      { index: 0, startSec: 30, endSec: 40, text: 'Later.' },
      { index: 1, startSec: 0, endSec: 10, text: 'Earlier.' },
    ]);
    expect(srt.indexOf('Earlier.')).toBeLessThan(srt.indexOf('Later.'));
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:10,000\nEarlier.');
  });
});

describe('buildVtt', () => {
  it('starts with the WEBVTT header and states the timings are derived', () => {
    const vtt = buildVtt(cleanState);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain(TIMESTAMP_DISCLAIMER);
  });

  it('emits cues without sequence numbers', () => {
    const vtt = buildVtt(cleanState);
    expect(vtt).toContain('00:00:00.000 --> 00:00:27.500\nThe quick brown fox.');
  });

  it('still emits a valid header when there are no segments', () => {
    expect(buildVtt({ ...cleanState, segments: [] }).startsWith('WEBVTT')).toBe(true);
  });
});

describe('buildTimestampedText', () => {
  it('renders a readable bracketed listing', () => {
    expect(buildTimestampedText(cleanState)).toBe(
      `${buildTimingDisclaimer(segments)}\n\n` +
        '[0:00 - 0:27] The quick brown fox.\n[0:27 - 1:01] Jumps over the lazy dog.',
    );
  });

  it('returns empty string for no usable segments', () => {
    expect(
      buildTimestampedText({
        segments: [],
        gaps: [],
        emptyRecognitionRanges: [],
        overlapOnlyRanges: [],
      }),
    ).toBe('');
  });

  describe('timing provenance and caption delivery', () => {
    it('describes mixed snapped and fixed boundaries truthfully', () => {
      const note = buildTimingDisclaimer([
        segments[0],
        {
          ...segments[1],
          startBoundary: 'pause-snapped',
          endBoundary: 'fixed-window',
        },
      ]);
      expect(note).toContain('Some boundaries were snapped');
      expect(note).toContain('unsnapped boundaries remain approximate fixed-window cuts');
    });

    it('builds an SRT and timing note with one stable filename stem', () => {
      const files = buildCaptionDownloads('srt', cleanState, new Date('2026-09-26T05:00:00.000Z'));
      expect(files).toHaveLength(2);
      expect(files.map((file) => file.fileName)).toEqual([
        'flint-transcription-2026-09-26T05-00-00-000Z.srt',
        'flint-transcription-2026-09-26T05-00-00-000Z.timing.txt',
      ]);
      expect(files[0].body).not.toContain(TIMESTAMP_DISCLAIMER);
      expect(files[1].body).toContain(TIMESTAMP_DISCLAIMER);
    });

    it.each([
      ['timestamped text', (state: TranscriptExportState) => buildTimestampedText(state)],
      ['WebVTT NOTE', (state: TranscriptExportState) => buildVtt(state)],
      ['SRT timing note', (state: TranscriptExportState) => buildSrtTimingMetadata(state)],
    ])('preserves every source-window outcome in %s without clamping overlaps', (_name, build) => {
      const output = build(exhaustiveState);
      expect(output).toContain('[0:24 - 0:52] Transcription failed.');
      expect(output).toContain('[0:48 - 1:16] Transcription failed; runtime outcome uncertain.');
      expect(output).toContain('[1:12 - 1:40] Not processed.');
      expect(output).toContain('[1:36 - 2:04] Successfully processed; no text was recognized');
      expect(output).toContain('[2:00 - 2:28] Successfully processed; overlap-only/no-new-text');
      expect(output).toContain('Transcript incomplete');
    });

    it('does not add incomplete warnings to clean exports', () => {
      expect(buildTimestampedText(cleanState)).not.toContain('incomplete');
      expect(buildVtt(cleanState)).not.toContain('incomplete');
      expect(buildSrtTimingMetadata(cleanState)).not.toContain('incomplete');
    });

    it('emits an explanatory SRT metadata artifact when every window failed', () => {
      const allFailed: TranscriptExportState = {
        segments: [],
        gaps: [{ startSec: 0, endSec: 28, kind: 'failed', uncertain: false }],
        emptyRecognitionRanges: [],
        overlapOnlyRanges: [],
      };
      const files = buildCaptionDownloads(
        'srt',
        allFailed,
        new Date('2026-09-26T05:00:00.000Z'),
      );
      expect(files).toEqual([
        {
          fileName: 'flint-transcription-2026-09-26T05-00-00-000Z.timing.txt',
          body: expect.stringContaining('[0:00 - 0:28] Transcription failed.'),
        },
      ]);
      expect(buildTimestampedText(allFailed)).toContain(
        '[0:00 - 0:28] Transcription failed.',
      );
      const vttFiles = buildCaptionDownloads(
        'vtt',
        allFailed,
        new Date('2026-09-26T05:00:00.000Z'),
      );
      expect(vttFiles).toHaveLength(1);
      expect(vttFiles[0].body).toContain('WEBVTT');
      expect(vttFiles[0].body).toContain('[0:00 - 0:28] Transcription failed.');
    });

    it('keeps the page call sites wired to the complete assembled transcript state', () => {
      const source = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
      expect(source).toContain('function currentTranscriptExportState()');
      expect(source).toContain('buildTimestampedText(currentTranscriptExportState())');
      expect(source).toContain(
        'buildCaptionDownloads(format, currentTranscriptExportState())',
      );
      expect(source).toContain('overlapOnlyRanges = Array.isArray(result?.overlapOnlyRanges)');
      expect(source).toContain('buildLongAudioCompletionStatus(result, path)');
      expect(source).toContain(
        'they are not failures, empty recognition, or detected silence.',
      );
      expect(source).toContain('"Download timing note"');
    });
  });
});
