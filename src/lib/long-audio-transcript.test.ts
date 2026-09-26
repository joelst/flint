import { describe, expect, it } from 'vitest';
import type { TranscriptionWindow } from './audio-segmentation';
import {
  assembleLongAudioTranscript,
  type TranscriptionWindowOutcome,
} from './long-audio-transcript';

function window(
  index: number,
  startSec: number,
  endSec: number,
  options: Partial<TranscriptionWindow> = {},
): TranscriptionWindow {
  return {
    index,
    startSec,
    endSec,
    hardSplitEnd: index < 2,
    snappedEnd: false,
    overlapsPrevious: index > 0,
    ...options,
  };
}

describe('assembleLongAudioTranscript', () => {
  it('keeps identical phrases separated by a silence boundary', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 27, { hardSplitEnd: false, snappedEnd: true }), status: 'success', text: 'Thank you.' },
      { window: window(1, 27, 50, { overlapsPrevious: false, hardSplitEnd: false }), status: 'success', text: 'Thank you.' },
    ];
    expect(assembleLongAudioTranscript(outcomes).text).toBe('Thank you. Thank you.');
  });

  it('does not discard a repeated substring that is not a boundary overlap', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: 'alpha beta gamma' },
      { window: window(1, 28, 56, { overlapsPrevious: false }), status: 'success', text: 'beta' },
      { window: window(2, 56, 70, { overlapsPrevious: false, hardSplitEnd: false }), status: 'success', text: 'gamma delta' },
    ];
    expect(assembleLongAudioTranscript(outcomes).text).toBe('alpha beta gamma beta gamma delta');
  });

  it('deduplicates once across adjacent successful overlapping source windows', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: 'one two three four' },
      { window: window(1, 24, 52), status: 'success', text: 'three four five six' },
      { window: window(2, 48, 70, { hardSplitEnd: false }), status: 'success', text: 'five six seven' },
    ];
    expect(assembleLongAudioTranscript(outcomes).text).toBe('one two three four five six seven');
  });

  it('breaks overlap stitching across a failed intervening window', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: 'repeat phrase' },
      { window: window(1, 24, 52), status: 'failed', uncertain: false },
      { window: window(2, 48, 76, { hardSplitEnd: false }), status: 'success', text: 'repeat phrase after gap' },
    ];
    const assembled = assembleLongAudioTranscript(outcomes);
    expect(assembled.text).toBe('repeat phrase repeat phrase after gap');
    expect(assembled.gaps).toEqual([
      { startSec: 24, endSec: 52, kind: 'failed', uncertain: false },
    ]);
  });

  it('retains unprocessed and uncertain failed ranges without calling empty recognition silence', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: '' },
      { window: window(1, 24, 52), status: 'failed', uncertain: true },
      { window: window(2, 48, 76, { hardSplitEnd: false }), status: 'unprocessed' },
    ];
    const assembled = assembleLongAudioTranscript(outcomes);
    expect(assembled.emptyRecognitionRanges).toEqual([{ startSec: 0, endSec: 28 }]);
    expect(assembled.gaps.map((gap) => gap.kind)).toEqual(['failed', 'unprocessed']);
    expect(assembled.failedChunks).toBe(2);
    expect(assembled.uncertainChunks).toBe(1);
    expect(assembled.unprocessedChunks).toBe(1);
  });

  it('keeps displayed ranges non-overlapping even when punctuation prevents text dedupe', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: 'Wait, what?' },
      { window: window(1, 24, 52, { hardSplitEnd: false }), status: 'success', text: 'Wait what happens next.' },
    ];
    const assembled = assembleLongAudioTranscript(outcomes);
    expect(assembled.segments[1].startSec).toBe(assembled.segments[0].endSec);
    expect(assembled.text).toBe('Wait, what? Wait what happens next.');
  });
});
