export const DEFAULT_FETCH_BODY_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_ERROR_BODY_LIMIT = 64 * 1024;
export const DEFAULT_ERROR_BODY_TIMEOUT_MS = 5_000;

/**
 * Read at most `maxBytes` from a fetch response body and cancel the remainder.
 *
 * @param {Response} response
 * @param {number} [maxBytes]
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{text: string, truncated: boolean, byteCount: number}>}
 */
export async function readBoundedResponseText(
  response,
  maxBytes = DEFAULT_FETCH_BODY_LIMIT,
  options = {},
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
    void reader.cancel('Response body exceeded Flint fetch limit').catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may still own the reader.
    }
    return { text: '', truncated: true, byteCount: 0 };
  }

  const numericTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(numericTimeout)
    ? Math.max(1, Math.floor(numericTimeout))
    : null;
  let timeoutId;
  const timeoutPromise = timeoutMs === null
    ? null
    : new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Response body read timed out after ${timeoutMs / 1000} seconds`));
          void reader.cancel('Response body read timed out').catch(() => {});
        }, timeoutMs);
      });
  const decoder = new TextDecoder();
  let text = '';
  let byteCount = 0;
  let truncated = false;

  try {
    while (true) {
      const read = reader.read();
      const { done, value } = await (timeoutPromise
        ? Promise.race([read, timeoutPromise])
        : read);
      if (done) break;

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const remaining = limit - byteCount;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          text += decoder.decode(chunk.subarray(0, remaining), { stream: true });
          byteCount += remaining;
        }
        truncated = true;
        void reader.cancel('Response body exceeded Flint fetch limit').catch(() => {});
        break;
      }

      text += decoder.decode(chunk, { stream: true });
      byteCount += chunk.byteLength;
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
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
 * Capture bounded diagnostics from an HTTP error response.
 *
 * @param {Response} response
 * @param {{maxBytes?: number, timeoutMs?: number}} [options]
 */
export async function readBoundedErrorBody(response, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_ERROR_BODY_LIMIT;
  const timeoutMs = Math.max(
    1,
    Math.floor(Number(options.timeoutMs) || DEFAULT_ERROR_BODY_TIMEOUT_MS),
  );

  try {
    const result = await readBoundedResponseText(response, maxBytes, { timeoutMs });
    const suffix = result.truncated ? ` [truncated after ${result.byteCount} bytes]` : '';
    const raw = result.text || '';
    const contentType = response?.headers?.get?.('content-type') || '';
    if (raw && contentType.includes('application/json')) {
      try {
        return `${JSON.stringify(JSON.parse(raw))}${suffix}`;
      } catch {
        // A truncated or malformed JSON error is still useful as bounded text.
      }
    }
    return `${raw}${suffix}` || '(empty response body)';
  } catch (error) {
    return `[${error?.message || error}]`;
  }
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
