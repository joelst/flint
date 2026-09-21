/**
 * Retries a failed `setBenchmarkExclusive(false)` release in the background until it is
 * confirmed, without blocking whatever caller needed the release (the benchmark run has already
 * finished by the time this runs; there is nothing else to gate on it).
 *
 * Extracted from `+page.svelte` (`@ts-nocheck`, no regression coverage) because a rejected
 * release call is high-impact: the sidecar's release direction of `benchmarkExclusive` has no
 * failure branch of its own once it reaches the sidecar (it is an unconditional synchronous
 * assignment), so a rejected round trip means the flag's true state is unconfirmed, not merely
 * "probably fine" -- it may still be blocking every external OpenAI-shaped gateway client with
 * 503s. Retrying with backoff (rather than giving up after the caller's own single attempt)
 * gives transient IPC hiccups a real chance to clear on their own, while `retryNow`/`stuck` give
 * a UI layer an immediate manual option and something to show while automatic retries continue.
 */

export type ExclusiveReleaseRetrier = {
  /** True once at least one attempt has failed and no attempt has confirmed release since. */
  readonly stuck: boolean;
  /** Immediate attempt rather than waiting for the next scheduled tick -- for a user actively
   * watching a "stuck" banner. Cancels any pending scheduled retry first so the two never race.
   * A no-op once `cancel()` has been called: a cancelled retrier is retired permanently, not
   * merely paused, so it must not be resurrected by a caller still holding a stale reference. */
  retryNow: () => Promise<void>;
  /** Cancels any pending scheduled retry and permanently retires this retrier: any attempt
   * already awaiting its own `release()` call becomes a no-op once it settles (it will not
   * schedule a further retry or notify `onStuckChange`), and `retryNow()` becomes a no-op too.
   * Does not change the last-reported `stuck` value itself (cancelling does not mean released);
   * intended for retiring a retrier that a caller has superseded (e.g. a newer generation
   * claiming exclusivity), not for normal operation, where the retrier is expected to keep
   * running until it confirms release. */
  cancel: () => void;
};

/** Escalating backoff, capped at the last entry for any further attempt. */
export const DEFAULT_EXCLUSIVE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];

/**
 * Creates a retrier already primed by one failed attempt: the caller is expected to have made
 * that first attempt itself (it needed the immediate result to decide whether a retrier is even
 * necessary), so this schedules its *next* attempt rather than an immediate one. `onStuckChange`
 * fires synchronously and immediately with `true` on creation, then again on every change, so a
 * UI layer can drive a banner purely from this callback instead of polling `stuck`.
 */
export function createExclusiveReleaseRetrier(
  release: () => Promise<void>,
  onStuckChange: (stuck: boolean) => void,
  delaysMs: readonly number[] = DEFAULT_EXCLUSIVE_RETRY_DELAYS_MS,
): ExclusiveReleaseRetrier {
  let stuck = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  /** At most one `release()` call is ever in flight: a manual `retryNow()` invoked while a
   * scheduled tick's attempt is already awaiting joins that same attempt instead of firing a
   * second concurrent release call (which would be redundant at best, and racy in outcome
   * ordering at worst — see the module doc for why cancel() cannot abort an attempt already
   * past its `await`). */
  let inFlight: Promise<boolean> | null = null;
  /** Set by `cancel()`. Checked after every awaited `attemptRelease()` (in `tick()` and in
   * `retryNow()`) before scheduling the next attempt or calling `onStuckChange` -- clearing the
   * timer alone does not stop a `tick()` that was already past its `await release()` when
   * `cancel()` ran; without this flag that call resumes, finds itself "cancelled" too late, and
   * either reschedules a new timer the caller believed was stopped or reports a stuck/released
   * transition for a retrier the caller has already discarded (e.g. a superseded generation's
   * retrier updating the current banner state after a newer run replaced it). */
  let cancelled = false;
  onStuckChange(true);

  const setStuck = (next: boolean) => {
    if (stuck === next) return;
    stuck = next;
    onStuckChange(next);
  };

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const attemptRelease = (): Promise<boolean> => {
    if (inFlight) return inFlight;
    const p: Promise<boolean> = (async () => {
      try {
        await release();
        return true;
      } catch {
        return false;
      }
    })();
    inFlight = p;
    void p.finally(() => { inFlight = null; });
    return p;
  };

  const scheduleNext = () => {
    clear();
    const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
    attempt += 1;
    timer = setTimeout(() => { void tick(); }, delay);
  };

  const tick = async () => {
    if (cancelled) return;
    timer = null;
    const released = await attemptRelease();
    if (cancelled) return;
    if (released) {
      setStuck(false);
      return;
    }
    scheduleNext();
  };

  scheduleNext();

  return {
    get stuck() { return stuck; },
    async retryNow() {
      if (cancelled) return;
      clear();
      const released = await attemptRelease();
      if (cancelled) return;
      if (released) {
        setStuck(false);
      } else {
        setStuck(true);
        scheduleNext();
      }
    },
    cancel() {
      cancelled = true;
      clear();
    },
  };
}
