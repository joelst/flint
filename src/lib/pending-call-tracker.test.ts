import { describe, expect, it, vi } from 'vitest';
import { createPendingCallTracker } from './pending-call-tracker';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createPendingCallTracker', () => {
  it('join() resolves immediately when nothing is tracked', async () => {
    const tracker = createPendingCallTracker();
    await expect(tracker.join()).resolves.toBeUndefined();
  });

  it('join() waits for a tracked call to settle (success case)', async () => {
    const tracker = createPendingCallTracker();
    const d = deferred<void>();
    tracker.track(d.promise);

    let joined = false;
    const joinPromise = tracker.join().then(() => {
      joined = true;
    });

    // Not yet settled.
    await Promise.resolve();
    expect(joined).toBe(false);

    d.resolve();
    await joinPromise;
    expect(joined).toBe(true);
  });

  it('join() waits for a tracked call to settle (failure case) without rejecting', async () => {
    const tracker = createPendingCallTracker();
    const d = deferred<void>();
    tracker.track(d.promise);

    const joinPromise = tracker.join();
    d.reject(new Error('boom'));

    await expect(joinPromise).resolves.toBeUndefined();
  });

  it('clears the slot once the tracked call settles, so a later join() resolves immediately', async () => {
    const tracker = createPendingCallTracker();
    const d = deferred<void>();
    tracker.track(d.promise);
    d.resolve();
    await tracker.join();

    // A brand new join() (nothing newly tracked) must not hang on the old, already-settled call.
    await expect(tracker.join()).resolves.toBeUndefined();
  });

  it('tracking a second call while a first is still pending: join() waits for both, not just the newest', async () => {
    const tracker = createPendingCallTracker();
    const first = deferred<void>();
    const second = deferred<void>();
    tracker.track(first.promise);
    tracker.track(second.promise);

    let joined = false;
    const joinPromise = tracker.join().then(() => {
      joined = true;
    });

    // Resolving only the first must not satisfy join() while the second is still outstanding.
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(joined).toBe(false);

    second.resolve();
    await joinPromise;
    expect(joined).toBe(true);
  });

  it('an earlier call settling after a later one started still clears its own tracking independently', async () => {
    const tracker = createPendingCallTracker();
    const first = deferred<void>();
    const second = deferred<void>();
    tracker.track(first.promise);
    tracker.track(second.promise);

    // The first call's own settlement finally-handler runs and removes only itself; `second`
    // remains tracked on its own.
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    let joined = false;
    const joinPromise = tracker.join().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);

    second.resolve();
    await joinPromise;
    expect(joined).toBe(true);
  });

  it('joinWithTimeout() giving up on a still-pending call does not let a later track() (e.g. a retry) lose it: a subsequent join() still waits for it', async () => {
    // This is the exact shape of `finishBenchmarkExecution`'s retry path: the original release
    // call times out under joinWithTimeout (still pending, not cancelled), then the retrier
    // tracks a brand new release attempt of its own. A later run's plain join() must still wait
    // for the *original* call too, or it could land after that later run's own acquire and undo
    // it (see the tracker's class docstring).
    vi.useFakeTimers();
    try {
      const tracker = createPendingCallTracker();
      const original = deferred<void>();
      tracker.track(original.promise);

      const gaveUp = tracker.joinWithTimeout(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(gaveUp).resolves.toBe(false);

      // Simulate the retrier tracking its own new attempt while `original` is still pending.
      const retry = deferred<void>();
      tracker.track(retry.promise);

      let joined = false;
      const joinPromise = tracker.join().then(() => {
        joined = true;
      });

      // The retry settling alone must not be enough -- `original` is still outstanding.
      retry.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(joined).toBe(false);

      original.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await joinPromise;
      expect(joined).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('joinWithTimeout() resolves true immediately when nothing is tracked', async () => {
    const tracker = createPendingCallTracker();
    await expect(tracker.joinWithTimeout(10)).resolves.toBe(true);
  });

  it('joinWithTimeout() resolves true once the tracked call settles within the budget', async () => {
    vi.useFakeTimers();
    try {
      const tracker = createPendingCallTracker();
      const d = deferred<void>();
      tracker.track(d.promise);

      const joinPromise = tracker.joinWithTimeout(1000);
      d.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await expect(joinPromise).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('joinWithTimeout() resolves false when the tracked call has not settled by the deadline, without cancelling it', async () => {
    vi.useFakeTimers();
    try {
      const tracker = createPendingCallTracker();
      const d = deferred<void>();
      tracker.track(d.promise);

      const joinPromise = tracker.joinWithTimeout(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(joinPromise).resolves.toBe(false);

      // The stuck call settling later must not throw/break anything, and a fresh join() must
      // still see it as tracked until it does settle.
      d.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await expect(tracker.join()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
