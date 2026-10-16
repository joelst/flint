/**
 * Which NVIDIA GPU CUDA may use. Applied as CUDA_VISIBLE_DEVICES on the sidecar process
 * before the native core initializes, because that core initializes once per process and has no
 * device option. Takes effect the next time the runtime is spawned. This restricts CUDA only:
 * DirectML, WebGPU and other providers enumerate adapters themselves and may use any GPU.
 *
 * Stored as an NVIDIA GPU UUID (`GPU-…`), which survives a reordering of device indexes. A bare
 * index list is accepted for hand-edited values. The Rust spawn path validates the same shape.
 */
export const RUNTIME_GPU_KEY = 'flint-runtime-gpu';

const UUID_SELECTOR = /^GPU-[0-9A-Fa-f-]{8,64}$/;
const INDEX_SELECTOR = /^\d{1,2}(,\d{1,2}){0,15}$/;

/** Returns a safe selector, or '' (automatic) for anything else. */
export function normalizeRuntimeGpu(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (UUID_SELECTOR.test(value) || INDEX_SELECTOR.test(value)) return value;
  return '';
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readRuntimeGpu(storage: StorageLike | null | undefined): string {
  try {
    return normalizeRuntimeGpu(storage?.getItem(RUNTIME_GPU_KEY));
  } catch {
    return '';
  }
}

/** Returns false when the choice could not be saved, so the caller can say so. */
export function writeRuntimeGpu(storage: StorageLike | null | undefined, value: string): boolean {
  if (!storage) return false;
  try {
    const next = normalizeRuntimeGpu(value);
    if (next) storage.setItem(RUNTIME_GPU_KEY, next);
    else storage.removeItem(RUNTIME_GPU_KEY);
    return true;
  } catch {
    return false;
  }
}

export interface GpuChoice {
  deviceId: string;
  label: string;
}

interface GpuLike {
  kind: string;
  name: string;
  vendor?: string | null;
  deviceId?: string | null;
}

/**
 * NVIDIA devices that report a stable identity, in the order the runtime listed them. When two
 * cards share a name, the UUID is appended so the user can tell them apart.
 */
export function runtimeGpuChoices(accelerators: ReadonlyArray<GpuLike> | undefined): GpuChoice[] {
  const found = (accelerators ?? []).filter(
    (a) => a.kind === 'gpu' && !!a.deviceId && UUID_SELECTOR.test(a.deviceId),
  );
  const counts = new Map<string, number>();
  for (const a of found) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  return found.map((a) => ({
    deviceId: a.deviceId as string,
    label: (counts.get(a.name) ?? 0) > 1 ? `${a.name} (${a.deviceId})` : a.name,
  }));
}

/** Stay visible while there is something to say: a launch-time choice, a pending change, or a failed save. */
export function runtimeGpuPanelVisible(state: {
  choiceCount: number;
  current: string;
  appliedAtLaunch: string;
  saveFailed: boolean;
}): boolean {
  return state.choiceCount > 1 || !!state.current || !!state.appliedAtLaunch || state.saveFailed;
}

export function runtimeGpuRestartRequired(
  current: string,
  applied: string,
  appliedSource: 'configured' | 'inherited' | 'unrestricted' | null,
): boolean {
  if (appliedSource === 'inherited' && current === '') return false;
  return current !== applied;
}

export interface VramView {
  count: number;
  maxFreeMb: number;
  freeMb: number;
  totalMb: number;
  telemetryKnown: boolean;
}

export interface VramAdmissionFailure {
  view: 'cuda' | 'all';
  provider: 'cuda' | 'other' | 'combined';
  needMb: number;
  budgetMb: number;
}

/** Free VRAM and headroom for one view; zero free memory is still known telemetry. */
export function vramBudgetOf(v: VramView): { free: number; budget: number; known: boolean } {
  const free = v.maxFreeMb > 0 ? v.maxFreeMb : v.freeMb;
  const headroom = Math.min(512, Math.round((v.totalMb || free) * 0.08) || 256);
  return { free, budget: Math.max(0, free - headroom), known: v.count > 0 && v.telemetryKnown };
}

/**
 * Admission for pending GPU slots, split by provider class. CUDA slots are checked against the
 * CUDA-visible view and other providers against the full inventory. A class without telemetry is
 * not checked (it warns via `unknown`) instead of counting as zero capacity, and the combined
 * check runs only when every needed class is known.
 */
export function planVramAdmission(
  cudaNeedsMb: ReadonlyArray<number>,
  otherNeedsMb: ReadonlyArray<number>,
  cudaView: VramView,
  allView: VramView,
): {
  okAll: boolean;
  okOne: boolean;
  unknown: boolean;
  displayView: 'cuda' | 'all';
  allFailures: VramAdmissionFailure[];
  oneFailures: VramAdmissionFailure[];
} {
  const sum = (l: ReadonlyArray<number>) => l.reduce((a, b) => a + b, 0);
  const max = (l: ReadonlyArray<number>) => l.reduce((a, b) => Math.max(a, b), 0);
  const hasCuda = cudaNeedsMb.length > 0;
  const hasOther = otherNeedsMb.length > 0;
  const cuda = vramBudgetOf(cudaView);
  const all = vramBudgetOf(allView);
  const cudaKnown = !hasCuda || cuda.known;
  const otherKnown = !hasOther || all.known;
  const allFailures: VramAdmissionFailure[] = [];
  const oneFailures: VramAdmissionFailure[] = [];
  if (hasCuda && cuda.known) {
    const needAll = sum(cudaNeedsMb);
    const needOne = max(cudaNeedsMb);
    if (needAll > cuda.budget) {
      allFailures.push({ view: 'cuda', provider: 'cuda', needMb: needAll, budgetMb: cuda.budget });
    }
    if (needOne > cuda.budget) {
      oneFailures.push({ view: 'cuda', provider: 'cuda', needMb: needOne, budgetMb: cuda.budget });
    }
  }
  if (hasOther && all.known) {
    const needAll = sum(otherNeedsMb);
    const needOne = max(otherNeedsMb);
    if (needAll > all.budget) {
      allFailures.push({ view: 'all', provider: 'other', needMb: needAll, budgetMb: all.budget });
    }
    if (needOne > all.budget) {
      oneFailures.push({ view: 'all', provider: 'other', needMb: needOne, budgetMb: all.budget });
    }
  }
  if (hasCuda && hasOther && cudaKnown && otherKnown) {
    const needAll = sum(cudaNeedsMb) + sum(otherNeedsMb);
    if (needAll > all.budget) {
      allFailures.push({ view: 'all', provider: 'combined', needMb: needAll, budgetMb: all.budget });
    }
  }
  return {
    okAll: allFailures.length === 0,
    okOne: oneFailures.length === 0,
    unknown: !cudaKnown || !otherKnown,
    displayView: hasCuda && !hasOther ? 'cuda' : 'all',
    allFailures,
    oneFailures,
  };
}

/**
 * Whether a variant runs on the CUDA execution provider, from its provider name or variant id
 * (`…-cuda-gpu:4`). Unknown means unknown: callers should not apply a CUDA restriction to it.
 */
export function isCudaVariant(executionProvider: string | null | undefined, variantId: string | null | undefined): boolean {
  const ep = String(executionProvider ?? '').toLowerCase();
  if (ep) return ep.includes('cuda');
  return /(^|[-_])cuda([-_]|$)/i.test(String(variantId ?? ''));
}

/**
 * GPUs a CUDA load can use under the selector the running child was spawned with. Non-NVIDIA
 * adapters are kept. An index selector cannot be mapped to nvidia-smi rows reliably, so it
 * leaves the list unfiltered rather than guessing.
 */
export function cudaVisibleAccelerators<T extends GpuLike>(
  accelerators: ReadonlyArray<T> | undefined,
  appliedSelector: string,
): T[] {
  const all = accelerators ?? [];
  const parts = appliedSelector.split(',').map((part) => part.trim());
  const uuids = parts.length > 1 && parts.every((part) => UUID_SELECTOR.test(part))
    ? parts
    : normalizeRuntimeGpu(appliedSelector)
        .split(',')
        .filter((part) => UUID_SELECTOR.test(part));
  if (uuids.length === 0) return [...all];
  const visible = new Set(uuids.map((uuid) => uuid.toLowerCase()));
  return all.filter((a) => {
    if (a.kind !== 'gpu') return true;
    if (!a.deviceId) return a.vendor !== 'nvidia';
    return visible.has(a.deviceId.toLowerCase());
  });
}
