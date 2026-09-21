/**
 * Tracks every currently in-flight call registered via `track`, so a later caller can join --
 * i.e. wait for all of them to settle (success or failure, which the joiner does not care about)
 * -- before proceeding.
 *
 * Extracted from `+page.svelte` (`@ts-nocheck`, no regression coverage) because it closes a real
 * race: `+page.svelte` uses this to make sure a new benchmark run's `setBenchmarkExclusive(true)`
 * acquire never overlaps a still-in-flight `setBenchmarkExclusive(false)` release from the
 * previous run (see the "Prevent stale release from reopening gateway after a newer acquire"
 * review finding). Without joining, a release that is still awaiting a sidecar respawn/re-init
 * can lose an ordering race against a newer acquire dispatched moments later and reopen gateway
 * admission mid-benchmark, even though the release call was issued first.
 *
 * Every currently-outstanding tracked call is waited on, not only the most recently tracked one:
 * `joinWithTimeout` lets a caller give up on a call that has not yet settled, and that call can
 * still be running when the caller starts (and tracks) a *replacement* attempt of its own -- if a
 * newer `track()` discarded the still-pending older call's tracking, a later joiner could return
 * before that older call actually lands, reopening exactly the race this tracker exists to close.
 */

export interface PendingCallTracker {
  /** Registers `call` as an in-flight call. Multiple calls can be tracked concurrently; each is
   * removed automatically once it settles (see `join`'s doc for why an older still-pending call
   * is never discarded just because a newer one was also tracked). */
  track(call: Promise<unknown>): void;
  /** Resolves once every call tracked at the time this is invoked has settled. Resolves
   * immediately if nothing is currently tracked. A tracked call's own outcome (success or
   * failure) is not surfaced -- only that it is no longer in flight matters to a joiner deciding
   * whether it is safe to start something that must not overlap it. */
  join(): Promise<void>;
  /**
   * Same as `join()`, but gives up after `timeoutMs` and returns `false` instead of waiting
   * forever, returning `true` once every call tracked at invocation time has settled within that
   * budget.
   *
   * For a tracked call whose underlying command has no IPC deadline of its own (by design --
   * timing out after dispatch would not stop the native work, see `applyMemorySettings`), an
   * unbounded `join()` can wait forever if that command's reply never arrives. A caller that has
   * already reserved something exclusive (e.g. gateway admission) before reaching this join has
   * no other way to recover from that: it cannot proceed (the overlap this exists to prevent is
   * still possible) and, unbounded, would never reach its own cleanup path either. `false` tells
   * that caller to give up and run its own cleanup instead of hanging alongside the stuck call --
   * the call itself, however, remains tracked (see the class docstring) so a *later* joiner still
   * waits for it.
   */
  joinWithTimeout(timeoutMs: number): Promise<boolean>;
}

/** Creates a tracker with no in-flight calls. */
export function createPendingCallTracker(): PendingCallTracker {
  const pending = new Set<Promise<void>>();
  return {
    track(call: Promise<unknown>): void {
      const marker: Promise<void> = call.then(
        () => undefined,
        () => undefined,
      );
      pending.add(marker);
      void marker.finally(() => {
        pending.delete(marker);
      });
    },
    async join(): Promise<void> {
      // `Promise.all` snapshots the iterable synchronously, so calls tracked *after* this point
      // are not waited on by this particular join -- only later joins see them.
      await Promise.all(pending);
    },
    async joinWithTimeout(timeoutMs: number): Promise<boolean> {
      if (pending.size === 0) return true;
      const snapshot = Promise.all(pending);
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([
        snapshot,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
      // The timer is only relevant while the race is undecided; once either side wins, clear it
      // so a fast-settling snapshot does not leave a no-op timer alive for the rest of the budget.
      clearTimeout(timer!);
      return !timedOut;
    },
  };
}
