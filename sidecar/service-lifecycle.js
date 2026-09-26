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

/**
 * Fence new runtime work while allowing already-admitted operations to drain.
 *
 * Admission and registration are one synchronous step. A shutdown request can therefore switch
 * to draining without a command slipping through between its authorization check and tracking.
 */
export function createOperationAdmission() {
  let phase = 'accepting';
  const active = new Map();
  const waiters = new Set();

  const notifyIfDrained = () => {
    if (active.size !== 0) return;
    for (const resolve of waiters) resolve(true);
    waiters.clear();
  };

  return {
    admit(id, command) {
      if (phase !== 'accepting') return false;
      active.set(id, command);
      return true;
    },
    complete(id) {
      active.delete(id);
      notifyIfDrained();
    },
    beginDrain({ terminal = false } = {}) {
      if (terminal) phase = 'terminal';
      else if (phase === 'accepting') phase = 'draining';
      return [...active.entries()].map(([id, command]) => ({ id, command }));
    },
    resume() {
      if (phase !== 'terminal') phase = 'accepting';
    },
    snapshot() {
      return [...active.entries()].map(([id, command]) => ({ id, command }));
    },
    async waitForDrain(timeoutMs) {
      if (active.size === 0) return true;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (drained) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(onDrained);
          resolve(drained);
        };
        const onDrained = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        waiters.add(onDrained);
      });
    },
  };
}
