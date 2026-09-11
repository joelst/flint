/**
 * Pure cache-inventory classification.
 *
 * Filesystem traversal stays in the sidecar; this module only turns discovered entries into
 * stable, read-only inventory facts and recommendations. No recommendation authorizes deletion.
 */

/**
 * @typedef {{
 *   path: string,
 *   alias: string|null,
 *   variantId: string|null,
 *   sizeBytes: number,
 *   partial: boolean,
 *   linked: boolean,
 *   owned: boolean
 * }} CacheEntry
 */

/**
 * @param {CacheEntry[]} entries
 */
export function summarizeCacheInventory(entries) {
  const safeEntries = Array.isArray(entries) ? entries.filter(entry => entry && typeof entry.path === 'string') : [];
  const byAlias = new Map();

  for (const entry of safeEntries) {
    if (!entry.alias) continue;
    const group = byAlias.get(entry.alias) || [];
    group.push(entry);
    byAlias.set(entry.alias, group);
  }

  const duplicateGroups = [...byAlias.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([alias, group]) => ({
      alias,
      entries: group.map(entry => entry.path),
      bytes: group.reduce((total, entry) => total + nonNegativeBytes(entry.sizeBytes), 0)
        - Math.max(...group.map(entry => nonNegativeBytes(entry.sizeBytes))),
      recommendation: 'Review duplicate cached variants; do not delete automatically.',
    }));

  const partialEntries = safeEntries.filter(entry => entry.partial);
  const totalBytes = safeEntries.reduce((total, entry) => total + nonNegativeBytes(entry.sizeBytes), 0);
  const partialBytes = partialEntries.reduce((total, entry) => total + nonNegativeBytes(entry.sizeBytes), 0);

  return {
    entries: safeEntries,
    totalBytes,
    partialBytes,
    duplicateBytes: duplicateGroups.reduce((total, group) => total + group.bytes, 0),
    duplicateGroups,
    partialEntries: partialEntries.map(entry => ({
      path: entry.path,
      bytes: nonNegativeBytes(entry.sizeBytes),
      recommendation: 'Review interrupted download; do not delete automatically.',
    })),
    scannedAt: Date.now(),
  };
}

function nonNegativeBytes(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
