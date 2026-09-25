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
  /** True when this segment's boundary was snapped to a detected pause. */
  snapped?: boolean;
}

export const TIMESTAMP_DISCLAIMER =
  "Timestamps are approximate. They are based on Flint's audio segmentation; silence detection is used when available, with fixed-length windows as a fallback. They are not reported by the model.";

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
export function buildSrtTimingMetadata(): string {
  return `${TIMESTAMP_DISCLAIMER}\n`;
}

export function buildVtt(segments: readonly TranscriptSegment[]): string {
  const list = usableSegments(segments);
  const header = `WEBVTT\n\nNOTE\n${TIMESTAMP_DISCLAIMER}\n`;
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
export function buildTimestampedText(segments: readonly TranscriptSegment[]): string {
  const list = usableSegments(segments);
  if (!list.length) return '';
  return list
    .map((s) => `[${formatClockTime(s.startSec)} - ${formatClockTime(s.endSec)}] ${s.text}`)
    .join('\n');
}
