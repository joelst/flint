import type {
  EpDownloadResult,
  EpInfo,
} from './ipc-contracts';

export interface AcceleratorReadiness {
  generation: number;
  registration: EpDownloadResult | null;
  providers: EpInfo[];
}

export interface PreloadModel {
  alias: string;
  variants?: Array<{
    id: string;
    executionProvider?: string | null;
  }>;
}

export interface PreloadCompatibility {
  allowed: boolean;
  requiredProvider: string | null;
  reason: string | null;
}

function normalizeProviderName(value: string | null | undefined): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/executionprovider$/i, '')
    .replace(/[^a-z0-9]/g, '');

  if (normalized === 'directml') return 'dml';
  if (normalized === 'generic') return 'cpu';
  return normalized;
}

export function hasRegisteredAccelerator(providers: EpInfo[]): boolean {
  return providers.some(
    (provider) =>
      provider.isRegistered && normalizeProviderName(provider.name) !== 'cpu',
  );
}

function registeredProviderNames(readiness: AcceleratorReadiness): Set<string> {
  const names = [
    ...readiness.providers
      .filter((provider) => provider.isRegistered)
      .map((provider) => provider.name),
    ...(readiness.registration?.registeredEps ?? []),
  ];
  return new Set(names.map(normalizeProviderName).filter(Boolean));
}

/**
 * Only an explicit variant has a provider requirement Flint can verify before loading.
 * Alias-only loads remain runtime-resolved, and unknown metadata is left for the load to report.
 */
export function evaluateStartupPreload(
  model: PreloadModel,
  variantId: string | null | undefined,
  readiness: AcceleratorReadiness,
): PreloadCompatibility {
  if (!variantId) {
    return { allowed: true, requiredProvider: null, reason: null };
  }

  const variant = model.variants?.find((candidate) => candidate.id === variantId);
  const providerLabel = variant?.executionProvider?.trim() || null;
  if (!providerLabel) {
    return { allowed: true, requiredProvider: null, reason: null };
  }

  const requiredProvider = normalizeProviderName(providerLabel);
  if (!requiredProvider || requiredProvider === 'cpu') {
    return { allowed: true, requiredProvider: providerLabel, reason: null };
  }

  if (registeredProviderNames(readiness).has(requiredProvider)) {
    return { allowed: true, requiredProvider: providerLabel, reason: null };
  }

  return {
    allowed: false,
    requiredProvider: providerLabel,
    reason: `${model.alias} requires ${providerLabel}, which is not registered`,
  };
}
