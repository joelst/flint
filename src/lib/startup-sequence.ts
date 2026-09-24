import type { EpDownloadResult } from './ipc-contracts';

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

export function resolveStartupAudioAlias(
  autoStartService: boolean,
  defaultAudioAlias: string,
  initialAudioAlias: string,
  lastUsedAudioAlias: string,
  availableAudioAliases: readonly string[],
): string {
  if (!autoStartService) return lastUsedAudioAlias;
  if (lastUsedAudioAlias !== initialAudioAlias) return lastUsedAudioAlias;
  if (!defaultAudioAlias || !availableAudioAliases.includes(defaultAudioAlias)) {
    return lastUsedAudioAlias;
  }
  return defaultAudioAlias;
}

export type CatalogCheckPresentation =
  | 'checked'
  | 'disabled'
  | 'loading'
  | 'failed'
  | 'pending';

export function resolveCatalogCheckPresentation(options: {
  automaticCheckEnabled: boolean;
  status: 'not-checked' | 'loading' | 'ready' | 'failed';
}): CatalogCheckPresentation {
  if (options.status === 'loading') return 'loading';
  if (options.status === 'failed') return 'failed';
  if (options.status === 'ready') return 'checked';
  if (!options.automaticCheckEnabled) return 'disabled';
  return 'pending';
}

export function resolveAcceleratorRestartGuidance(
  registration: EpDownloadResult | null | undefined,
): string {
  if (!registration) return '';
  if (registration.registrationDeferredUntilRestart) {
    return registration.status || 'Restart Flint before updating accelerators.';
  }
  if (!registration.catalogRefreshRequiresRestart) return '';
  if (registration.success === false) {
    const status = (registration.status || 'Some accelerators could not be registered').trim();
    const punctuation = /[.!?]$/.test(status) ? '' : '.';
    return `${status}${punctuation} Restart Flint to let the model catalog detect any newly available variants.`;
  }
  return 'Accelerator setup finished. Restart Flint to let the model catalog detect any newly available variants.';
}
