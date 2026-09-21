import { describe, expect, it } from 'vitest';
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

  it('a later track() supersedes an earlier one: join() waits for the newest call, not the first', async () => {
    const tracker = createPendingCallTracker();
    const first = deferred<void>();
    const second = deferred<void>();
    tracker.track(first.promise);
    tracker.track(second.promise);

    let joined = false;
    const joinPromise = tracker.join().then(() => {
      joined = true;
    });

    // Resolving the first (superseded) call must not satisfy join().
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(joined).toBe(false);

    second.resolve();
    await joinPromise;
    expect(joined).toBe(true);
  });

  it("an earlier call settling after a later one started does not clear the newer call's tracking", async () => {
    const tracker = createPendingCallTracker();
    const first = deferred<void>();
    const second = deferred<void>();
    tracker.track(first.promise);
    tracker.track(second.promise);

    // The first call's own settlement finally-handler runs, but must see that `second` has
    // since replaced it in the slot and therefore must not clear it out from under `second`.
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
});
