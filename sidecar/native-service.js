/**
 * Stop Foundry's native listener, including a start that opened a listener but failed before
 * the SDK decoded and published its URL list.
 */
export function stopNativeWebService({ manager, startAttempted }) {
  if (!manager) return false;

  if (startAttempted && !manager.urls?.length) {
    const interop = manager.coreInterop;
    if (typeof interop?.executeCommand !== 'function') {
      throw new Error('Cannot stop a native service whose startup did not publish an address.');
    }
    interop.executeCommand('stop_service');
  } else {
    manager.stopWebService?.();
  }
  return true;
}

/**
 * Poll an HTTP readiness endpoint without allowing one stalled attempt to exceed
 * the overall deadline.
 */
export async function waitForHttpReady({
  fetchImpl,
  url,
  deadlineMs = 20_000,
  pollIntervalMs = 150,
}) {
  const numericDeadline = Number(deadlineMs);
  const deadline = Number.isFinite(numericDeadline)
    ? Math.max(0, Math.floor(numericDeadline))
    : 20_000;
  const numericPollInterval = Number(pollIntervalMs);
  const pollInterval = Number.isFinite(numericPollInterval)
    ? Math.max(0, Math.floor(numericPollInterval))
    : 150;
  const expiresAt = Date.now() + deadline;
  let lastError = null;

  while (Date.now() < expiresAt) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      Math.max(1, expiresAt - Date.now()),
    );

    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      try {
        const cancellation = response.body?.cancel();
        cancellation?.catch?.(() => {});
      } catch {
        // Readiness depends on the status, not cleanup of an unused body.
      }
      if (response.ok) return { ready: true, lastError: null };
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error?.message ?? String(error);
    } finally {
      clearTimeout(timeoutId);
    }

    const remaining = expiresAt - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, remaining)));
  }

  return { ready: false, lastError };
}
