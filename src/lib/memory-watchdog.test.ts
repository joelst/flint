import { describe, it, expect } from 'vitest';
import {
  evaluate,
  emptyWatchState,
  normalizeWatchConfig,
  dismissDevice,
  dismissAll,
  formatAlertSummary,
  formatAlertAdvice,
  toWatchSample,
  DEFAULT_WATCH_CONFIG,
  type WatchConfig,
  type WatchDevice,
  type WatchState,
} from './memory-watchdog';

const config = (over: Partial<WatchConfig> = {}): WatchConfig => ({
  ...DEFAULT_WATCH_CONFIG,
  sustainMs: 30_000,
  maxSampleGapMs: 120_000,
  ...over,
});

const ram = (usedPct: number): WatchDevice => ({
  id: 'ram', label: 'System memory', kind: 'ram', usedMb: usedPct * 100, totalMb: 10_000,
});
const gpu = (usedPct: number, name = 'RTX 4080'): WatchDevice => ({
  id: `gpu:${name}`, label: name, kind: 'gpu', usedMb: usedPct * 160, totalMb: 16_000,
});

/** Drives a sequence of samples through evaluate, returning every step. */
function run (
  samples: Array<{ at: number; devices: WatchDevice[]; modelsResident?: number }>,
  cfg = config(),
  start: WatchState = emptyWatchState(),
) {
  let state = start;
  const steps = samples.map(s => {
    const result = evaluate(state, { at: s.at, devices: s.devices, modelsResident: s.modelsResident ?? 1 }, cfg);
    state = result.state;
    return result;
  });
  return { steps, state, last: steps[steps.length - 1] };
}

describe('memory-watchdog thresholds', () => {
  it('does not raise on a single high sample', () => {
    const { last } = run([{ at: 1_000, devices: [ram(95)] }]);
    expect(last.raised).toEqual([]);
    expect(last.active).toEqual([]);
  });

  it('raises once usage stays high for the sustain window', () => {
    const { steps } = run([
      { at: 0, devices: [ram(95)] },
      { at: 20_000, devices: [ram(95)] },
      { at: 30_000, devices: [ram(95)] },
    ]);
    expect(steps[0].raised).toEqual([]);
    expect(steps[1].raised).toEqual([]);
    expect(steps[2].raised.map(a => a.id)).toEqual(['ram']);
  });

  it('treats the threshold as inclusive', () => {
    const { last } = run([
      { at: 0, devices: [ram(90)] },
      { at: 30_000, devices: [ram(90)] },
    ]);
    expect(last.raised.map(a => a.id)).toEqual(['ram']);
  });

  it('does not raise a hair below the threshold', () => {
    const { last } = run([
      { at: 0, devices: [ram(89.9)] },
      { at: 30_000, devices: [ram(89.9)] },
    ]);
    expect(last.raised).toEqual([]);
  });

  it('raises exactly at the sustain boundary, not before', () => {
    const { steps } = run([
      { at: 0, devices: [ram(95)] },
      { at: 29_999, devices: [ram(95)] },
      { at: 30_000, devices: [ram(95)] },
    ]);
    expect(steps[1].raised).toEqual([]);
    expect(steps[2].raised).toHaveLength(1);
  });

  it('restarts the sustain window when usage dips below the threshold', () => {
    const { last } = run([
      { at: 0, devices: [ram(95)] },
      { at: 20_000, devices: [ram(50)] },
      { at: 40_000, devices: [ram(95)] },
    ]);
    expect(last.raised).toEqual([]);
    expect(last.state.devices.ram.since).toBe(40_000);
  });

  it('applies a separate, higher threshold to accelerators', () => {
    // 92% is over the RAM threshold but under the VRAM one: a GPU running hot during
    // inference is normal and must not alert on the RAM rule.
    const { last } = run([
      { at: 0, devices: [ram(92), gpu(92)] },
      { at: 30_000, devices: [ram(92), gpu(92)] },
    ]);
    expect(last.raised.map(a => a.id)).toEqual(['ram']);
  });
});

describe('memory-watchdog hysteresis', () => {
  it('keeps alerting while usage sits between the clear point and the threshold', () => {
    const { steps } = run([
      { at: 0, devices: [ram(95)] },
      { at: 30_000, devices: [ram(95)] },
      { at: 60_000, devices: [ram(85)] }, // below 90, still above 82
    ]);
    expect(steps[2].cleared).toEqual([]);
    expect(steps[2].active.map(a => a.id)).toEqual(['ram']);
  });

  it('clears only once usage falls below threshold minus the margin', () => {
    const { steps } = run([
      { at: 0, devices: [ram(95)] },
      { at: 30_000, devices: [ram(95)] },
      { at: 60_000, devices: [ram(81)] },
    ]);
    expect(steps[2].cleared).toEqual(['ram']);
    expect(steps[2].active).toEqual([]);
  });

  it('does not re-raise immediately after clearing', () => {
    const { steps } = run([
      { at: 0, devices: [ram(95)] },
      { at: 30_000, devices: [ram(95)] },
      { at: 60_000, devices: [ram(50)] },
      { at: 70_000, devices: [ram(95)] },
    ]);
    expect(steps[3].raised).toEqual([]);
  });
});

describe('memory-watchdog sample integrity', () => {
  it('restarts the sustain window after a gap longer than maxSampleGapMs', () => {
    // A laptop that slept between the two samples observed nothing in between.
    const { last } = run([
      { at: 0, devices: [ram(95)] },
      { at: 3_600_000, devices: [ram(95)] },
    ]);
    expect(last.raised).toEqual([]);
    expect(last.state.devices.ram.since).toBe(3_600_000);
  });

  it('still raises across an acceptable gap', () => {
    const { last } = run([
      { at: 0, devices: [ram(95)] },
      { at: 100_000, devices: [ram(95)] },
    ]);
    expect(last.raised).toHaveLength(1);
  });

  it('ignores an out-of-order sample', () => {
    const cfg = config();
    let state = emptyWatchState();
    state = evaluate(state, { at: 50_000, devices: [ram(95)], modelsResident: 1 }, cfg).state;
    const stale = evaluate(state, { at: 10_000, devices: [ram(20)], modelsResident: 1 }, cfg);
    expect(stale.state).toBe(state);
    expect(stale.state.at).toBe(50_000);
  });

  it('ignores a duplicate timestamp', () => {
    const cfg = config();
    const first = evaluate(emptyWatchState(), { at: 1_000, devices: [ram(95)], modelsResident: 1 }, cfg);
    const dup = evaluate(first.state, { at: 1_000, devices: [ram(95)], modelsResident: 1 }, cfg);
    expect(dup.state).toBe(first.state);
  });

  it('ignores a sample with a non-finite timestamp', () => {
    const cfg = config();
    const first = evaluate(emptyWatchState(), { at: 1_000, devices: [ram(95)], modelsResident: 1 }, cfg);
    const bad = evaluate(first.state, { at: Number.NaN, devices: [ram(95)], modelsResident: 1 }, cfg);
    expect(bad.state).toBe(first.state);
  });

  it('keeps reporting the active alert when a sample is rejected', () => {
    // The banner must not blink off because one poll came back out of order.
    const cfg = config();
    const { state } = run([
      { at: 0, devices: [ram(95)] },
      { at: 30_000, devices: [ram(95)] },
    ], cfg);
    const stale = evaluate(state, { at: 10_000, devices: [ram(20)], modelsResident: 1 }, cfg);
    expect(stale.active).toEqual([
      { id: 'ram', label: 'System memory', kind: 'ram', pct: 95, usedMb: 9_500, totalMb: 10_000 },
    ]);
  });

  it('skips devices with unusable metrics', () => {
    const bad: WatchDevice[] = [
      { id: 'zero', label: 'Zero', kind: 'gpu', usedMb: 10, totalMb: 0 },
      { id: 'neg', label: 'Negative', kind: 'gpu', usedMb: -5, totalMb: 100 },
      { id: 'nan', label: 'NaN', kind: 'gpu', usedMb: Number.NaN, totalMb: 100 },
      { id: 'absurd', label: 'Absurd', kind: 'gpu', usedMb: 10_000, totalMb: 100 },
    ];
    const { last } = run([
      { at: 0, devices: bad },
      { at: 30_000, devices: bad },
    ]);
    expect(last.raised).toEqual([]);
    expect(Object.keys(last.state.devices)).toEqual([]);
  });

  it('ignores a duplicate device id within one sample', () => {
    const { last } = run([{ at: 0, devices: [ram(95), { ...ram(10), label: 'Impostor' }] }]);
    expect(last.state.devices.ram.label).toBe('System memory');
  });
});

describe('memory-watchdog device lifecycle', () => {
  const vanish = () => run([
    { at: 0, devices: [ram(50), gpu(99)] },
    { at: 30_000, devices: [ram(50), gpu(99)] },
    { at: 60_000, devices: [ram(50)] },
    { at: 90_000, devices: [ram(50)] },
    { at: 120_000, devices: [ram(50)] },
  ]);

  it('tolerates a device missing from a sample or two', () => {
    const { steps } = vanish();
    expect(steps[1].raised.map(a => a.id)).toEqual(['gpu:RTX 4080']);
    // One failed probe should not tear down the alert.
    expect(steps[2].active.map(a => a.id)).toEqual(['gpu:RTX 4080']);
    expect(steps[3].active.map(a => a.id)).toEqual(['gpu:RTX 4080']);
  });

  it('drops a device that stays gone, clearing its alert', () => {
    const { steps, state } = vanish();
    expect(steps[4].cleared).toEqual(['gpu:RTX 4080']);
    expect(steps[4].active).toEqual([]);
    expect(state.devices['gpu:RTX 4080']).toBeUndefined();
  });

  it('resets the missing counter when a device comes back', () => {
    const { state } = run([
      { at: 0, devices: [ram(50), gpu(99)] },
      { at: 30_000, devices: [ram(50)] },
      { at: 60_000, devices: [ram(50), gpu(99)] },
    ]);
    expect(state.devices['gpu:RTX 4080'].missing).toBe(0);
  });

  it('tracks identically named cards separately', () => {
    const sample = toWatchSample({
      totalMemMb: 1000, usedMemMb: 100, models: [],
      accelerators: [
        { kind: 'gpu', name: 'RTX 4080', usedMb: 1, totalMb: 2 },
        { kind: 'gpu', name: 'RTX 4080', usedMb: 1, totalMb: 2 },
      ],
    }, 0);
    expect(sample.devices.map(d => d.id)).toEqual(['ram', 'gpu:RTX 4080', 'gpu:RTX 4080#2']);
  });

  it('raises for several devices at once', () => {
    const { last } = run([
      { at: 0, devices: [ram(95), gpu(99)] },
      { at: 30_000, devices: [ram(95), gpu(99)] },
    ]);
    expect(last.raised.map(a => a.id).sort()).toEqual(['gpu:RTX 4080', 'ram']);
  });
});

describe('memory-watchdog dismissal', () => {
  const alerted = () => run([
    { at: 0, devices: [ram(95)] },
    { at: 30_000, devices: [ram(95)] },
  ]);

  it('hides a dismissed alert while usage stays high', () => {
    const { state } = alerted();
    const dismissed = dismissDevice(state, 'ram');
    const next = evaluate(dismissed, { at: 60_000, devices: [ram(96)], modelsResident: 1 }, config());
    expect(next.active).toEqual([]);
    expect(next.state.devices.ram.alerting).toBe(true);
  });

  it('re-arms after recovery so a later crossing alerts again', () => {
    const { state } = alerted();
    let s = dismissDevice(state, 'ram');
    s = evaluate(s, { at: 60_000, devices: [ram(50)], modelsResident: 1 }, config()).state;
    expect(s.devices.ram.dismissed).toBe(false);

    const again = run([
      { at: 90_000, devices: [ram(95)] },
      { at: 120_000, devices: [ram(95)] },
    ], config(), s);
    expect(again.last.raised.map(a => a.id)).toEqual(['ram']);
    expect(again.last.active).toHaveLength(1);
  });

  it('leaves state untouched when dismissing something not alerting', () => {
    const state = emptyWatchState();
    expect(dismissDevice(state, 'ram')).toBe(state);
    const { state: pending } = run([{ at: 0, devices: [ram(95)] }]);
    expect(dismissDevice(pending, 'ram')).toBe(pending);
  });

  it('dismisses every active device at once', () => {
    const { state } = run([
      { at: 0, devices: [ram(95), gpu(99)] },
      { at: 30_000, devices: [ram(95), gpu(99)] },
    ]);
    const next = evaluate(dismissAll(state), { at: 60_000, devices: [ram(95), gpu(99)], modelsResident: 1 }, config());
    expect(next.active).toEqual([]);
  });
});

describe('memory-watchdog configuration', () => {
  it('clears everything when disabled', () => {
    const { state } = run([
      { at: 0, devices: [ram(95)] },
      { at: 30_000, devices: [ram(95)] },
    ]);
    const off = evaluate(state, { at: 60_000, devices: [ram(95)], modelsResident: 1 }, config({ enabled: false }));
    expect(off.cleared).toEqual(['ram']);
    expect(off.active).toEqual([]);
    expect(off.state.devices).toEqual({});
  });

  it('starts a fresh sustain window after re-enabling', () => {
    const cfg = config();
    let state = evaluate(emptyWatchState(), { at: 0, devices: [ram(95)], modelsResident: 1 }, cfg).state;
    state = evaluate(state, { at: 10_000, devices: [ram(95)], modelsResident: 1 }, config({ enabled: false })).state;
    const back = evaluate(state, { at: 40_000, devices: [ram(95)], modelsResident: 1 }, cfg);
    expect(back.raised).toEqual([]);
  });

  it('restarts a pending window when the threshold is edited', () => {
    let state = evaluate(emptyWatchState(), { at: 0, devices: [ram(95)], modelsResident: 1 }, config()).state;
    const edited = evaluate(state, { at: 30_000, devices: [ram(95)], modelsResident: 1 }, config({ ramThresholdPct: 85 }));
    expect(edited.raised).toEqual([]);
    expect(edited.state.devices.ram.since).toBe(30_000);
  });

  it('stays silent when no models are resident', () => {
    const { last } = run([
      { at: 0, devices: [ram(99)], modelsResident: 0 },
      { at: 30_000, devices: [ram(99)], modelsResident: 0 },
    ]);
    expect(last.raised).toEqual([]);
  });

  it('clears an existing alert once the last model unloads', () => {
    const { state } = run([
      { at: 0, devices: [ram(95)] },
      { at: 30_000, devices: [ram(95)] },
    ]);
    const idle = evaluate(state, { at: 60_000, devices: [ram(95)], modelsResident: 0 }, config());
    expect(idle.cleared).toEqual(['ram']);
  });

  it('can watch regardless of residency when asked to', () => {
    const { last } = run([
      { at: 0, devices: [ram(99)], modelsResident: 0 },
      { at: 30_000, devices: [ram(99)], modelsResident: 0 },
    ], config({ requireResidentModels: false }));
    expect(last.raised).toHaveLength(1);
  });
});

describe('normalizeWatchConfig', () => {
  it('falls back to defaults for missing or nonsense values', () => {
    expect(normalizeWatchConfig(null)).toEqual(DEFAULT_WATCH_CONFIG);
    expect(normalizeWatchConfig({ ramThresholdPct: Number.NaN }).ramThresholdPct)
      .toBe(DEFAULT_WATCH_CONFIG.ramThresholdPct);
    expect(normalizeWatchConfig({ sustainMs: 'soon' as unknown as number }).sustainMs)
      .toBe(DEFAULT_WATCH_CONFIG.sustainMs);
  });

  it('clamps thresholds into a usable range', () => {
    expect(normalizeWatchConfig({ ramThresholdPct: 5 }).ramThresholdPct).toBe(50);
    expect(normalizeWatchConfig({ vramThresholdPct: 400 }).vramThresholdPct).toBe(99);
  });

  it('keeps the clear margin below the threshold so an alert can always clear', () => {
    const cfg = normalizeWatchConfig({ ramThresholdPct: 50, vramThresholdPct: 60, clearMarginPct: 90 });
    expect(cfg.clearMarginPct).toBe(49);
    expect(cfg.ramThresholdPct - cfg.clearMarginPct).toBeGreaterThan(0);
  });

  it('treats enabled as opt-out', () => {
    expect(normalizeWatchConfig({}).enabled).toBe(true);
    expect(normalizeWatchConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe('toWatchSample', () => {
  const status = {
    totalMemMb: 16_000,
    usedMemMb: 8_000,
    models: [{ alias: 'a' }, { alias: 'b' }],
    host: { platform: 'win32', arch: 'x64' },
    accelerators: [
      { kind: 'gpu', name: 'RTX 4080 SUPER', usedMb: 4_000, totalMb: 16_000 },
      { kind: 'npu', name: 'Hexagon', usedMb: null, totalMb: null },
    ],
  };

  it('maps system memory and reports resident model count', () => {
    const sample = toWatchSample(status, 123);
    expect(sample.at).toBe(123);
    expect(sample.modelsResident).toBe(2);
    expect(sample.devices[0]).toMatchObject({ id: 'ram', kind: 'ram', usedMb: 8_000, totalMb: 16_000 });
  });

  it('skips accelerators without their own reported pool', () => {
    expect(toWatchSample(status, 0).devices.map(d => d.id)).toEqual(['ram', 'gpu:RTX 4080 SUPER']);
  });

  it('omits accelerators on unified-memory Macs to avoid counting the same bytes twice', () => {
    const sample = toWatchSample({ ...status, host: { platform: 'darwin', arch: 'arm64' } }, 0);
    expect(sample.devices.map(d => d.id)).toEqual(['ram']);
  });

  it('keeps accelerators on Intel Macs, which have discrete memory', () => {
    const sample = toWatchSample({ ...status, host: { platform: 'darwin', arch: 'x64' } }, 0);
    expect(sample.devices.map(d => d.id)).toEqual(['ram', 'gpu:RTX 4080 SUPER']);
  });

  it('survives an empty or malformed status', () => {
    expect(toWatchSample(null, 0)).toEqual({ at: 0, devices: [], modelsResident: 0 });
    expect(toWatchSample({ totalMemMb: 0, usedMemMb: 0 }, 0).devices).toEqual([]);
  });
});

describe('alert copy', () => {
  it('summarises one device', () => {
    expect(formatAlertSummary([{ id: 'ram', label: 'System memory', kind: 'ram', pct: 91.6, usedMb: 0, totalMb: 0 }]))
      .toBe('System memory 92% used');
  });

  it('joins several devices into one line', () => {
    expect(formatAlertSummary([
      { id: 'ram', label: 'System memory', kind: 'ram', pct: 92, usedMb: 0, totalMb: 0 },
      { id: 'gpu:RTX', label: 'RTX 4080', kind: 'gpu', pct: 96, usedMb: 0, totalMb: 0 },
    ])).toBe('System memory 92% · RTX 4080 96%');
  });

  it('is empty with nothing to report', () => {
    expect(formatAlertSummary([])).toBe('');
  });

  it('never blames Flint for memory it may not be using', () => {
    expect(formatAlertAdvice(0)).not.toMatch(/Flint/);
    expect(formatAlertAdvice(1)).toBe('Flint has 1 model loaded — unloading unused model may free memory.');
    expect(formatAlertAdvice(3)).toBe('Flint has 3 models loaded — unloading unused models may free memory.');
  });
});
