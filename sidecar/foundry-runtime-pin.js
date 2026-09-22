/**
 * Flint's tested Foundry SDK/core pair. Warn when a running process loaded
 * something else; do not fail startup — Foundry's REST API is preview and a
 * mismatch is an operability signal, not a hard incompatibility.
 */

export const PINNED_FOUNDRY_SDK_VERSION = '2.0.1';
export const PINNED_FOUNDRY_CORE_VERSION = '2.0.1';

/**
 * @param {{ sdkVersion?: string | null, coreVersion?: string | null }} versions
 * @returns {string | null}
 */
export function foundryRuntimePinWarning({ sdkVersion = null, coreVersion = null } = {}) {
  const parts = [];
  if (sdkVersion && sdkVersion !== PINNED_FOUNDRY_SDK_VERSION) {
    parts.push(`SDK ${sdkVersion} (Flint is tested on ${PINNED_FOUNDRY_SDK_VERSION})`);
  }
  if (coreVersion && coreVersion !== PINNED_FOUNDRY_CORE_VERSION) {
    parts.push(`native core ${coreVersion} (Flint is tested on ${PINNED_FOUNDRY_CORE_VERSION})`);
  }
  if (parts.length === 0) return null;
  return (
    `Untested Foundry combination: ${parts.join('; ')}. ` +
    'Flint will continue; catalog, gateway, or BYOM behavior may differ.'
  );
}
