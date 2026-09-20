import { describe, expect, it, vi } from 'vitest';
import {
  acquirePriorityLease,
  overlayPinnedPriorities,
  releasePriorityLease,
} from './benchmark-priority-lease';

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
