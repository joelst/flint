/** Unknown telemetry preserves last-known residency; explicit native eviction does not. */
export function isPoolEntryResident(entry: { isLoaded?: boolean | null }): boolean {
  return entry.isLoaded !== false;
}

interface PoolIdentity {
  alias: string;
  variantId: string;
  isLoaded?: boolean | null;
}

export function retainKnownResidency<T extends PoolIdentity>(
  pool: readonly T[],
  previous: readonly PoolIdentity[],
): T[] {
  return pool.map((entry) => {
    if (entry.isLoaded != null) return entry;
    const prior = previous.find((known) =>
      known.alias === entry.alias && known.variantId === entry.variantId
    );
    return { ...entry, isLoaded: prior?.isLoaded ?? null };
  });
}
