/**
 * Pure adapter for the benchmark "priority lease": while a run is active, its target aliases are
 * forced to `pinned` eviction priority so pool eviction cannot unload a model mid-run, then
 * restored to the user's actual configured priorities once the run halts.
 *
 * Extracted from `+page.svelte` (`@ts-nocheck`, no regression coverage) so the three guarantees
 * that matter here — recording the lease before an uncertain acknowledgement, overlaying every
 * concurrent priority push while the lease is held, and restoring before the run guard releases
 * — have direct tests instead of only being exercised through `benchmark-lifecycle.ts`'s
 * `fakeHost`, which stubs `pinAliases`/`unpin` and cannot see any of this.
 */

export type PriorityLeaseResult = { ok: true } | { ok: false; error: string };

export interface PriorityLeaseAck {
  /** Aliases the caller must now hold as pinned, available synchronously — before `ack`
   * settles — so a concurrent push started while this is still in flight already sees the
   * lease. This is not a snapshot of what got applied server-side (see `ack`), only prevails an
   * uncertain acknowledgement always finds cleanup with the right list to restore. */
  pinnedAliases: string[];
  /** Settles once the effectful push this call made has settled (successfully or not). */
  ack: Promise<PriorityLeaseResult>;
}

/**
 * Overlays `pinnedAliases` (forced to `'pinned'`) onto `priorities`. Pure, and safe to call from
 * every priority push made while a lease is held, not only the call that installs it — a
 * priority/eviction edit made elsewhere (e.g. Settings) during a benchmark run would otherwise
 * resend the plain map with no pin at all, silently exposing a running benchmark's targets to
 * eviction. Returns `priorities` unchanged (no copy) when there is nothing to overlay.
 */
export function overlayPinnedPriorities(
  priorities: Record<string, string>,
  pinnedAliases: readonly string[],
): Record<string, string> {
  if (pinnedAliases.length === 0) return priorities;
  const next = { ...priorities };
  for (const alias of pinnedAliases) next[alias] = 'pinned';
  return next;
}

/**
 * Installs a priority lease over `aliases`. `push` is invoked synchronously (before this
 * function returns) and its promise reflected in `ack`; `pinnedAliases` in the return value is
 * always `aliases` — recorded up front, not only on success — because `push` is effectful: a
 * rejected promise does not prove the sidecar never received/applied it. The caller must adopt
 * `pinnedAliases` immediately (not after awaiting `ack`) so `overlayPinnedPriorities` is applied
 * to any push that starts while `ack` is still pending, and must still run its normal unpin
 * cleanup even when `ack` resolves `{ ok: false }`.
 */
export function acquirePriorityLease(
  aliases: string[],
  push: (pinnedAliases: readonly string[]) => Promise<void>,
): PriorityLeaseAck {
  const pinnedAliases = aliases;
  const ack = push(pinnedAliases).then(
    (): PriorityLeaseResult => ({ ok: true }),
    (e: unknown): PriorityLeaseResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return { pinnedAliases, ack };
}

/**
 * Releases a priority lease. Returns `null` when `currentAliases` is already empty — nothing to
 * restore, so `push` is never called for a no-op release. Otherwise clears the alias list up
 * front (before awaiting `push`, mirroring `acquirePriorityLease`) so this specific push carries
 * no overlay, then retries `push` exactly once on failure — the push resends the full current
 * priority map each time, so replaying it is safe — before giving up and reporting that a
 * benchmark target may still be pinned.
 */
export function releasePriorityLease(
  currentAliases: readonly string[],
  push: (pinnedAliases: readonly string[]) => Promise<void>,
): PriorityLeaseAck | null {
  if (currentAliases.length === 0) return null;
  const ack = push([]).then(
    (): PriorityLeaseResult => ({ ok: true }),
    async (firstError: unknown): Promise<PriorityLeaseResult> => {
      try {
        await push([]);
        return { ok: true };
      } catch (retryError: unknown) {
        const first = firstError instanceof Error ? firstError.message : String(firstError);
        const retry = retryError instanceof Error ? retryError.message : String(retryError);
        return { ok: false, error: `${retry} (after retry; first attempt: ${first})` };
      }
    },
  );
  return { pinnedAliases: [], ack };
}
