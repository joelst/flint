import { describe, it, expect } from 'vitest';
import {
  computeFrameEnergies,
  estimateSilenceThreshold,
  findSilenceRuns,
  planTranscriptionWindows,
  planSegmentation,
  FRAME_MS,
} from './audio-segmentation';

const SR = 16000;

/** Build a waveform of alternating speech bursts and silences (durations in seconds). */
function buildWaveform(spans: Array<{ sec: number; loud: boolean }>): Float32Array {
  const total = spans.reduce((n, s) => n + Math.round(s.sec * SR), 0);
  const out = new Float32Array(total);
  let pos = 0;
  for (const span of spans) {
    const len = Math.round(span.sec * SR);
    for (let i = 0; i < len; i++) {
      // Deterministic pseudo-noise so tests never flake.
      const osc = Math.sin((pos + i) * 0.05) * Math.sin((pos + i) * 0.0031);
      out[pos + i] = span.loud ? osc * 0.5 : osc * 0.0002;
    }
    pos += len;
  }
  return out;
}

describe('computeFrameEnergies', () => {
  it('produces one RMS value per frame', () => {
    const samples = new Float32Array(SR); // 1 second
    const energies = computeFrameEnergies(samples, SR, FRAME_MS);
    expect(energies.length).toBe(1000 / FRAME_MS);
  });

  it('reports higher energy for louder audio', () => {
    const quiet = computeFrameEnergies(new Float32Array(SR).fill(0.01), SR);
    const loud = computeFrameEnergies(new Float32Array(SR).fill(0.5), SR);
    expect(loud[0]).toBeGreaterThan(quiet[0]);
  });
});

describe('estimateSilenceThreshold', () => {
  it('returns null for a near-silent recording', () => {
    const energies = computeFrameEnergies(new Float32Array(SR * 5).fill(1e-6), SR);
    expect(estimateSilenceThreshold(energies)).toBeNull();
  });

  it('returns null for a flat, continuous signal with no dynamic range', () => {
    const energies = computeFrameEnergies(new Float32Array(SR * 5).fill(0.4), SR);
    expect(estimateSilenceThreshold(energies)).toBeNull();
  });

  it('returns a threshold between silence and speech for real speech-like audio', () => {
    const wave = buildWaveform([
      { sec: 2, loud: true },
      { sec: 1, loud: false },
      { sec: 2, loud: true },
    ]);
    const energies = computeFrameEnergies(wave, SR);
    const threshold = estimateSilenceThreshold(energies);
    expect(threshold).not.toBeNull();
    expect(threshold!).toBeGreaterThan(0);
    expect(threshold!).toBeLessThan(0.5);
  });
});

describe('findSilenceRuns', () => {
  it('finds a pause between two speech bursts', () => {
    const wave = buildWaveform([
      { sec: 2, loud: true },
      { sec: 1, loud: false },
      { sec: 2, loud: true },
    ]);
    const energies = computeFrameEnergies(wave, SR);
    const runs = findSilenceRuns(energies, estimateSilenceThreshold(energies)!);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const pause = runs.find((r) => r.centerSec > 2 && r.centerSec < 3);
    expect(pause).toBeDefined();
  });

  it('ignores pauses shorter than the minimum', () => {
    const wave = buildWaveform([
      { sec: 1, loud: true },
      { sec: 0.05, loud: false }, // 50ms, well under the 300ms floor
      { sec: 1, loud: true },
    ]);
    const energies = computeFrameEnergies(wave, SR);
    const runs = findSilenceRuns(energies, estimateSilenceThreshold(energies) ?? 0.01);
    expect(runs.every((r) => r.endSec - r.startSec >= 0.3)).toBe(true);
  });
});

describe('planTranscriptionWindows', () => {
  it('returns a single window for short audio', () => {
    const windows = planTranscriptionWindows(20, []);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      startSec: 0,
      endSec: 20,
      snappedEnd: false,
      overlapsPrevious: false,
    });
  });

  it('returns nothing for empty or invalid audio', () => {
    expect(planTranscriptionWindows(0, [])).toEqual([]);
    expect(planTranscriptionWindows(Number.NaN, [])).toEqual([]);
  });

  it('falls back to fixed overlapping chunks when no silence is available', () => {
    const windows = planTranscriptionWindows(120, []);
    expect(windows.length).toBeGreaterThan(1);
    // Every non-final boundary is arbitrary, so every later window must overlap.
    expect(windows[0].hardSplitEnd).toBe(true);
    expect(windows.slice(1).every((w) => w.overlapsPrevious)).toBe(true);
    // Overlap must actually rewind the read position.
    expect(windows[1].startSec).toBeLessThan(windows[0].endSec);
  });

  it('snaps a boundary to a nearby silence run and drops the overlap', () => {
    const runs = [{ startSec: 26.5, endSec: 27.5, centerSec: 27 }];
    const windows = planTranscriptionWindows(120, runs);
    expect(windows[0].endSec).toBe(27);
    expect(windows[0].hardSplitEnd).toBe(false);
    expect(windows[0].snappedEnd).toBe(true);
    // A silence cut loses no words, so the next window starts exactly at the cut.
    expect(windows[1].startSec).toBe(27);
    expect(windows[1].overlapsPrevious).toBe(false);
    expect(windows[windows.length - 1].snappedEnd).toBe(false);
  });

  it('ignores silence runs outside the search window', () => {
    // 3s is far too early (before minSec) and 90s far too late.
    const windows = planTranscriptionWindows(120, [
      { startSec: 2.5, endSec: 3.5, centerSec: 3 },
      { startSec: 89, endSec: 91, centerSec: 90 },
    ]);
    expect(windows[0].hardSplitEnd).toBe(true);
    expect(windows[0].snappedEnd).toBe(false);
    expect(windows[0].endSec).toBe(28);
  });

  it('picks the silence run closest to the ideal boundary', () => {
    const windows = planTranscriptionWindows(120, [
      { startSec: 21, endSec: 22, centerSec: 21.5 },
      { startSec: 27, endSec: 28, centerSec: 27.5 },
    ]);
    expect(windows[0].endSec).toBe(27.5);
  });

  it('never emits a window longer than maxSec except the final one', () => {
    const windows = planTranscriptionWindows(300, []);
    for (const w of windows.slice(0, -1)) {
      expect(w.endSec - w.startSec).toBeLessThanOrEqual(30 + 1e-6);
    }
  });

  it('covers the entire recording with no gaps', () => {
    const windows = planTranscriptionWindows(200, [
      { startSec: 26, endSec: 27, centerSec: 26.5 },
      { startSec: 52, endSec: 53, centerSec: 52.5 },
    ]);
    expect(windows[0].startSec).toBe(0);
    expect(windows[windows.length - 1].endSec).toBeCloseTo(200, 5);
    for (let i = 1; i < windows.length; i++) {
      // Next window starts at or before the previous end — never leaving a gap.
      expect(windows[i].startSec).toBeLessThanOrEqual(windows[i - 1].endSec + 1e-6);
    }
  });

  it('terminates on pathological silence data instead of looping forever', () => {
    const runs = Array.from({ length: 500 }, (_, i) => ({
      startSec: i * 0.1,
      endSec: i * 0.1 + 0.05,
      centerSec: i * 0.1,
    }));
    const windows = planTranscriptionWindows(600, runs);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.length).toBeLessThan(500);
    expect(windows[windows.length - 1].endSec).toBeCloseTo(600, 5);
  });
});

describe('planSegmentation', () => {
  it('uses silence detection on speech with clear pauses', () => {
    const spans: Array<{ sec: number; loud: boolean }> = [];
    for (let i = 0; i < 6; i++) {
      spans.push({ sec: 12, loud: true });
      spans.push({ sec: 1.2, loud: false });
    }
    const plan = planSegmentation(buildWaveform(spans), SR);
    expect(plan.usedSilenceDetection).toBe(true);
    expect(plan.silenceRunCount).toBeGreaterThanOrEqual(2);
    expect(plan.windows.length).toBeGreaterThan(1);
    // At least one boundary should have landed on a real pause.
    expect(plan.windows.some((w) => !w.hardSplitEnd)).toBe(true);
  });

  it('falls back to fixed chunking for continuous speech with no pauses', () => {
    const plan = planSegmentation(buildWaveform([{ sec: 120, loud: true }]), SR);
    expect(plan.usedSilenceDetection).toBe(false);
    expect(plan.windows.length).toBeGreaterThan(1);
    expect(plan.windows.slice(1).every((w) => w.overlapsPrevious)).toBe(true);
  });

  it('falls back to fixed chunking for a near-silent recording', () => {
    const plan = planSegmentation(new Float32Array(SR * 120).fill(1e-6), SR);
    expect(plan.usedSilenceDetection).toBe(false);
    expect(plan.windows.length).toBeGreaterThan(1);
  });

  it('handles an empty buffer without throwing', () => {
    const plan = planSegmentation(new Float32Array(0), SR);
    expect(plan.windows).toEqual([]);
    expect(plan.usedSilenceDetection).toBe(false);
  });
});
