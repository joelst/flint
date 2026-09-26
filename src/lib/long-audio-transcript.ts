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

export function normalizeTranscriptText(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function comparableWord(word: string): string {
  return word.toLocaleLowerCase();
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

export function buildLongAudioCompletionStatus(
  result: AssembledLongAudioTranscript & { totalChunks: number },
  path = '',
): string {
  const failed = Number(result.failedChunks || 0);
  const uncertain = Number(result.uncertainChunks || 0);
  const unprocessed = Number(result.unprocessedChunks || 0);
  const totalSegments = Number(result.totalChunks || 0);
  if (failed > 0) {
    const detail =
      uncertain > 0
        ? `${failed} of ${totalSegments} segments did not complete (${uncertain} had uncertain outcomes and ${unprocessed} were not processed)`
        : unprocessed > 0
          ? `${failed} of ${totalSegments} segments did not complete (${unprocessed} were not processed)`
          : `${failed} of ${totalSegments} segments failed`;
    return `Transcription incomplete: ${detail}. The text below is missing those parts.${path}`;
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
    return `Transcription complete with qualifications: ${qualifications.join('; ')} (${totalSegments} segments${path})`;
  }
  return `Transcription complete (${totalSegments} segments${path})`;
}
