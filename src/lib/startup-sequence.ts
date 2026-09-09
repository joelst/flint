export interface HydratedStartupStages<TAccelerators = void> {
  applyMemorySettings(): Promise<void>;
  prepareAccelerators(): Promise<TAccelerators>;
  validateAccelerators?: (accelerators: TAccelerators) => void;
  startService?: (accelerators: TAccelerators) => Promise<void>;
}

/**
 * Apply hydrated runtime intent before anything can load a model.
 *
 * A failed prerequisite stops the sequence; callers keep the already-hydrated local UI usable
 * and surface the stage error instead of starting with a partially applied configuration.
 */
export async function prepareHydratedRuntime<TAccelerators>(
  stages: HydratedStartupStages<TAccelerators>,
): Promise<TAccelerators> {
  await stages.applyMemorySettings();
  const accelerators = await stages.prepareAccelerators();
  stages.validateAccelerators?.(accelerators);
  await stages.startService?.(accelerators);
  return accelerators;
}

export function createSingleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () => {
    if (current) return current;
    current = Promise.resolve().then(run).finally(() => {
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
