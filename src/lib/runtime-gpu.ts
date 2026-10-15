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
  const uuids = normalizeRuntimeGpu(appliedSelector)
    .split(',')
    .filter((part) => UUID_SELECTOR.test(part));
  if (uuids.length === 0) return [...all];
  return all.filter((a) => {
    if (a.kind !== 'gpu') return true;
    if (!a.deviceId) return a.vendor !== 'nvidia';
    return uuids.includes(a.deviceId);
  });
}
