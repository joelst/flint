export interface HydratedStartupStages {
  applyMemorySettings(): Promise<void>;
  prepareAccelerators(): Promise<void>;
  startService?: () => Promise<void>;
}

/**
 * Apply hydrated runtime intent before anything can load a model.
 *
 * A failed prerequisite stops the sequence; callers keep the already-hydrated local UI usable
 * and surface the stage error instead of starting with a partially applied configuration.
 */
export async function prepareHydratedRuntime(stages: HydratedStartupStages): Promise<void> {
  await stages.applyMemorySettings();
  await stages.prepareAccelerators();
  await stages.startService?.();
}

export function createSingleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () => {
    if (current) return current;
    current = run().finally(() => {
      current = null;
    });
    return current;
  };
}

export function createStartupAuthorization() {
  let epoch = 0;
  return {
    capture: () => epoch,
    isCurrent: (captured: number) => captured === epoch,
    invalidate: () => { epoch += 1; },
  };
}
