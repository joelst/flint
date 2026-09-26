// Decides when memory pressure is worth interrupting the user about.
//
// The hard part is not reading the numbers — the sidecar already reports them — it is not
// crying wolf. Three things make a naive `pct >= threshold` check actively harmful here:
//
//  1. The telemetry is system-wide. `usedMemMb` is `os.totalmem() - os.freemem()`, so a
//     browser or a game moves it just as much as a loaded model does. Warning on it
//     unconditionally would make Flint a general-purpose memory nagger that blames itself
//     for other software. Hence `requireResidentModels`: no models resident, no alert.
//  2. Loading a model is a memory spike by definition. Alerting on a single sample would
//     fire on every load and clear moments later, so pressure must be *sustained*.
//  3. Usage hovers. Without hysteresis a device sitting at the threshold would raise and
//     clear on alternating samples forever.
//
// Sustain is measured in elapsed time rather than a count of samples, because the poll
// cadence deliberately varies (fast while the Monitor tab is open, slow in the background)
// and a sample count would mean a different real duration in each case. Elapsed time alone
// is not enough though: a laptop that sleeps for an hour between two high samples has not
// observed anything continuous, so a gap larger than `maxSampleGapMs` restarts the clock.
//
// Everything here is pure: no timers, no fetches, no Svelte. The caller supplies samples
// and receives the transitions, which is what makes the awkward cases above testable.

export type DeviceKind = 'ram' | 'gpu' | 'npu';

export interface WatchDevice {
  /** Stable across samples; identity, not presentation. */
  id: string;
  label: string;
  kind: DeviceKind;
  usedMb: number;
  totalMb: number;
}

export interface WatchSample {
  /** Wall-clock ms. Samples older than the last accepted one are rejected. */
  at: number;
  devices: WatchDevice[];
  /** Alerts stay silent at 0 unless `requireResidentModels` is off. */
  modelsResident: number;
}

export interface WatchConfig {
  enabled: boolean;
  ramThresholdPct: number;
  /** Separate from RAM: a GPU legitimately runs far closer to full during inference. */
  vramThresholdPct: number;
  sustainMs: number;
  /** How far usage must fall below the threshold before the alert clears. */
  clearMarginPct: number;
  maxSampleGapMs: number;
  requireResidentModels: boolean;
}

export interface DeviceState {
  /** When usage first went above the threshold in the current run, or null. */
  since: number | null;
  alerting: boolean;
  dismissed: boolean;
  pct: number;
  usedMb: number;
  totalMb: number;
  label: string;
  kind: DeviceKind;
  /** Consecutive accepted samples in which this device did not appear. */
  missing: number;
}

export interface WatchState {
  at: number | null;
  devices: Record<string, DeviceState>;
  /** Detects threshold edits between samples, which restart any pending sustain. */
  signature: string;
}

export interface WatchAlert {
  id: string;
  label: string;
  kind: DeviceKind;
  pct: number;
  usedMb: number;
  totalMb: number;
}

export interface WatchResult {
  state: WatchState;
  /** Devices that crossed into alerting on this sample. */
  raised: WatchAlert[];
  /** Ids that stopped alerting, whether by recovering or by disappearing. */
  cleared: string[];
  /** Everything currently alerting and not dismissed — what the banner renders. */
  active: WatchAlert[];
}

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  enabled: true,
  ramThresholdPct: 90,
  vramThresholdPct: 95,
  sustainMs: 30_000,
  clearMarginPct: 8,
  maxSampleGapMs: 120_000,
  requireResidentModels: true,
};

export function emptyWatchState (): WatchState {
  return { at: null, devices: {}, signature: '' };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Keeps a hand-edited or corrupted persisted config from producing impossible rules. */
export function normalizeWatchConfig (input: Partial<WatchConfig> | null | undefined): WatchConfig {
  const d = DEFAULT_WATCH_CONFIG;
  const src = input ?? {};
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const ramThresholdPct = clamp(Math.round(num(src.ramThresholdPct, d.ramThresholdPct)), 50, 99);
  const vramThresholdPct = clamp(Math.round(num(src.vramThresholdPct, d.vramThresholdPct)), 50, 99);
  // A margin at or above the threshold would put the clear point at/below zero, so an
  // alert could never clear. Bound it by the smaller threshold.
  const maxMargin = Math.max(1, Math.min(ramThresholdPct, vramThresholdPct) - 1);

  return {
    enabled: src.enabled !== false,
    ramThresholdPct,
    vramThresholdPct,
    sustainMs: clamp(num(src.sustainMs, d.sustainMs), 0, 3_600_000),
    clearMarginPct: clamp(Math.round(num(src.clearMarginPct, d.clearMarginPct)), 1, maxMargin),
    maxSampleGapMs: clamp(num(src.maxSampleGapMs, d.maxSampleGapMs), 1_000, 3_600_000),
    requireResidentModels: src.requireResidentModels !== false,
  };
}

function signatureOf (c: WatchConfig): string {
  return `${c.ramThresholdPct}/${c.vramThresholdPct}/${c.sustainMs}/${c.clearMarginPct}`;
}

function thresholdFor (kind: DeviceKind, c: WatchConfig): number {
  return kind === 'ram' ? c.ramThresholdPct : c.vramThresholdPct;
}

/**
 * A device is only usable if both numbers are real and self-consistent. Discovery backends
 * (nvidia-smi, a DXGI PowerShell probe, sysfs) can each return nulls or nonsense, and
 * inventing a percentage from them would produce an alert about a device that may not even
 * have a separate memory pool.
 */
function usablePct (d: WatchDevice): number | null {
  if (!Number.isFinite(d.usedMb) || !Number.isFinite(d.totalMb)) return null;
  if (d.totalMb <= 0 || d.usedMb < 0) return null;
  // Tolerate small overshoot (reporting races) but reject clearly bogus values.
  if (d.usedMb > d.totalMb * 1.5) return null;
  return clamp((d.usedMb / d.totalMb) * 100, 0, 100);
}

/** Absent for this many accepted samples before its state is dropped, so one failed probe does not flap. */
const MISSING_GRACE = 2;

export function evaluate (prev: WatchState, sample: WatchSample, config: WatchConfig): WatchResult {
  const alertsFrom = (state: WatchState): WatchAlert[] => Object.entries(state.devices)
    .filter(([, s]) => s.alerting && !s.dismissed)
    .map(([id, s]) => ({ id, label: s.label, kind: s.kind, pct: s.pct, usedMb: s.usedMb, totalMb: s.totalMb }));

  const previouslyAlerting = Object.entries(prev.devices)
    .filter(([, s]) => s.alerting)
    .map(([id]) => id);

  // Disabled is a hard stop, not a pause: drop the accumulated state so re-enabling starts
  // from a clean sustain window rather than firing on stale history.
  if (!config.enabled) {
    return { state: emptyWatchState(), raised: [], cleared: previouslyAlerting, active: [] };
  }

  if (!Number.isFinite(sample.at)) {
    return { state: prev, raised: [], cleared: [], active: alertsFrom(prev) };
  }
  // Out-of-order arrivals (overlapping polls) would corrupt every elapsed-time comparison.
  if (prev.at !== null && sample.at <= prev.at) {
    return { state: prev, raised: [], cleared: [], active: alertsFrom(prev) };
  }

  if (config.requireResidentModels && sample.modelsResident <= 0) {
    return {
      state: { at: sample.at, devices: {}, signature: signatureOf(config) },
      raised: [],
      cleared: previouslyAlerting,
      active: [],
    };
  }

  const signature = signatureOf(config);
  // A gap means we stopped observing (sleep, throttled timer, failed polls) and a threshold
  // edit changes what "above" means. Neither can count toward a sustain window.
  const discontinuous = prev.at === null
    || (sample.at - prev.at) > config.maxSampleGapMs
    || signature !== prev.signature;

  const devices: Record<string, DeviceState> = {};
  const raised: WatchAlert[] = [];
  const cleared: string[] = [];
  const active: WatchAlert[] = [];
  const seen = new Set<string>();

  for (const device of sample.devices) {
    const pct = usablePct(device);
    if (pct === null || seen.has(device.id)) continue;
    seen.add(device.id);

    const before = prev.devices[device.id];
    const threshold = thresholdFor(device.kind, config);
    const clearAt = Math.max(0, threshold - config.clearMarginPct);

    let since = discontinuous ? null : (before?.since ?? null);
    let alerting = before?.alerting ?? false;
    let dismissed = before?.dismissed ?? false;

    if (alerting) {
      if (pct < clearAt) {
        alerting = false;
        // Recovery re-arms the alert: the next crossing is genuinely new information, so a
        // prior dismissal must not silence it.
        dismissed = false;
        since = null;
        cleared.push(device.id);
      }
    } else if (pct >= threshold) {
      if (since === null) since = sample.at;
      if (sample.at - since >= config.sustainMs) {
        alerting = true;
        dismissed = false;
        raised.push({ id: device.id, label: device.label, kind: device.kind, pct, usedMb: device.usedMb, totalMb: device.totalMb });
      }
    } else {
      since = null;
    }

    devices[device.id] = {
      since, alerting, dismissed, pct,
      usedMb: device.usedMb, totalMb: device.totalMb,
      label: device.label, kind: device.kind, missing: 0,
    };
    if (alerting && !dismissed) {
      active.push({ id: device.id, label: device.label, kind: device.kind, pct, usedMb: device.usedMb, totalMb: device.totalMb });
    }
  }

  // Carry devices that did not appear this time, briefly. A device that stays gone is gone:
  // holding its alert open would leave a banner about hardware we can no longer observe.
  for (const [id, before] of Object.entries(prev.devices)) {
    if (seen.has(id)) continue;
    const missing = before.missing + 1;
    if (missing > MISSING_GRACE) {
      if (before.alerting) cleared.push(id);
      continue;
    }
    devices[id] = { ...before, missing };
    if (before.alerting && !before.dismissed) {
      active.push({ id, label: before.label, kind: before.kind, pct: before.pct, usedMb: before.usedMb, totalMb: before.totalMb });
    }
  }

  return { state: { at: sample.at, devices, signature }, raised, cleared, active };
}

export interface PoolStatusLike {
  usedMemMb?: number | null;
  totalMemMb?: number | null;
  models?: unknown[] | null;
  host?: { platform?: string; arch?: string } | null;
  accelerators?: Array<{
    kind?: string;
    name?: string;
    vendor?: string;
    usedMb?: number | null;
    totalMb?: number | null;
  }> | null;
}

/**
 * Turns a `poolStatus` reply into a sample.
 *
 * Device ids must be stable across samples but discovery gives us no unique key, only a
 * display name — and a machine can hold two identical cards. Names are therefore made
 * unique by occurrence, so the second "RTX 4080 SUPER" keeps its own state instead of
 * overwriting the first one's.
 */
export function toWatchSample (status: PoolStatusLike | null | undefined, at: number): WatchSample {
  const devices: WatchDevice[] = [];
  const used = new Map<string, number>();
  const uniqueId = (base: string) => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}#${n + 1}`;
  };

  const totalMemMb = Number(status?.totalMemMb);
  const usedMemMb = Number(status?.usedMemMb);
  if (Number.isFinite(totalMemMb) && Number.isFinite(usedMemMb) && totalMemMb > 0) {
    devices.push({ id: 'ram', label: 'System memory', kind: 'ram', usedMb: usedMemMb, totalMb: totalMemMb });
  }

  // Apple Silicon GPUs and NPUs draw on the same pool as `totalMemMb`. Listing them as
  // separate devices would count the same bytes twice and raise two alerts for one problem.
  const unified = status?.host?.platform === 'darwin' && status?.host?.arch === 'arm64';

  if (!unified) {
    for (const accel of status?.accelerators ?? []) {
      const kind: DeviceKind = accel?.kind === 'npu' ? 'npu' : 'gpu';
      const name = String(accel?.name || '').trim() || (kind === 'npu' ? 'NPU' : 'GPU');
      const usedMb = Number(accel?.usedMb);
      const totalMb = Number(accel?.totalMb);
      // Devices without their own reported pool are skipped rather than guessed at.
      if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0) continue;
      devices.push({ id: uniqueId(`${kind}:${name}`), label: name, kind, usedMb, totalMb });
    }
  }

  return { at, devices, modelsResident: Array.isArray(status?.models) ? status.models.length : 0 };
}

/** Silences one device until it recovers below the clear point and crosses again. */
export function dismissDevice (state: WatchState, id: string): WatchState {
  const device = state.devices[id];
  if (!device || !device.alerting || device.dismissed) return state;
  return { ...state, devices: { ...state.devices, [id]: { ...device, dismissed: true } } };
}

export function dismissAll (state: WatchState): WatchState {
  let next = state;
  for (const id of Object.keys(state.devices)) next = dismissDevice(next, id);
  return next;
}

/**
 * One line covering every alerting device. Multiple devices routinely cross together (a
 * model load pushes RAM and VRAM at once) and a banner per device would bury the point.
 */
export function formatAlertSummary (alerts: WatchAlert[]): string {
  if (alerts.length === 0) return '';
  const part = (a: WatchAlert) => `${a.label} ${Math.round(a.pct)}%`;
  if (alerts.length === 1) return `${part(alerts[0])} used`;
  return alerts.map(part).join(' · ');
}

/**
 * Deliberately non-attributive. The reading is system-wide, so claiming Flint caused it
 * would often be false; naming the resident models instead gives the user something true
 * and something they can act on.
 */
export function formatAlertAdvice (modelsResident: number): string {
  if (modelsResident <= 0) return 'Close other applications to free memory.';
  const noun = modelsResident === 1 ? 'model' : 'models';
  return `Flint has ${modelsResident} ${noun} loaded — unloading unused ${noun} may free memory.`;
}
