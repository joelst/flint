import { describe, it, expect } from 'vitest';
import {
  computeFrameEnergies,
  computeFrameEnergiesAsync,
  estimateSilenceThreshold,
  findSilenceRuns,
  planTranscriptionWindows,
  planSegmentation,
  planSegmentationAsync,
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

function expectValidWindows(
  windows: ReturnType<typeof planTranscriptionWindows>,
  totalSec: number,
  minSec = 12,
  maxSec = 30,
): void {
  expect(windows.length).toBeGreaterThan(0);
  expect(windows[0].startSec).toBe(0);
  expect(windows.at(-1)?.endSec).toBeCloseTo(totalSec, 5);

  for (const [index, window] of windows.entries()) {
    const length = window.endSec - window.startSec;
    expect(window.index).toBe(index);
    expect(length).toBeGreaterThan(0);
    expect(length).toBeLessThanOrEqual(maxSec + 1e-6);
    if (totalSec >= minSec) expect(length).toBeGreaterThanOrEqual(minSec - 1e-6);
    if (window.endSec < totalSec - 1e-6) {
      expect(window.hardSplitEnd || window.snappedEnd).toBe(true);
      expect(window.hardSplitEnd && window.snappedEnd).toBe(false);
    } else {
      expect(window.hardSplitEnd).toBe(false);
      expect(window.snappedEnd).toBe(false);
    }

    if (index === 0) {
      expect(window.overlapsPrevious).toBe(false);
      continue;
    }

    const previous = windows[index - 1];
    expect(window.startSec).toBeGreaterThan(previous.startSec);
    expect(window.startSec).toBeLessThanOrEqual(previous.endSec + 1e-6);
    expect(window.overlapsPrevious).toBe(window.startSec < previous.endSec - 1e-6);
    expect(window.overlapsPrevious).toBe(previous.hardSplitEnd);
  }
}

function buildTrailingPauseWaveform(totalSec: number): Float32Array {
  return buildWaveform([
    { sec: 29.5, loud: true },
    { sec: 1, loud: false },
    { sec: 29, loud: true },
    { sec: 1, loud: false },
    { sec: 29, loud: true },
    { sec: totalSec - 89.5, loud: false },
  ]);
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
    const windows = planTranscriptionWindows(5, []);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      startSec: 0,
      endSec: 5,
      snappedEnd: false,
      overlapsPrevious: false,
    });
    expectValidWindows(windows, 5);
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

  it.each([90, 90.05, 90.1, 90.5])(
    'reserves a usable tail around the 90-second silence boundary at %s seconds',
    (duration) => {
      const windows = planTranscriptionWindows(duration, [
        { startSec: 29.5, endSec: 30.5, centerSec: 30 },
        { startSec: 59.5, endSec: 60.5, centerSec: 60 },
        { startSec: 89.5, endSec: duration, centerSec: (89.5 + duration) / 2 },
      ]);

      expectValidWindows(windows, duration);
      if (duration === 90) {
        expect(windows).toHaveLength(3);
        expect(windows.at(-1)?.startSec).toBe(60);
      } else {
        expect(windows.at(-1)?.endSec! - windows.at(-1)?.startSec!).toBeCloseTo(12, 5);
        expect(windows.at(-1)?.overlapsPrevious).toBe(true);
      }
    },
  );

  it('rebalances a pause-free hard split instead of dispatching a short tail', () => {
    const windows = planTranscriptionWindows(102.05, []);

    expectValidWindows(windows, 102.05);
    expect(windows.at(-1)?.endSec! - windows.at(-1)?.startSec!).toBeCloseTo(12, 5);
    expect(windows.at(-1)?.overlapsPrevious).toBe(true);
    expect(windows.at(-2)?.endSec).toBeCloseTo(94.05, 5);
    expect(windows.at(-2)?.endSec! - windows.at(-1)?.startSec!).toBeCloseTo(4, 5);
  });

  it('accepts exact minimum tails after silence and hard-split boundaries', () => {
    const snapped = planTranscriptionWindows(40, [
      { startSec: 27.5, endSec: 28.5, centerSec: 28 },
    ]);
    const hardSplit = planTranscriptionWindows(36, []);

    expectValidWindows(snapped, 40);
    expect(snapped.at(-1)?.endSec! - snapped.at(-1)?.startSec!).toBeCloseTo(12, 5);
    expect(snapped.at(-1)?.overlapsPrevious).toBe(false);
    expectValidWindows(hardSplit, 36);
    expect(hardSplit.at(-1)?.endSec! - hardSplit.at(-1)?.startSec!).toBeCloseTo(12, 5);
    expect(hardSplit.at(-1)?.overlapsPrevious).toBe(true);
  });

  it('supports feasible custom window options without gaps or oversized overlap', () => {
    const options = {
      minSec: 8,
      targetSec: 18,
      maxSec: 20,
      searchSec: 5,
      overlapSec: 3,
    };
    const windows = planTranscriptionWindows(
      67.25,
      [
        { startSec: 17, endSec: 18, centerSec: 17.5 },
        { startSec: 36, endSec: 37, centerSec: 36.5 },
        { startSec: 63, endSec: 64, centerSec: 63.5 },
      ],
      options,
    );

    expectValidWindows(windows, 67.25, options.minSec, options.maxSec);
    for (let i = 1; i < windows.length; i++) {
      const overlap = windows[i - 1].endSec - windows[i].startSec;
      expect(overlap).toBeLessThanOrEqual(options.overlapSec + 1e-6);
    }
  });

  it.each([
    [{ minSec: Number.NaN }, 'minSec'],
    [{ targetSec: -1 }, 'targetSec'],
    [{ maxSec: Number.POSITIVE_INFINITY }, 'maxSec'],
    [{ searchSec: -0.1 }, 'searchSec'],
    [{ overlapSec: -0.1 }, 'overlapSec'],
    [{ minSec: 20, targetSec: 18 }, 'minSec'],
    [{ targetSec: 31, maxSec: 30 }, 'targetSec'],
    [{ minSec: 12, targetSec: 18, maxSec: 19, overlapSec: 4 }, 'feasible'],
    [{ minSec: 12, overlapSec: 12 }, 'overlapSec'],
    // targetSec === minSec with overlap just under it advances ~1ms per hard split,
    // which previously exhausted the spin guard and returned a plan covering only
    // part of the audio.
    [{ targetSec: 12, minSec: 12, overlapSec: 11.999 }, 'forward progress'],
    [{ targetSec: 20, minSec: 12, overlapSec: 10 }, 'forward progress'],
  ] as const)('rejects infeasible options %j', (options, message) => {
    expect(() => planTranscriptionWindows(60, [], options)).toThrow(message);
  });

  it('covers the whole input for every accepted option set', () => {
    const accepted = [
      {},
      { targetSec: 12, minSec: 12, overlapSec: 0 },
      { minSec: 8, targetSec: 18, maxSec: 20, searchSec: 5, overlapSec: 3 },
      { minSec: 12, targetSec: 28, maxSec: 30, overlapSec: 4 },
    ];
    for (const options of accepted) {
      for (const duration of [30, 60, 137, 600]) {
        const windows = planTranscriptionWindows(duration, [], options);
        const last = windows[windows.length - 1];
        expect(windows[0].startSec).toBe(0);
        // A plan that stops short would silently drop the remaining audio.
        expect(last.endSec).toBeGreaterThanOrEqual(duration - 1e-6);
      }
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

  it('plans long audio with dense minimum-length snaps without tripping the bound', () => {
    // Silence every minSec forces the shortest legal advance on every boundary, the
    // worst case for the window-count bound. It must still cover the full duration.
    const runs = Array.from({ length: 400 }, (_, i) => ({
      startSec: 12 * (i + 1) - 0.05,
      endSec: 12 * (i + 1) + 0.05,
      centerSec: 12 * (i + 1),
    }));
    for (const duration of [600, 1800, 3600]) {
      const windows = planTranscriptionWindows(duration, runs);
      expect(windows[windows.length - 1].endSec).toBeCloseTo(duration, 5);
    }
  });
});

describe('planSegmentation', () => {
  it.each([90, 90.05, 90.1, 90.5])(
    'does not derive a sub-floor dispatch from a trailing pause at %s seconds',
    (duration) => {
      const plan = planSegmentation(buildTrailingPauseWaveform(duration), SR);
      expect(plan.snappedBoundaryCount).toBeGreaterThan(0);
      expectValidWindows(plan.windows, duration);
    },
  );

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
    expect(plan.snappedBoundaryCount).toBeGreaterThan(0);
  });

  it('uses one usable pause even when other detected pauses cannot snap a boundary', () => {
    const plan = planSegmentation(
      buildWaveform([
        { sec: 2, loud: true },
        { sec: 1, loud: false },
        { sec: 23, loud: true },
        { sec: 1, loud: false },
        { sec: 65, loud: true },
      ]),
      SR,
    );
    expect(plan.silenceRunCount).toBe(2);
    expect(plan.snappedBoundaryCount).toBe(1);
    expect(plan.usedSilenceDetection).toBe(true);
    expect(plan.timingStrategy).toBe('mixed');
  });

  it('does not claim silence provenance when detected pauses are unusable', () => {
    const plan = planSegmentation(
      buildWaveform([
        { sec: 2, loud: true },
        { sec: 1, loud: false },
        { sec: 117, loud: true },
      ]),
      SR,
    );
    expect(plan.silenceRunCount).toBe(1);
    expect(plan.snappedBoundaryCount).toBe(0);
    expect(plan.usedSilenceDetection).toBe(false);
    expect(plan.timingStrategy).toBe('fixed-windows');
  });

  it('does not label recording start or end as pause-snapped boundaries', () => {
    const plan = planSegmentation(
      buildWaveform([
        { sec: 27, loud: true },
        { sec: 1, loud: false },
        { sec: 20, loud: true },
      ]),
      SR,
    );
    expect(plan.windows[0].snappedEnd).toBe(true);
    expect(plan.windows.at(-1)?.snappedEnd).toBe(false);
    expect(plan.windows.at(-1)?.hardSplitEnd).toBe(false);
  });

  it('falls back to fixed chunking for continuous speech with no pauses', () => {
    const plan = planSegmentation(buildWaveform([{ sec: 120, loud: true }]), SR);
    expect(plan.usedSilenceDetection).toBe(false);
    expect(plan.windows.length).toBeGreaterThan(1);
    expect(plan.windows.slice(1).every((w) => w.overlapsPrevious)).toBe(true);
    expect(plan.timingStrategy).toBe('fixed-windows');
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

describe('computeFrameEnergiesAsync', () => {
  it('matches the synchronous computation exactly', async () => {
    const wave = buildWaveform([
      { sec: 1, loud: true },
      { sec: 0.5, loud: false },
      { sec: 1, loud: true },
    ]);
    const sync = computeFrameEnergies(wave, SR);
    const async = await computeFrameEnergiesAsync(wave, SR);
    expect(Array.from(async)).toEqual(Array.from(sync));
  });

  it('handles an empty buffer without throwing', async () => {
    const async = await computeFrameEnergiesAsync(new Float32Array(0), SR);
    expect(async.length).toBe(0);
  });

  it('rejects a non-positive-integer framesPerChunk instead of hanging or corrupting output', async () => {
    const wave = new Float32Array(SR).fill(0.1);
    await expect(computeFrameEnergiesAsync(wave, SR, FRAME_MS, 0)).rejects.toThrow(RangeError);
    await expect(computeFrameEnergiesAsync(wave, SR, FRAME_MS, -5)).rejects.toThrow(RangeError);
    await expect(computeFrameEnergiesAsync(wave, SR, FRAME_MS, 2.5)).rejects.toThrow(RangeError);
    await expect(computeFrameEnergiesAsync(wave, SR, FRAME_MS, NaN)).rejects.toThrow(RangeError);
  });

  it('yields to the event loop instead of consuming all samples before its first pause', async () => {
    // A pending promise or a timer-call count alone doesn't prove cooperative
    // computation — an implementation could finish all the work before its
    // first timer fires and still pass those assertions. So instead: prove a
    // bounded prefix of samples was read by the time the async call *returns
    // control* (i.e. before the caller even awaits it), not the whole buffer.
    const frameLen = Math.floor((SR * FRAME_MS) / 1000);
    const framesPerChunk = 50;
    const totalFrames = framesPerChunk * 3;
    const totalSamples = totalFrames * frameLen;
    let maxIndexRead = -1;
    const raw = new Float32Array(totalSamples).fill(0.1);
    const samples = new Proxy(raw, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const idx = Number(prop);
          if (idx > maxIndexRead) maxIndexRead = idx;
        }
        return Reflect.get(target, prop, target);
      },
    });

    const promise = computeFrameEnergiesAsync(samples, SR, FRAME_MS, framesPerChunk);
    // Synchronous continuation up to the first `await` has already run.
    expect(maxIndexRead).toBeGreaterThanOrEqual(0);
    expect(maxIndexRead).toBeLessThan(totalSamples - 1);

    await promise;
    expect(maxIndexRead).toBe(totalSamples - 1);
  });
});

describe('planSegmentationAsync', () => {
  it('matches the synchronous plan exactly', async () => {
    const wave = buildWaveform([
      { sec: 5, loud: true },
      { sec: 1, loud: false },
      { sec: 20, loud: true },
    ]);
    const sync = planSegmentation(wave, SR);
    const async = await planSegmentationAsync(wave, SR);
    expect(async).toEqual(sync);
  });
});
