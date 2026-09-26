/**
 * Stop Foundry's native listener through the public SDK surface. When startup may have opened
 * a listener but failed before publishing URLs, the SDK cannot confirm that it stopped.
 */
export function stopNativeWebService({ manager, startAttempted }) {
  if (!manager) return false;
  if (!startAttempted && !manager.urls?.length) return false;

  if (typeof manager.stopWebService !== 'function') {
    throw new Error('Foundry manager does not expose stopWebService().');
  }

  const hadPublishedAddress = Boolean(manager.urls?.length);
  manager.stopWebService();
  if (startAttempted && !hadPublishedAddress) {
    throw new Error(
      'Native service stop is unconfirmed because the SDK did not publish an address.',
    );
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
