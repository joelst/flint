/** Unknown telemetry preserves last-known residency; explicit native eviction does not. */
export function isPoolEntryResident(entry: { isLoaded?: boolean | null }): boolean {
  return entry.isLoaded !== false;
}
