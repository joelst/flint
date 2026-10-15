/**
 * Which GPU the runtime child may see. Applied as CUDA_VISIBLE_DEVICES on the sidecar process
 * before the native core initializes, because that core initializes once per process and has no
 * device option. Takes effect the next time the runtime is spawned.
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

/** NVIDIA devices that report a stable identity, in the order the runtime listed them. */
export function runtimeGpuChoices(
  accelerators: ReadonlyArray<{ kind: string; name: string; vendor?: string | null; deviceId?: string | null }> | undefined,
): GpuChoice[] {
  const choices: GpuChoice[] = [];
  for (const a of accelerators ?? []) {
    if (a.kind !== 'gpu' || !a.deviceId || !normalizeRuntimeGpu(a.deviceId).startsWith('GPU-')) continue;
    const repeatedName = (accelerators ?? []).some((other) =>
      other.deviceId !== a.deviceId && other.kind === 'gpu' && other.name === a.name &&
      normalizeRuntimeGpu(other.deviceId).startsWith('GPU-'),
    );
    choices.push({
      deviceId: a.deviceId,
      label: repeatedName ? `${a.name} (${a.deviceId})` : a.name,
    });
  }
  return choices;
}
