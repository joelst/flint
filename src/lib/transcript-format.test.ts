import { describe, it, expect } from 'vitest';
import {
  formatSrtTime,
  formatVttTime,
  formatClockTime,
  buildSrt,
  buildSrtTimingMetadata,
  buildVtt,
  buildTimestampedText,
  TIMESTAMP_DISCLAIMER,
  type TranscriptSegment,
} from './transcript-format';

const segments: TranscriptSegment[] = [
  { index: 0, startSec: 0, endSec: 27.5, text: 'The quick brown fox.' },
  { index: 1, startSec: 27.5, endSec: 61.25, text: 'Jumps over the lazy dog.' },
];

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
    const note = buildSrtTimingMetadata();
    expect(note).toContain('Flint');
    expect(note).toContain('silence detection is used when available');
    expect(note).toContain('fixed-length windows as a fallback');
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
    const vtt = buildVtt(segments);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain(TIMESTAMP_DISCLAIMER);
  });

  it('emits cues without sequence numbers', () => {
    const vtt = buildVtt(segments);
    expect(vtt).toContain('00:00:00.000 --> 00:00:27.500\nThe quick brown fox.');
  });

  it('still emits a valid header when there are no segments', () => {
    expect(buildVtt([]).startsWith('WEBVTT')).toBe(true);
  });
});

describe('buildTimestampedText', () => {
  it('renders a readable bracketed listing', () => {
    expect(buildTimestampedText(segments)).toBe(
      '[0:00 - 0:27] The quick brown fox.\n[0:27 - 1:01] Jumps over the lazy dog.',
    );
  });

  it('returns empty string for no usable segments', () => {
    expect(buildTimestampedText([])).toBe('');
  });
});
