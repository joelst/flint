/**
 * Tracks the most recently started call in a slot so a later caller can join it -- i.e. wait for
 * it to settle (success or failure, which the joiner does not care about) before proceeding.
 *
 * Extracted from `+page.svelte` (`@ts-nocheck`, no regression coverage) because it closes a real
 * race: `+page.svelte` uses this to make sure a new benchmark run's `setBenchmarkExclusive(true)`
 * acquire never overlaps a still-in-flight `setBenchmarkExclusive(false)` release from the
 * previous run (see the "Prevent stale release from reopening gateway after a newer acquire"
 * review finding). Without joining, a release that is still awaiting a sidecar respawn/re-init
 * can lose an ordering race against a newer acquire dispatched moments later and reopen gateway
 * admission mid-benchmark, even though the release call was issued first.
 */

export interface PendingCallTracker {
  /** Registers `call` as the currently tracked in-flight call. A later call to `track` replaces
   * it; the earlier call's own settlement then no longer clears the slot (see `join`'s doc). */
  track(call: Promise<unknown>): void;
  /** Resolves once the most recently tracked call (if any) has settled. Resolves immediately if
   * nothing is currently tracked. The tracked call's own outcome (success or failure) is not
   * surfaced -- only that it is no longer in flight matters to a joiner deciding whether it is
   * safe to start something that must not overlap it. */
  join(): Promise<void>;
}

/** Creates a tracker with an empty slot. */
export function createPendingCallTracker(): PendingCallTracker {
  let pending: Promise<void> | null = null;
  return {
    track(call: Promise<unknown>): void {
      const marker: Promise<void> = call.then(
        () => undefined,
        () => undefined,
      );
      pending = marker;
      // Only clears the slot if nothing newer has since replaced this exact marker -- otherwise
      // an earlier call settling after a later one started would incorrectly clear the newer
      // call's own tracking out from under it.
      void marker.finally(() => {
        if (pending === marker) pending = null;
      });
    },
    async join(): Promise<void> {
      await pending;
    },
  };
}
