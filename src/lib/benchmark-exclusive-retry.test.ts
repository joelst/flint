import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXCLUSIVE_RETRY_DELAYS_MS, createExclusiveReleaseRetrier } from './benchmark-exclusive-retry';

afterEach(() => {
  vi.useRealTimers();
});

describe('createExclusiveReleaseRetrier', () => {
  it('reports stuck synchronously on creation', () => {
    vi.useFakeTimers();
    const onStuckChange = vi.fn();
    createExclusiveReleaseRetrier(async () => {}, onStuckChange);

    expect(onStuckChange).toHaveBeenCalledTimes(1);
    expect(onStuckChange).toHaveBeenCalledWith(true);
  });

  it('does not attempt release before the first delay elapses', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    createExclusiveReleaseRetrier(release, vi.fn());

    await vi.advanceTimersByTimeAsync(DEFAULT_EXCLUSIVE_RETRY_DELAYS_MS[0] - 1);

    expect(release).not.toHaveBeenCalled();
  });

  it('clears stuck and stops retrying once a scheduled attempt succeeds', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    const onStuckChange = vi.fn();
    const retrier = createExclusiveReleaseRetrier(release, onStuckChange);

    await vi.advanceTimersByTimeAsync(DEFAULT_EXCLUSIVE_RETRY_DELAYS_MS[0]);

    expect(release).toHaveBeenCalledTimes(1);
    expect(retrier.stuck).toBe(false);
    expect(onStuckChange).toHaveBeenLastCalledWith(false);

    // No further attempts should be scheduled once released.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('escalates through the configured backoff on repeated failures, capping at the last entry', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => { throw new Error('still blocked'); });
    const retrier = createExclusiveReleaseRetrier(release, vi.fn(), [10, 20, 30]);

    await vi.advanceTimersByTimeAsync(10);
    expect(release).toHaveBeenCalledTimes(1);
    expect(retrier.stuck).toBe(true);

    await vi.advanceTimersByTimeAsync(20);
    expect(release).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30);
    expect(release).toHaveBeenCalledTimes(3);

    // Capped: a fourth failure schedules another attempt after the *last* configured delay, not
    // a shorter one and not none at all.
    await vi.advanceTimersByTimeAsync(30);
    expect(release).toHaveBeenCalledTimes(4);
  });

  it('retryNow attempts immediately without waiting for the scheduled delay', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    const onStuckChange = vi.fn();
    const retrier = createExclusiveReleaseRetrier(release, onStuckChange);

    await retrier.retryNow();

    expect(release).toHaveBeenCalledTimes(1);
    expect(retrier.stuck).toBe(false);
    expect(onStuckChange).toHaveBeenLastCalledWith(false);

    // The scheduled background timer must have been cancelled by retryNow -- advancing past
    // where it would have fired must not cause a second attempt.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retryNow reschedules the background loop (without resetting backoff) when it also fails', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => { throw new Error('still blocked'); });
    const onStuckChange = vi.fn();
    const retrier = createExclusiveReleaseRetrier(release, onStuckChange, [10, 20, 30]);

    await retrier.retryNow();
    expect(release).toHaveBeenCalledTimes(1);
    expect(retrier.stuck).toBe(true);

    // Backoff continues from where it left off (creation already consumed the first slot
    // scheduling retryNow's own attempt, so the next one uses the *second* slot), not reset to
    // the start, and not abandoned.
    await vi.advanceTimersByTimeAsync(20);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('a shared failure consumes exactly one backoff slot, not two, when retryNow joins an in-flight scheduled attempt', async () => {
    // Regression: retryNow() joining a scheduled tick's in-flight release() must not ALSO call
    // scheduleNext() when that shared attempt fails, or one failure would consume two backoff
    // slots (jumping e.g. from the 5s to the 10s delay) and the joiner's scheduleNext() would
    // cancel the owner's freshly-armed timer via clear().
    vi.useFakeTimers();
    let resolveRelease: (() => void) | null = null;
    let rejectRelease: ((e: Error) => void) | null = null;
    const release = vi.fn(() => new Promise<void>((resolve, reject) => {
      resolveRelease = resolve;
      rejectRelease = reject;
    }));
    const onStuckChange = vi.fn();
    const retrier = createExclusiveReleaseRetrier(release, onStuckChange, [10, 20, 30, 40]);

    // Let the scheduled tick fire and start its release() call, but don't let it settle yet.
    await vi.advanceTimersByTimeAsync(10);
    expect(release).toHaveBeenCalledTimes(1);

    // A manual retry while that attempt is still pending joins it instead of starting a second.
    const retryNowPromise = retrier.retryNow();
    expect(release).toHaveBeenCalledTimes(1);

    rejectRelease!(new Error('still blocked'));
    await retryNowPromise;
    expect(retrier.stuck).toBe(true);

    // Only one backoff slot (the 20ms one, since the first attempt already consumed the 10ms
    // one) should have been consumed by this single shared failure -- advancing by 20ms must
    // fire exactly one more attempt, not zero (owner's timer silently cancelled) and not two.
    await vi.advanceTimersByTimeAsync(20);
    expect(release).toHaveBeenCalledTimes(2);
    resolveRelease!();
    await vi.advanceTimersByTimeAsync(0);
    expect(retrier.stuck).toBe(false);
  });

  it('joins an in-flight scheduled attempt instead of firing a second concurrent release call', async () => {
    vi.useFakeTimers();
    let resolveRelease: (() => void) | null = null;
    const release = vi.fn(() => new Promise<void>((resolve) => { resolveRelease = resolve; }));
    const onStuckChange = vi.fn();
    const retrier = createExclusiveReleaseRetrier(release, onStuckChange);

    // Let the scheduled tick fire and start its release() call, but don't let it settle yet.
    await vi.advanceTimersByTimeAsync(DEFAULT_EXCLUSIVE_RETRY_DELAYS_MS[0]);
    expect(release).toHaveBeenCalledTimes(1);

    // A manual retry while that attempt is still pending must join it, not start a second one.
    const retryNowPromise = retrier.retryNow();
    expect(release).toHaveBeenCalledTimes(1);

    resolveRelease!();
    await retryNowPromise;

    expect(release).toHaveBeenCalledTimes(1);
    expect(retrier.stuck).toBe(false);
    expect(onStuckChange).toHaveBeenLastCalledWith(false);
  });

  it('cancel stops any pending scheduled retry without claiming release succeeded', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    const onStuckChange = vi.fn();
    const retrier = createExclusiveReleaseRetrier(release, onStuckChange);

    retrier.cancel();
    await vi.advanceTimersByTimeAsync(100_000);

    expect(release).not.toHaveBeenCalled();
    expect(retrier.stuck).toBe(true);
    expect(onStuckChange).toHaveBeenLastCalledWith(true);
  });

  it('cancel called while a scheduled attempt is already awaiting its release() call prevents that attempt from rescheduling or notifying once it settles', async () => {
    vi.useFakeTimers();
    let resolveRelease: (() => void) | null = null;
    const release = vi.fn(() => new Promise<void>((resolve) => { resolveRelease = resolve; }));
    const onStuckChange = vi.fn();
    const retrier = createExclusiveReleaseRetrier(release, onStuckChange);

    // Let the scheduled tick fire and start its release() call, but don't let it settle yet.
    await vi.advanceTimersByTimeAsync(DEFAULT_EXCLUSIVE_RETRY_DELAYS_MS[0]);
    expect(release).toHaveBeenCalledTimes(1);
    onStuckChange.mockClear();

    // Cancel while that attempt is still in flight -- clearing the timer alone would not stop
    // this attempt's continuation from running once release() finally resolves.
    retrier.cancel();

    // The in-flight release() now succeeds, but the retrier must not schedule a further retry
    // or fire onStuckChange for a run this cancel already retired.
    resolveRelease!();
    await vi.advanceTimersByTimeAsync(0);

    expect(onStuckChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('cancel called while retryNow is awaiting a failed release() call prevents that call from rescheduling', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => { throw new Error('still blocked'); });
    const onStuckChange = vi.fn();
    const retrier = createExclusiveReleaseRetrier(release, onStuckChange, [10, 20, 30]);

    const retryNowPromise = retrier.retryNow();
    retrier.cancel();
    await retryNowPromise;

    // The failed retryNow attempt must not have rescheduled a background retry after cancel.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retryNow is a no-op after cancel, even for a caller still holding a stale retrier reference', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    const onStuckChange = vi.fn();
    const retrier = createExclusiveReleaseRetrier(release, onStuckChange);

    retrier.cancel();
    onStuckChange.mockClear();
    await retrier.retryNow();

    // A cancelled retrier is permanently retired: retryNow must not dispatch a fresh release()
    // call or report any stuck/released transition, even though the underlying release()
    // would have succeeded.
    expect(release).not.toHaveBeenCalled();
    expect(onStuckChange).not.toHaveBeenCalled();
  });
});
