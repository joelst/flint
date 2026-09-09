export const DEFAULT_FETCH_BODY_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Read at most `maxBytes` from a fetch response body and cancel the remainder.
 *
 * @param {Response} response
 * @param {number} [maxBytes]
 * @returns {Promise<{text: string, truncated: boolean, byteCount: number}>}
 */
export async function readBoundedResponseText(
  response,
  maxBytes = DEFAULT_FETCH_BODY_LIMIT,
) {
  const numericLimit = Number(maxBytes);
  const limit = Number.isFinite(numericLimit)
    ? Math.max(0, Math.floor(numericLimit))
    : DEFAULT_FETCH_BODY_LIMIT;
  if (response?.body === null) {
    return { text: '', truncated: false, byteCount: 0 };
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw new Error('Response body is unavailable');
  }

  const reader = response.body.getReader();
  if (limit === 0) {
    try {
      await reader.cancel('Response body exceeded Flint fetch limit');
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A cancelled stream may already have released its reader.
      }
    }
    return { text: '', truncated: true, byteCount: 0 };
  }

  const decoder = new TextDecoder();
  let text = '';
  let byteCount = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const remaining = limit - byteCount;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          text += decoder.decode(chunk.subarray(0, remaining), { stream: true });
          byteCount += remaining;
        }
        truncated = true;
        await reader.cancel('Response body exceeded Flint fetch limit');
        break;
      }

      text += decoder.decode(chunk, { stream: true });
      byteCount += chunk.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may already have released its reader.
    }
  }

  if (!truncated) text += decoder.decode();
  return { text, truncated, byteCount };
}

/**
 * Fetch a URL and keep one deadline active through headers and bounded body consumption.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{timeoutMs?: number, maxBytes?: number, headers?: Record<string, string>, redirect?: RequestRedirect}} [options]
 */
export async function fetchBoundedResponseText(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(
    1,
    Math.floor(Number(options.timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS),
  );
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: options.headers,
      redirect: options.redirect,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the HTTP error rather than replacing it with cleanup failure.
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return {
      response,
      ...(await readBoundedResponseText(
        response,
        options.maxBytes ?? DEFAULT_FETCH_BODY_LIMIT,
      )),
    };
  } finally {
    controller.abort();
    clearTimeout(timeoutId);
  }
}
