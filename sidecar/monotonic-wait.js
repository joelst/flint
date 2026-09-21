/**
 * Polls a bounded elapsed-time deadline without depending on the wall clock.
 *
 * A deadline built from `Date.now()` (`const deadline = Date.now() + timeoutMs`, then comparing
 * a later `Date.now()` against it) measures elapsed time using the system's wall clock, which can
 * jump backward — an NTP correction, a DST transition, or a user/administrator setting the clock
 * back — at any point while the wait is in progress. When that happens the comparison against
 * `deadline` can stay false far longer than `timeoutMs` of real time, silently turning a bounded
 * wait into an effectively unbounded one. `now` defaults to `performance.now()`, which Node backs
 * with a monotonic, steady clock immune to exactly that class of adjustment, so the elapsed time
 * this function measures always matches real elapsed time regardless of what the wall clock does
 * concurrently.
 *
 * `now` and `sleep` are injectable purely so tests can drive elapsed time deterministically
 * (including proving indifference to a wall clock moving backward) without waiting in real time.
 */
export async function waitUntilIdle(
  isIdle,
  timeoutMs,
  { now = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 25 } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (isIdle()) return true;
    if (now() >= deadline) return isIdle();
    await sleep(pollMs);
  }
}
