/**
 * Bring a failed service start to a known stopped state.
 *
 * Gateway and native-service teardown are intentionally best-effort. A caller that has already
 * received a failed start must never be told that a stale endpoint is still available.
 */
export async function stopPartiallyStartedService({
  stopGateway,
  stopNativeService,
  clearPublishedService,
  log,
}) {
  try {
    await stopGateway();
  } catch (error) {
    log('warn', `Gateway stop during failed service start (ignored): ${error?.message ?? error}`);
  }
  try {
    await stopNativeService();
  } catch (error) {
    log('warn', `Native service stop during failed service start (ignored): ${error?.message ?? error}`);
  }
  clearPublishedService();
}

/**
 * Serialize service starts and stops without poisoning later transitions when one fails.
 */
export function createServiceTransitionLock() {
  let tail = Promise.resolve();

  return async function acquireServiceTransition() {
    let release;
    const complete = new Promise((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = previous.then(() => complete, () => complete);
    await previous;
    return release;
  };
}
