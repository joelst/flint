import { describe, expect, it, vi } from 'vitest';
import {
  acquirePriorityLease,
  computeResidentCapFloor,
  overlayPinnedPriorities,
  overlayResidentCapFloor,
  releasePriorityLease,
} from './benchmark-priority-lease';

describe('overlayResidentCapFloor', () => {
  it('returns the config unchanged (no copy) when there is no active lease', () => {
    const config = { maxResidentEnabled: true, maxResident: 1 };
    expect(overlayResidentCapFloor(config, 0)).toBe(config);
  });

  it('returns the config unchanged when the cap is disabled — a disabled cap cannot block loading', () => {
    const config = { maxResidentEnabled: false, maxResident: 1 };
    expect(overlayResidentCapFloor(config, 2)).toBe(config);
  });

  it('returns the config unchanged when the configured cap already meets the floor', () => {
    const config = { maxResidentEnabled: true, maxResident: 3 };
    expect(overlayResidentCapFloor(config, 2)).toBe(config);
  });

  it('raises maxResident to the floor without mutating the input, when the cap is too low', () => {
    const config = { maxResidentEnabled: true, maxResident: 1 };
    const overlaid = overlayResidentCapFloor(config, 2);
    expect(overlaid).toEqual({ maxResidentEnabled: true, maxResident: 2 });
    expect(config).toEqual({ maxResidentEnabled: true, maxResident: 1 });
  });
});

describe('computeResidentCapFloor', () => {
  it('returns 0 when no lease is held (ownAliases is empty), regardless of pool/priorities', () => {
    const pool = [{ alias: 'other-model' }];
    const priorities = { 'other-model': 'pinned' };
    expect(computeResidentCapFloor(pool, priorities, [])).toBe(0);
  });

  it("counts only this run's own aliases when nothing else resident is pinned", () => {
    const pool = [{ alias: 'model-a' }, { alias: 'model-b' }];
    const priorities = {};
    expect(computeResidentCapFloor(pool, priorities, ['model-a', 'model-b'])).toBe(2);
  });

  it('adds any other resident alias the user has separately pinned', () => {
    const pool = [{ alias: 'model-a' }, { alias: 'user-pinned' }];
    const priorities = { 'user-pinned': 'pinned', 'not-resident-elsewhere': 'pinned' };
    // 'not-resident-elsewhere' is pinned but not present in `pool`, so it does not count — only
    // resident entries can occupy a slot against the cap.
    expect(computeResidentCapFloor(pool, priorities, ['model-a'])).toBe(2);
  });

  it("does not double-count this run's own aliases even if they are separately marked pinned in priorities", () => {
    const pool = [{ alias: 'model-a' }];
    const priorities = { 'model-a': 'pinned' };
    expect(computeResidentCapFloor(pool, priorities, ['model-a'])).toBe(1);
  });

  it('reflects a priority pinned *after* the lease was installed — the identity-based fix for stale floors', () => {
    // Regression for "Recompute cap floor when priorities change during preparation": a run's own
    // aliases never change mid-run, but the *other* resident/pinned set can grow while a later
    // target is still loading, and the floor must grow with it on the very next computation
    // rather than staying frozen at whatever it was when the lease was first installed.
    const pool = [{ alias: 'run-target-1' }, { alias: 'run-target-2' }, { alias: 'newly-pinned' }];
    const ownAliases = ['run-target-1', 'run-target-2'];
    const beforeUserPin = { 'newly-pinned': 'normal' };
    const afterUserPin = { 'newly-pinned': 'pinned' };
    expect(computeResidentCapFloor(pool, beforeUserPin, ownAliases)).toBe(2);
    expect(computeResidentCapFloor(pool, afterUserPin, ownAliases)).toBe(3);
  });
});



describe('overlayPinnedPriorities', () => {
  it('returns the map unchanged (no copy) when nothing is pinned', () => {
    const priorities = { 'model-a': 'low' };
    expect(overlayPinnedPriorities(priorities, [])).toBe(priorities);
  });

  it('forces every pinned alias to pinned without mutating the input', () => {
    const priorities = { 'model-a': 'low', 'model-b': 'normal' };
    const overlaid = overlayPinnedPriorities(priorities, ['model-a', 'model-c']);
    expect(overlaid).toEqual({ 'model-a': 'pinned', 'model-b': 'normal', 'model-c': 'pinned' });
    expect(priorities).toEqual({ 'model-a': 'low', 'model-b': 'normal' });
  });

  it('re-applies the pin over a concurrent setting update made while the lease is held', () => {
    // Simulates a user editing Settings mid-run: the map passed in already reflects their edit
    // (here, demoting the pinned target to 'low'), and the overlay must still win.
    const userEdited = { 'model-a': 'low' };
    expect(overlayPinnedPriorities(userEdited, ['model-a'])).toEqual({ 'model-a': 'pinned' });
  });

  it('pins an alias literally named "__proto__" as a real own enumerable property', () => {
    // A regular `{ ...priorities }` copy plus `next['__proto__'] = 'pinned'` silently no-ops:
    // the string value isn't an object/null, so the inherited __proto__ accessor ignores the
    // assignment instead of creating an own property, and `Object.entries()` would then omit
    // this target entirely -- exposing it to eviction despite believing it is pinned.
    const overlaid = overlayPinnedPriorities({}, ['__proto__']);
    expect(Object.entries(overlaid)).toEqual([['__proto__', 'pinned']]);
    expect(Object.getPrototypeOf(overlaid)).toBeNull();
    expect(overlaid.__proto__).toBe('pinned');
  });

  it('copies an existing priorities map without adopting a poisoned prototype', () => {
    const priorities = { 'model-a': 'low' };
    const overlaid = overlayPinnedPriorities(priorities, ['__proto__']);
    expect(overlaid).toEqual({ 'model-a': 'low', ['__proto__']: 'pinned' });
    expect(Object.entries(overlaid)).toEqual(
      expect.arrayContaining([
        ['model-a', 'low'],
        ['__proto__', 'pinned'],
      ]),
    );
  });
});

describe('acquirePriorityLease', () => {
  it('records the pinned aliases synchronously, before the push acknowledgement settles', () => {
    let resolvePush!: () => void;
    const push = vi.fn(() => new Promise<void>((resolve) => { resolvePush = resolve; }));
    const lease = acquirePriorityLease(['model-a', 'model-b'], push);
    // No await yet: pinnedAliases must already be the full list.
    expect(lease.pinnedAliases).toEqual(['model-a', 'model-b']);
    expect(push).toHaveBeenCalledWith(['model-a', 'model-b']);
    resolvePush();
  });

  it('resolves ack ok:true on a successful push', async () => {
    const push = vi.fn(async () => {});
    const lease = acquirePriorityLease(['model-a'], push);
    await expect(lease.ack).resolves.toEqual({ ok: true });
  });

  it('still reports the aliases as pinned when the push rejects — an uncertain ack does not prove nothing was applied', async () => {
    const push = vi.fn(async () => { throw new Error('sidecar unreachable'); });
    const lease = acquirePriorityLease(['model-a'], push);
    expect(lease.pinnedAliases).toEqual(['model-a']);
    await expect(lease.ack).resolves.toEqual({ ok: false, error: 'sidecar unreachable' });
  });
});

describe('releasePriorityLease', () => {
  it('is a no-op when nothing is currently pinned', () => {
    const push = vi.fn(async () => {});
    expect(releasePriorityLease([], push)).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('clears pinnedAliases synchronously and pushes no overlay', () => {
    let resolvePush!: () => void;
    const push = vi.fn(() => new Promise<void>((resolve) => { resolvePush = resolve; }));
    const lease = releasePriorityLease(['model-a'], push);
    expect(lease?.pinnedAliases).toEqual([]);
    expect(push).toHaveBeenCalledWith([]);
    resolvePush();
  });

  it('resolves ok:true on a successful restore', async () => {
    const push = vi.fn(async () => {});
    const lease = releasePriorityLease(['model-a'], push);
    await expect(lease?.ack).resolves.toEqual({ ok: true });
  });

  it('retries exactly once after a failed restore, succeeding on the retry', async () => {
    let calls = 0;
    const push = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
    });
    const lease = releasePriorityLease(['model-a'], push);
    await expect(lease?.ack).resolves.toEqual({ ok: true });
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenNthCalledWith(1, []);
    expect(push).toHaveBeenNthCalledWith(2, []);
  });

  it('gives up after the retry also fails, reporting both errors, aliases still cleared', async () => {
    let calls = 0;
    const push = vi.fn(async () => {
      calls += 1;
      throw new Error(calls === 1 ? 'first failure' : 'second failure');
    });
    const lease = releasePriorityLease(['model-a'], push);
    expect(lease?.pinnedAliases).toEqual([]);
    await expect(lease?.ack).resolves.toEqual({
      ok: false,
      error: 'second failure (after retry; first attempt: first failure)',
    });
    expect(push).toHaveBeenCalledTimes(2);
  });
});
