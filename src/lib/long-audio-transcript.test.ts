import { describe, expect, it } from 'vitest';
import type { TranscriptionWindow } from './audio-segmentation';
import {
  assembleLongAudioTranscript,
  buildLongAudioCompletionStatus,
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

  it('retains a trailing overlap-only source window without stretching the prior caption', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: 'one two three' },
      { window: window(1, 24, 52, { hardSplitEnd: false }), status: 'success', text: 'one two three' },
    ];
    const assembled = assembleLongAudioTranscript(outcomes);
    expect(assembled.text).toBe('one two three');
    expect(assembled.segments).toHaveLength(1);
    expect(assembled.segments[0].endSec).toBe(28);
    expect(assembled.overlapOnlyRanges).toEqual([{ startSec: 24, endSec: 52 }]);
    expect(assembled.emptyRecognitionRanges).toEqual([]);
    expect(assembled.failedChunks).toBe(0);
  });

  it('retains an interior overlap-only source window and resumes stitching afterward', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: 'one two three' },
      { window: window(1, 24, 52), status: 'success', text: 'one two three' },
      { window: window(2, 48, 76, { hardSplitEnd: false }), status: 'success', text: 'one two three four' },
    ];
    const assembled = assembleLongAudioTranscript(outcomes);
    expect(assembled.text).toBe('one two three four');
    expect(assembled.segments.map((segment) => segment.text)).toEqual(['one two three', 'four']);
    expect(assembled.segments[1].startSec).toBe(48);
    expect(assembled.overlapOnlyRanges).toEqual([{ startSec: 24, endSec: 52 }]);
  });

  it('retains consecutive overlap-only windows as separate source outcomes', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: 'repeat phrase' },
      { window: window(1, 24, 52), status: 'success', text: 'repeat phrase' },
      { window: window(2, 48, 76, { hardSplitEnd: false }), status: 'success', text: 'repeat phrase' },
    ];
    const assembled = assembleLongAudioTranscript(outcomes);
    expect(assembled.text).toBe('repeat phrase');
    expect(assembled.overlapOnlyRanges).toEqual([
      { startSec: 24, endSec: 52 },
      { startSec: 48, endSec: 76 },
    ]);
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

  it('keeps empty recognition distinct from overlap-only recognition', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: '' },
      { window: window(1, 24, 52, { hardSplitEnd: false }), status: 'success', text: 'recognized text' },
    ];
    const assembled = assembleLongAudioTranscript(outcomes);
    expect(assembled.emptyRecognitionRanges).toEqual([{ startSec: 0, endSec: 28 }]);
    expect(assembled.overlapOnlyRanges).toEqual([]);
  });

  it('breaks overlap stitching across an unprocessed intervening window', () => {
    const outcomes: TranscriptionWindowOutcome[] = [
      { window: window(0, 0, 28), status: 'success', text: 'repeat phrase' },
      { window: window(1, 24, 52), status: 'unprocessed' },
      { window: window(2, 48, 76, { hardSplitEnd: false }), status: 'success', text: 'repeat phrase after gap' },
    ];
    expect(assembleLongAudioTranscript(outcomes).text).toBe(
      'repeat phrase repeat phrase after gap',
    );
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

  it('qualifies overlap-only and empty-recognition completion without calling it a failure', () => {
    const status = buildLongAudioCompletionStatus(
      {
        ...assembleLongAudioTranscript([
          { window: window(0, 0, 28), status: 'success', text: 'repeat phrase' },
          { window: window(1, 24, 52), status: 'success', text: 'repeat phrase' },
          { window: window(2, 48, 76, { hardSplitEnd: false }), status: 'success', text: '' },
        ]),
        totalChunks: 3,
      },
      ' via native audio session',
    );
    expect(status).toContain('Transcription complete with qualifications');
    expect(status).toContain('1 overlap-only window added no new text');
    expect(status).toContain('1 successfully processed window recognized no text');
    expect(status).not.toContain('failed');
    expect(status).not.toContain('silent');
  });

  it.each([
    {
      name: 'one clean source window',
      totalChunks: 1,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 20, { hardSplitEnd: false }), status: 'success', text: 'clean' },
      ]),
      expected: 'Transcription complete (1 segment via native audio session)',
    },
    {
      name: 'multiple clean source windows',
      totalChunks: 2,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 28), status: 'success', text: 'first' },
        { window: window(1, 24, 40, { hardSplitEnd: false }), status: 'success', text: 'second' },
      ]),
      expected: 'Transcription complete (2 segments via native audio session)',
    },
    {
      name: 'one overlap-only source window',
      totalChunks: 1,
      result: {
        ...assembleLongAudioTranscript([]),
        overlapOnlyRanges: [{ startSec: 0, endSec: 28 }],
      },
      expected:
        'Transcription complete with qualifications: 1 overlap-only window added no new text after deduplication (1 segment via native audio session)',
    },
    {
      name: 'multiple source windows with overlap-only recognition',
      totalChunks: 2,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 28), status: 'success', text: 'repeat phrase' },
        { window: window(1, 24, 52, { hardSplitEnd: false }), status: 'success', text: 'repeat phrase' },
      ]),
      expected:
        'Transcription complete with qualifications: 1 overlap-only window added no new text after deduplication (2 segments via native audio session)',
    },
    {
      name: 'one empty-recognition source window',
      totalChunks: 1,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 20, { hardSplitEnd: false }), status: 'success', text: '' },
      ]),
      expected:
        'Transcription complete with qualifications: 1 successfully processed window recognized no text (1 segment via native audio session)',
    },
    {
      name: 'multiple source windows with empty recognition',
      totalChunks: 2,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 28), status: 'success', text: 'recognized' },
        { window: window(1, 24, 40, { hardSplitEnd: false }), status: 'success', text: '' },
      ]),
      expected:
        'Transcription complete with qualifications: 1 successfully processed window recognized no text (2 segments via native audio session)',
    },
    {
      name: 'one failed source window',
      totalChunks: 1,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 20, { hardSplitEnd: false }), status: 'failed', uncertain: false },
      ]),
      expected:
        'Transcription incomplete: 1 of 1 segment failed. The text below is missing those parts. via native audio session',
    },
    {
      name: 'one failure among multiple source windows',
      totalChunks: 2,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 28), status: 'success', text: 'recognized' },
        { window: window(1, 24, 40, { hardSplitEnd: false }), status: 'failed', uncertain: false },
      ]),
      expected:
        'Transcription incomplete: 1 of 2 segments failed. The text below is missing those parts. via native audio session',
    },
    {
      name: 'one uncertain failed source window',
      totalChunks: 1,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 20, { hardSplitEnd: false }), status: 'failed', uncertain: true },
      ]),
      expected:
        'Transcription incomplete: 1 of 1 segment did not complete (1 had an uncertain outcome). The text below is missing those parts. via native audio session',
    },
    {
      name: 'one unprocessed source window among multiple windows',
      totalChunks: 2,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 28), status: 'success', text: 'recognized' },
        { window: window(1, 24, 40, { hardSplitEnd: false }), status: 'unprocessed' },
      ]),
      expected:
        'Transcription incomplete: 1 of 2 segments did not complete (1 was not processed). The text below is missing those parts. via native audio session',
    },
    {
      name: 'multiple uncertain and unprocessed source windows together',
      totalChunks: 3,
      result: assembleLongAudioTranscript([
        { window: window(0, 0, 28, { hardSplitEnd: false }), status: 'failed', uncertain: true },
        { window: window(1, 24, 52, { hardSplitEnd: false }), status: 'failed', uncertain: true },
        { window: window(2, 48, 76, { hardSplitEnd: false }), status: 'unprocessed' },
      ]),
      expected:
        'Transcription incomplete: 3 of 3 segments did not complete (2 had uncertain outcomes and 1 was not processed). The text below is missing those parts. via native audio session',
    },
  ])('reports $name with path wording and source-window plurality', ({
    result,
    totalChunks,
    expected,
  }) => {
    const status = buildLongAudioCompletionStatus(
      { ...result, totalChunks },
      ' via native audio session',
    );
    expect(status).toBe(expected);
  });
});
