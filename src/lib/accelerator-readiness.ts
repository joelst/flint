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

export type CatalogVariantAccel = {
  id?: string | null;
  deviceType?: string | null;
  executionProvider?: string | null;
};

/** Device builds the catalog actually publishes. Not the accelerators installed on this PC. */
export function publishedAccelerationLabels(
  variants: readonly CatalogVariantAccel[] | null | undefined,
): string[] {
  const found = new Set<'GPU' | 'CPU' | 'NPU'>();
  for (const variant of variants ?? []) {
    const kind = publishedAccelerationKind(variant);
    if (kind) found.add(kind);
  }
  return (['GPU', 'CPU', 'NPU'] as const).filter((label) => found.has(label));
}

function publishedAccelerationKind(
  variant: CatalogVariantAccel,
): 'GPU' | 'CPU' | 'NPU' | null {
  const device = String(variant.deviceType || '').toLowerCase();
  if (device.includes('npu')) return 'NPU';
  if (device.includes('gpu')) return 'GPU';
  if (device.includes('cpu')) return 'CPU';
  const blob = `${variant.executionProvider || ''} ${variant.id || ''}`.toLowerCase();
  if (!blob.trim()) return null;
  if (/qnn|vitis|(?:^|[-_ ])npu(?:$|[-_ :])/.test(blob)) return 'NPU';
  if (/(?:^|[-_ ])gpu(?:$|[-_ :])/.test(blob)) return 'GPU';
  if (/cuda|directml|\bdml\b|webgpu|tensorrt|coreml|metal|rocm/.test(blob)) return 'GPU';
  if (/cpu|generic/.test(blob)) return 'CPU';
  return null;
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
