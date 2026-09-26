import { describe, expect, it, vi } from 'vitest';
import { waitUntilIdle } from './monotonic-wait.js';

describe('waitUntilIdle', () => {
  it('resolves true immediately when isIdle() is already true, without sleeping', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await waitUntilIdle(() => true, 1000, { now: () => 0, sleep });
    expect(result).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until isIdle() flips true, well within the deadline', async () => {
    let calls = 0;
    const isIdle = () => ++calls >= 3;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await waitUntilIdle(isIdle, 1000, { now: () => 0, sleep });
    expect(result).toBe(true);
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up and returns a final isIdle() reading once the injected clock reaches the deadline', async () => {
    let clock = 0;
    const now = () => clock;
    const sleep = vi.fn().mockImplementation(async () => {
      clock += 25;
    });
    const result = await waitUntilIdle(() => false, 100, { now, sleep });
    expect(result).toBe(false);
    // Started at 0, deadline is 100; polls at 25/50/75/100 (four sleeps) before now() >= deadline.
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('returns true from the final check if isIdle() only becomes true exactly at the deadline', async () => {
    let clock = 0;
    const now = () => clock;
    const sleep = vi.fn().mockImplementation(async () => {
      clock += 50;
    });
    const isIdle = () => clock >= 100;
    const result = await waitUntilIdle(isIdle, 100, { now, sleep });
    expect(result).toBe(true);
  });

  it('is immune to Date.now() moving backward mid-wait — the deadline math never reads it', async () => {
    // Regression for "Use a monotonic clock for gateway drain deadlines": the whole point of
    // taking `now` as a parameter (defaulting to `performance.now()`, not `Date.now()`) is that a
    // wall-clock rollback cannot re-extend an elapsed-time deadline that is already ticking.
    // Prove that by making `Date.now()` itself jump backward partway through the wait, while the
    // injected monotonic `now` keeps advancing normally, and confirming the deadline still fires
    // on the schedule the injected clock dictates rather than being pushed out.
    const realDateNow = Date.now;
    let clock = 0;
    const now = () => clock;
    let pollCount = 0;
    const sleep = vi.fn().mockImplementation(async () => {
      pollCount += 1;
      if (pollCount === 2) {
        // Simulate an NTP correction / user clock change moving the wall clock backward by an
        // hour, in between polls, while the monotonic clock keeps advancing normally.
        Date.now = () => realDateNow() - 60 * 60 * 1000;
      }
      clock += 25;
    });
    try {
      const result = await waitUntilIdle(() => false, 100, { now, sleep });
      expect(result).toBe(false);
      // Same poll count as the non-rollback deadline test above: the backward Date.now() jump
      // had zero effect on when the wait actually gave up.
      expect(sleep).toHaveBeenCalledTimes(4);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('defaults now to performance.now() and sleep to a real timer when not overridden', async () => {
    const start = performance.now();
    const result = await waitUntilIdle(() => false, 30);
    const elapsed = performance.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  it('the real default now (performance.now()) is unaffected when Date.now() rolls back mid-wait', async () => {
    // Unlike the injected-clock regression above (which proves the *math* is correct given
    // whatever `now` is passed in, but would pass even if the default were quietly changed back
    // to `Date.now()`), this exercises the actual production default: no `now` override at all.
    // Only `Date.now()` is rolled back mid-wait; `performance.now()` — what the default actually
    // reads — is left completely alone, and the real elapsed wall-clock time is what the
    // assertion below checks against, so the test only stays green if the default is genuinely
    // reading the monotonic clock and genuinely ignoring the rolled-back `Date.now()`.
    const realDateNow = Date.now;
    const start = performance.now();
    let pollCount = 0;
    const sleep = vi.fn().mockImplementation(async (ms) => {
      pollCount += 1;
      if (pollCount === 1) {
        Date.now = () => realDateNow() - 60 * 60 * 1000;
      }
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    try {
      const result = await waitUntilIdle(() => false, 60, { sleep });
      const elapsedRealMs = performance.now() - start;
      expect(result).toBe(false);
      // Genuine real elapsed time must be close to the requested 60ms, not hours off — proving
      // the default `now` param was never affected by the rolled-back Date.now().
      expect(elapsedRealMs).toBeGreaterThanOrEqual(50);
      expect(elapsedRealMs).toBeLessThan(2000);
    } finally {
      Date.now = realDateNow;
    }
  });
});
