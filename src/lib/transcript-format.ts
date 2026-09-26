/**
 * Timestamped transcript formatting.
 *
 * Timings come from Flint's own audio segmentation, never from the model —
 * Foundry Local does not expose word- or segment-level timestamps. Exports are
 * therefore SEGMENT level only; there is no honest word-level timing to emit.
 */

export interface TranscriptSegment {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  startBoundary?: TranscriptBoundary;
  endBoundary?: TranscriptBoundary;
}

export type TranscriptBoundary = 'recording-edge' | 'pause-snapped' | 'fixed-window';

export interface TranscriptRange {
  startSec: number;
  endSec: number;
}

export interface TranscriptGap extends TranscriptRange {
  kind: 'failed' | 'unprocessed';
  uncertain: boolean;
}

export interface TranscriptExportState {
  segments: readonly TranscriptSegment[];
  gaps: readonly TranscriptGap[];
  emptyRecognitionRanges: readonly TranscriptRange[];
  overlapOnlyRanges: readonly TranscriptRange[];
}

export const TIMESTAMP_DISCLAIMER =
  "Timestamps are Flint-derived estimates from audio windows, not timings reported by the model.";

export function buildTimingDisclaimer(segments: readonly TranscriptSegment[]): string {
  const boundaries = (segments ?? [])
    .flatMap((segment) => [segment.startBoundary, segment.endBoundary])
    .filter((boundary): boundary is TranscriptBoundary => boundary != null);
  const hasSnapped = boundaries.includes('pause-snapped');
  const hasFixed = boundaries.includes('fixed-window');
  if (hasSnapped && hasFixed) {
    return `${TIMESTAMP_DISCLAIMER} Some boundaries were snapped to detected pauses; unsnapped boundaries remain approximate fixed-window cuts.`;
  }
  if (hasSnapped) {
    return `${TIMESTAMP_DISCLAIMER} Interior boundaries were snapped to detected pauses where shown.`;
  }
  if (hasFixed) {
    return `${TIMESTAMP_DISCLAIMER} Interior boundaries are approximate fixed-window cuts because no usable pause was available there.`;
  }
  return TIMESTAMP_DISCLAIMER;
}

function clampSeconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function splitTime(totalSec: number) {
  const t = clampSeconds(totalSec);
  const ms = Math.round(t * 1000);
  return {
    hours: Math.floor(ms / 3600000),
    minutes: Math.floor((ms % 3600000) / 60000),
    seconds: Math.floor((ms % 60000) / 1000),
    millis: ms % 1000,
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `HH:MM:SS,mmm` — SubRip. */
export function formatSrtTime(totalSec: number): string {
  const { hours, minutes, seconds, millis } = splitTime(totalSec);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/** `HH:MM:SS.mmm` — WebVTT. */
export function formatVttTime(totalSec: number): string {
  const { hours, minutes, seconds, millis } = splitTime(totalSec);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/** Short `M:SS` / `H:MM:SS` label for on-screen display. */
export function formatClockTime(totalSec: number): string {
  const { hours, minutes, seconds } = splitTime(totalSec);
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

function formatSourceRange(range: TranscriptRange): string {
  return `[${formatClockTime(range.startSec)} - ${formatClockTime(range.endSec)}]`;
}

interface DiagnosticRange extends TranscriptRange {
  order: number;
  description: string;
}

function diagnosticRanges(state: TranscriptExportState): DiagnosticRange[] {
  return [
    ...state.gaps.map((gap, order) => ({
      ...gap,
      order,
      description:
        gap.kind === 'unprocessed'
          ? 'Not processed.'
          : gap.uncertain
            ? 'Transcription failed; runtime outcome uncertain.'
            : 'Transcription failed.',
    })),
    ...state.emptyRecognitionRanges.map((range, order) => ({
      ...range,
      order: state.gaps.length + order,
      description:
        'Successfully processed; no text was recognized (this is not evidence of silence).',
    })),
    ...state.overlapOnlyRanges.map((range, order) => ({
      ...range,
      order: state.gaps.length + state.emptyRecognitionRanges.length + order,
      description:
        'Successfully processed; overlap-only/no-new-text after heuristic deduplication.',
    })),
  ].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec || a.order - b.order);
}

export function buildTranscriptMetadata(state: TranscriptExportState): string {
  const lines = [buildTimingDisclaimer(state.segments)];
  if (state.gaps.length > 0) {
    lines.push(
      'Transcript incomplete: one or more source windows failed or were not processed.',
    );
  }
  const outcomes = diagnosticRanges(state);
  if (outcomes.length > 0) {
    lines.push(
      'Source-window outcomes (raw source ranges; overlaps are intentional):',
      ...outcomes.map(
        (outcome) => `${formatSourceRange(outcome)} ${outcome.description}`,
      ),
    );
  }
  return lines.join('\n');
}

function usableSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  const cleaned = (segments ?? [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s) => ({
      ...s,
      startSec: clampSeconds(s.startSec),
      endSec: clampSeconds(s.endSec),
      text: s.text.trim(),
    }))
    .sort((a, b) => a.startSec - b.startSec);

  // Subtitle players require cues in order and non-overlapping; clamp each cue to
  // start no earlier than the previous one ended, then guarantee a visible duration.
  const out: TranscriptSegment[] = [];
  let prevEnd = 0;
  for (const seg of cleaned) {
    const startSec = Math.max(seg.startSec, prevEnd);
    const endSec = Math.max(seg.endSec, startSec + 0.05);
    out.push({ ...seg, startSec, endSec });
    prevEnd = endSec;
  }
  return out;
}

export function buildSrt(segments: readonly TranscriptSegment[]): string {
  const list = usableSegments(segments);
  if (!list.length) return '';
  return (
    list
      .map((s, i) =>
        [
          String(i + 1),
          `${formatSrtTime(s.startSec)} --> ${formatSrtTime(s.endSec)}`,
          s.text,
        ].join('\n'),
      )
      .join('\n\n') + '\n'
  );
}

/** Plain-text companion metadata for SRT, which has no portable comment header. */
export function buildSrtTimingMetadata(state: TranscriptExportState): string {
  return `${buildTranscriptMetadata(state)}\n`;
}

export function buildVtt(state: TranscriptExportState): string {
  const list = usableSegments(state.segments);
  const header = `WEBVTT\n\nNOTE\n${buildTranscriptMetadata(state)}\n`;
  if (!list.length) return `${header}\n`;
  return (
    header +
    '\n' +
    list
      .map((s) =>
        `${formatVttTime(s.startSec)} --> ${formatVttTime(s.endSec)}\n${s.text}`,
      )
      .join('\n\n') +
    '\n'
  );
}

/** Human-readable `[0:00 - 0:28] text` listing for copy/paste. */
export function buildTimestampedText(state: TranscriptExportState): string {
  const list = usableSegments(state.segments);
  const metadata = buildTranscriptMetadata(state);
  if (!list.length) {
    return diagnosticRanges(state).length > 0 ? metadata : '';
  }
  const body = list
    .map((s) => `[${formatClockTime(s.startSec)} - ${formatClockTime(s.endSec)}] ${s.text}`)
    .join('\n');
  return `${metadata}\n\n${body}`;
}

export interface CaptionDownload {
  fileName: string;
  body: string;
}

export function captionFileStem(now: Date = new Date()): string {
  return `flint-transcription-${now.toISOString().replace(/[:.]/g, '-')}`;
}

export function buildCaptionDownloads(
  format: 'srt' | 'vtt',
  state: TranscriptExportState,
  now: Date = new Date(),
): CaptionDownload[] {
  const stem = captionFileStem(now);
  if (format === 'srt') {
    const body = buildSrt(state.segments);
    const metadata = buildSrtTimingMetadata(state);
    if (!body && diagnosticRanges(state).length === 0) return [];
    return [
      ...(body ? [{ fileName: `${stem}.srt`, body }] : []),
      { fileName: `${stem}.timing.txt`, body: metadata },
    ];
  }
  const body = buildVtt(state);
  return body ? [{ fileName: `${stem}.vtt`, body }] : [];
}
