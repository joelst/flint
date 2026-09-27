import type { TranscriptionWindow } from './audio-segmentation';
import type {
  TranscriptBoundary,
  TranscriptExportState,
  TranscriptGap,
  TranscriptRange,
  TranscriptSegment,
} from './transcript-format';

export type { TranscriptGap, TranscriptRange } from './transcript-format';

export type TranscriptionWindowOutcome =
  | { window: TranscriptionWindow; status: 'success'; text: string }
  | { window: TranscriptionWindow; status: 'failed'; uncertain: boolean }
  | { window: TranscriptionWindow; status: 'unprocessed' };

export interface AssembledLongAudioTranscript extends TranscriptExportState {
  text: string;
  failedChunks: number;
  uncertainChunks: number;
  unprocessedChunks: number;
}

export interface TranscriptionWindowSampleRange {
  startSample: number;
  endSample: number;
  length: number;
}

export function transcriptionWindowSampleRange(
  window: TranscriptionWindow,
  sampleRate: number,
  totalSamples: number,
  minimumSamples = 1000,
): TranscriptionWindowSampleRange | null {
  const startSample = Math.max(0, Math.floor(window.startSec * sampleRate));
  const endSample = Math.min(totalSamples, Math.ceil(window.endSec * sampleRate));
  const length = endSample - startSample;
  return length >= minimumSamples ? { startSample, endSample, length } : null;
}

export interface TranscriptionProgress {
  current: number;
  total: number;
}

export function formatTranscriptionProgress(progress: TranscriptionProgress): string {
  if (progress.total === 0) return 'No transcription segments were planned.';
  if (progress.current === 0) {
    return `Transcribing ${progress.total} planned ${progress.total === 1 ? 'segment' : 'segments'}...`;
  }
  return `Processed ${progress.current}/${progress.total} segments...`;
}

type ProcessWindow = (
  window: TranscriptionWindow,
  index: number,
) => Promise<
  | { status: 'success'; text: string }
  | { status: 'failed'; uncertain: boolean }
  | { status: 'unprocessed' }
  | { status: 'interrupted' }
>;

export async function processTranscriptionWindows(
  windows: readonly TranscriptionWindow[],
  processWindow: ProcessWindow,
  options: {
    onProgress?: (progress: TranscriptionProgress) => void;
    shouldInterrupt?: () => boolean;
  } = {},
): Promise<{ outcomes: TranscriptionWindowOutcome[]; interrupted: boolean }> {
  const outcomes: TranscriptionWindowOutcome[] = [];
  const total = windows.length;
  options.onProgress?.({ current: 0, total });

  for (let index = 0; index < total; index++) {
    if (options.shouldInterrupt?.()) {
      for (const window of windows.slice(index)) {
        outcomes.push({ window, status: 'unprocessed' });
      }
      return { outcomes, interrupted: true };
    }

    const window = windows[index];
    const outcome = await processWindow(window, index);
    if (outcome.status === 'interrupted') {
      for (const remainingWindow of windows.slice(index)) {
        outcomes.push({ window: remainingWindow, status: 'unprocessed' });
      }
      return { outcomes, interrupted: true };
    }
    if (outcome.status === 'success') {
      outcomes.push({ window, status: 'success', text: outcome.text });
    } else if (outcome.status === 'failed') {
      outcomes.push({ window, status: 'failed', uncertain: outcome.uncertain });
    } else {
      outcomes.push({ window, status: 'unprocessed' });
    }
    options.onProgress?.({ current: index + 1, total });
  }

  return { outcomes, interrupted: false };
}

export function normalizeTranscriptText(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function comparableWord(word: string): string {
  // Overlap matching must not depend on the host locale.
  return word.toLowerCase();
}

export function findWordOverlapTailPrefix(
  previousText: string,
  nextText: string,
  maxWords = 24,
): number {
  const previous = normalizeTranscriptText(previousText).split(' ').filter(Boolean);
  const next = normalizeTranscriptText(nextText).split(' ').filter(Boolean);
  const max = Math.min(maxWords, previous.length, next.length);
  for (let overlap = max; overlap > 0; overlap--) {
    const previousTail = previous.slice(-overlap).map(comparableWord);
    const nextHead = next.slice(0, overlap).map(comparableWord);
    if (previousTail.every((word, index) => word === nextHead[index])) return overlap;
  }
  return 0;
}

function startBoundaryFor(
  outcomeIndex: number,
  outcomes: readonly TranscriptionWindowOutcome[],
): TranscriptBoundary {
  if (outcomeIndex === 0) return 'recording-edge';
  const previous = outcomes[outcomeIndex - 1]?.window;
  return previous?.snappedEnd ? 'pause-snapped' : 'fixed-window';
}

function endBoundaryFor(
  outcomeIndex: number,
  outcomes: readonly TranscriptionWindowOutcome[],
): TranscriptBoundary {
  const window = outcomes[outcomeIndex].window;
  if (outcomeIndex === outcomes.length - 1 && !window.hardSplitEnd && !window.snappedEnd) {
    return 'recording-edge';
  }
  return window.snappedEnd ? 'pause-snapped' : 'fixed-window';
}

export function assembleLongAudioTranscript(
  outcomes: readonly TranscriptionWindowOutcome[],
): AssembledLongAudioTranscript {
  const segments: TranscriptSegment[] = [];
  const gaps: TranscriptGap[] = [];
  const emptyRecognitionRanges: TranscriptRange[] = [];
  const overlapOnlyRanges: TranscriptRange[] = [];
  let failedChunks = 0;
  let uncertainChunks = 0;
  let unprocessedChunks = 0;

  outcomes.forEach((outcome, outcomeIndex) => {
    const { window } = outcome;
    if (outcome.status === 'failed') {
      failedChunks++;
      if (outcome.uncertain) uncertainChunks++;
      gaps.push({
        startSec: window.startSec,
        endSec: window.endSec,
        kind: 'failed',
        uncertain: outcome.uncertain,
      });
      return;
    }
    if (outcome.status === 'unprocessed') {
      failedChunks++;
      unprocessedChunks++;
      gaps.push({
        startSec: window.startSec,
        endSec: window.endSec,
        kind: 'unprocessed',
        uncertain: false,
      });
      return;
    }

    const recognizedText = normalizeTranscriptText(outcome.text);
    if (!recognizedText) {
      emptyRecognitionRanges.push({ startSec: window.startSec, endSec: window.endSec });
      return;
    }

    let acceptedText = recognizedText;
    const previousOutcome = outcomes[outcomeIndex - 1];
    const previousSegment = segments.at(-1);
    const genuinelyAdjacentOverlap =
      window.overlapsPrevious &&
      previousOutcome?.status === 'success' &&
      previousSegment != null;
    if (genuinelyAdjacentOverlap) {
      const overlapWords = findWordOverlapTailPrefix(previousOutcome.text, recognizedText);
      if (overlapWords > 0) {
        acceptedText = recognizedText.split(' ').slice(overlapWords).join(' ').trim();
      }
    }
    if (!acceptedText) {
      overlapOnlyRanges.push({ startSec: window.startSec, endSec: window.endSec });
      return;
    }

    const startSec = genuinelyAdjacentOverlap
      ? Math.max(window.startSec, previousSegment.endSec)
      : window.startSec;
    segments.push({
      index: segments.length,
      startSec,
      endSec: Math.max(window.endSec, startSec + 0.05),
      text: acceptedText,
      startBoundary: startBoundaryFor(outcomeIndex, outcomes),
      endBoundary: endBoundaryFor(outcomeIndex, outcomes),
    });
  });

  return {
    text: normalizeTranscriptText(segments.map((segment) => segment.text).join(' ')),
    segments,
    gaps,
    emptyRecognitionRanges,
    overlapOnlyRanges,
    failedChunks,
    uncertainChunks,
    unprocessedChunks,
  };
}

/** Joins clauses as `a`, `a and b`, or `a, b, and c`. */
function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 2) return clauses.join(' and ');
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}

export function buildLongAudioCompletionStatus(
  result: AssembledLongAudioTranscript & { totalChunks: number; interruptionReason?: string },
  path = '',
): string {
  const failed = Number(result.failedChunks || 0);
  const uncertain = Number(result.uncertainChunks || 0);
  const unprocessed = Number(result.unprocessedChunks || 0);
  const totalChunks = Number(result.totalChunks || 0);
  const segmentLabel = totalChunks === 1 ? 'segment' : 'segments';
  if (failed > 0) {
    // `failed` is the total; uncertain and unprocessed are subsets of it, so the
    // remainder is the number of windows that definitely failed. A negative value
    // would mean a window was counted twice, which is a bug worth surfacing rather
    // than clamping away.
    const definite = failed - uncertain - unprocessed;
    const clauses: string[] = [];
    if (uncertain > 0 || unprocessed > 0) {
      if (definite !== 0) clauses.push(`${definite} failed`);
      if (uncertain > 0) {
        clauses.push(
          `${uncertain} had ${uncertain === 1 ? 'an uncertain outcome' : 'uncertain outcomes'}`,
        );
      }
      if (unprocessed > 0) {
        clauses.push(`${unprocessed} ${unprocessed === 1 ? 'was' : 'were'} not processed`);
      }
    }
    const detail =
      clauses.length > 0
        ? `no confirmed successful result for ${failed} of ${totalChunks} ${segmentLabel} (${joinClauses(clauses)})`
        : `${failed} of ${totalChunks} ${segmentLabel} failed`;
    // An uncertain window may still have produced text, and overlapping neighbours may
    // already cover a failed range, so Flint cannot assert that anything is missing.
    const interruption = result.interruptionReason
      ? ` Processing stopped because ${result.interruptionReason}.`
      : '';
    return `Transcription incomplete: ${detail}. Text may be missing from those ranges.${interruption}${path}`;
  }

  const qualifications: string[] = [];
  const overlapOnly = result.overlapOnlyRanges.length;
  const emptyRecognition = result.emptyRecognitionRanges.length;
  if (overlapOnly > 0) {
    qualifications.push(
      `${overlapOnly} overlap-only ${overlapOnly === 1 ? 'window added' : 'windows added'} no new text after deduplication`,
    );
  }
  if (emptyRecognition > 0) {
    qualifications.push(
      `${emptyRecognition} successfully processed ${emptyRecognition === 1 ? 'window recognized' : 'windows recognized'} no text`,
    );
  }
  if (qualifications.length > 0) {
    return `Transcription complete with qualifications: ${qualifications.join('; ')} (${totalChunks} ${segmentLabel}${path})`;
  }
  return `Transcription complete (${totalChunks} ${segmentLabel}${path})`;
}
