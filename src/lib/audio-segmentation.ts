/**
 * Audio segmentation for timestamped transcription.
 *
 * Foundry Local returns no timing data of any kind (`transcribe()` has no
 * `segments` array and reports `duration: 0`; the live-session `start_time` /
 * `end_time` fields are declared in the SDK types but the native core leaves them
 * null). So any timestamps Flint shows must be derived from the audio itself.
 *
 * Strategy: keep transcribing in ~28s windows — Whisper-family models are tuned
 * for ~30s context and degrade/hallucinate on short clips — but *snap* each window
 * boundary to a nearby silence run. That keeps transcription quality while making
 * the window boundaries line up with real pauses in speech.
 *
 * When a boundary cannot be snapped to silence (continuous speech, music, noise,
 * or a near-silent recording) the window is hard-split at the target length and the
 * next window overlaps it, exactly like the original fixed-chunk behaviour, so the
 * text-stitching dedupe can still recover words cut mid-utterance.
 *
 * Timestamps produced this way are APPROXIMATE. They are not model-provided.
 */

export interface SilenceRun {
  startSec: number;
  endSec: number;
  /** Midpoint of the silence run — the preferred cut point. */
  centerSec: number;
}

export interface TranscriptionWindow {
  index: number;
  startSec: number;
  endSec: number;
  /** True when this window ends at an arbitrary chunk boundary, not a pause or recording end. */
  hardSplitEnd: boolean;
  /** True only when the end boundary is an interior detected pause. */
  snappedEnd: boolean;
  /** True when this window's START overlaps the previous window and needs dedupe. */
  overlapsPrevious: boolean;
}

export interface WindowPlanOptions {
  targetSec?: number;
  minSec?: number;
  maxSec?: number;
  /** How far either side of the ideal boundary to hunt for silence. */
  searchSec?: number;
  /** Overlap applied only after a hard split. */
  overlapSec?: number;
}

const DEFAULTS = {
  targetSec: 28,
  minSec: 12,
  maxSec: 30,
  searchSec: 8,
  overlapSec: 4,
};

/** Frame size used for the short-time energy profile. */
export const FRAME_MS = 20;
/** A pause must be at least this long to count as a boundary candidate. */
export const MIN_SILENCE_MS = 300;

function percentile(sorted: ArrayLike<number>, fraction: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.round((n - 1) * fraction)));
  return sorted[idx];
}

/** Root-mean-square energy per fixed-length frame. */
export function computeFrameEnergies(
  samples: Float32Array | ArrayLike<number>,
  sampleRate: number,
  frameMs: number = FRAME_MS,
): Float32Array {
  const frameLen = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const count = Math.floor(samples.length / frameLen);
  const out = new Float32Array(Math.max(0, count));
  for (let f = 0; f < count; f++) {
    const base = f * frameLen;
    let sum = 0;
    for (let i = 0; i < frameLen; i++) {
      const v = samples[base + i] || 0;
      sum += v * v;
    }
    out[f] = Math.sqrt(sum / frameLen);
  }
  return out;
}

/**
 * Adaptive silence threshold. Returns null when the signal has too little dynamic
 * range to separate speech from silence (steady noise, music, or a near-silent
 * recording) — the caller must then fall back to fixed-length windows.
 */
export function estimateSilenceThreshold(energies: Float32Array): number | null {
  if (energies.length < 8) return null;
  const sorted = Float32Array.from(energies).sort();
  const floor = percentile(sorted, 0.1);
  const peak = percentile(sorted, 0.9);
  // Essentially silent recording: nothing meaningful to segment.
  if (peak < 1e-4) return null;
  // Flat energy profile (continuous speech, music, steady noise): no usable pauses.
  if (peak <= floor * 1.5) return null;
  return floor + 0.12 * (peak - floor);
}

/** Locate runs of consecutive sub-threshold frames at least `minSilenceMs` long. */
export function findSilenceRuns(
  energies: Float32Array,
  threshold: number,
  frameMs: number = FRAME_MS,
  minSilenceMs: number = MIN_SILENCE_MS,
): SilenceRun[] {
  const runs: SilenceRun[] = [];
  const minFrames = Math.max(1, Math.ceil(minSilenceMs / frameMs));
  let runStart = -1;
  const flush = (endExclusive: number) => {
    if (runStart < 0) return;
    const len = endExclusive - runStart;
    if (len >= minFrames) {
      const startSec = (runStart * frameMs) / 1000;
      const endSec = (endExclusive * frameMs) / 1000;
      runs.push({ startSec, endSec, centerSec: (startSec + endSec) / 2 });
    }
    runStart = -1;
  };
  for (let f = 0; f < energies.length; f++) {
    if (energies[f] <= threshold) {
      if (runStart < 0) runStart = f;
    } else {
      flush(f);
    }
  }
  flush(energies.length);
  return runs;
}

/**
 * Plan transcription windows over `totalSec`, snapping boundaries to silence runs
 * where possible and hard-splitting (with overlap) where not.
 *
 * Passing an empty `silenceRuns` array yields the original fixed-chunk behaviour.
 */
export function planTranscriptionWindows(
  totalSec: number,
  silenceRuns: readonly SilenceRun[] = [],
  options: WindowPlanOptions = {},
): TranscriptionWindow[] {
  const targetSec = options.targetSec ?? DEFAULTS.targetSec;
  const minSec = options.minSec ?? DEFAULTS.minSec;
  const maxSec = options.maxSec ?? DEFAULTS.maxSec;
  const searchSec = options.searchSec ?? DEFAULTS.searchSec;
  const overlapSec = options.overlapSec ?? DEFAULTS.overlapSec;

  const duration = Number.isFinite(totalSec) ? Math.max(0, totalSec) : 0;
  if (duration <= 0) return [];

  const centers = silenceRuns
    .map((run) => run.centerSec)
    .filter((c) => Number.isFinite(c))
    .sort((a, b) => a - b);

  const windows: TranscriptionWindow[] = [];
  let pos = 0;
  let overlapsPrevious = false;
  let guard = 0;

  while (pos < duration - 0.05) {
    if (guard++ > 10000) break; // defensive: never spin
    const remaining = duration - pos;
    if (remaining <= maxSec) {
      windows.push({
        index: windows.length,
        startSec: pos,
        endSec: duration,
        hardSplitEnd: false,
        snappedEnd: false,
        overlapsPrevious,
      });
      break;
    }

    const idealEnd = pos + targetSec;
    const lo = Math.max(pos + minSec, idealEnd - searchSec);
    const hi = Math.min(pos + maxSec, idealEnd + searchSec);

    let cut: number | null = null;
    for (const c of centers) {
      if (c < lo) continue;
      if (c > hi) break;
      if (cut === null || Math.abs(c - idealEnd) < Math.abs(cut - idealEnd)) cut = c;
    }

    const hardSplitEnd = cut === null;
    const endSec = hardSplitEnd ? Math.min(pos + targetSec, duration) : cut!;

    windows.push({
      index: windows.length,
      startSec: pos,
      endSec,
      hardSplitEnd,
      snappedEnd: !hardSplitEnd,
      overlapsPrevious,
    });

    // Only re-read audio when the cut was arbitrary; silence cuts lose no words.
    const nextPos = hardSplitEnd ? endSec - overlapSec : endSec;
    overlapsPrevious = hardSplitEnd;
    pos = nextPos > pos ? nextPos : endSec;
  }

  return windows;
}

export interface SegmentationPlan {
  windows: TranscriptionWindow[];
  /** True only when at least one emitted interior boundary was snapped to a pause. */
  usedSilenceDetection: boolean;
  silenceRunCount: number;
  snappedBoundaryCount: number;
  hardSplitBoundaryCount: number;
  timingStrategy: 'single-window' | 'silence-snapped' | 'fixed-windows' | 'mixed';
}

/**
 * Full pipeline: analyse the waveform, then plan windows. Falls back to
 * fixed-length overlapping windows whenever silence detection is unusable.
 */
export function planSegmentation(
  samples: Float32Array | ArrayLike<number>,
  sampleRate: number,
  options: WindowPlanOptions = {},
): SegmentationPlan {
  const totalSec = sampleRate > 0 ? samples.length / sampleRate : 0;
  const energies = computeFrameEnergies(samples, sampleRate);
  const threshold = estimateSilenceThreshold(energies);
  const runs = threshold === null ? [] : findSilenceRuns(energies, threshold);

  const windows = planTranscriptionWindows(totalSec, runs, options);
  const snappedBoundaryCount = windows.filter((window) => window.snappedEnd).length;
  const hardSplitBoundaryCount = windows.filter((window) => window.hardSplitEnd).length;
  const timingStrategy =
    windows.length <= 1
      ? 'single-window'
      : snappedBoundaryCount > 0 && hardSplitBoundaryCount > 0
        ? 'mixed'
        : snappedBoundaryCount > 0
          ? 'silence-snapped'
          : 'fixed-windows';

  return {
    windows,
    usedSilenceDetection: snappedBoundaryCount > 0,
    silenceRunCount: runs.length,
    snappedBoundaryCount,
    hardSplitBoundaryCount,
    timingStrategy,
  };
}
