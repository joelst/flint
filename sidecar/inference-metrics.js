function ratePerSecond (tokens, durationMs) {
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return tokens / (durationMs / 1000);
}

/**
 * Build truthful inference metrics. Timing fields are null when the transport cannot observe
 * the event, rather than estimating it from a completed non-streaming request.
 */
export function buildInferenceMetrics ({
  startedAt,
  loadMs = null,
  firstTokenAt = null,
  completedAt,
  tokensIn = null,
  tokensOut = null,
  variantId = null,
  executionProvider = null,
  warm = null,
}) {
  const validTokensIn = Number.isFinite(tokensIn) && tokensIn >= 0 ? tokensIn : null;
  const validTokensOut = Number.isFinite(tokensOut) && tokensOut >= 0 ? tokensOut : null;
  const durationMs = Number.isFinite(startedAt) && Number.isFinite(completedAt)
    ? Math.max(0, completedAt - startedAt)
    : null;
  const ttftMs = Number.isFinite(firstTokenAt) && Number.isFinite(startedAt)
    ? Math.max(0, firstTokenAt - startedAt)
    : null;
  const decodeMs = ttftMs === null || durationMs === null
    ? null
    : Math.max(0, durationMs - ttftMs);
  const promptMs = ttftMs === null || loadMs === null
    ? null
    : Math.max(0, ttftMs - loadMs);

  return {
    durationMs,
    loadMs: Number.isFinite(loadMs) ? Math.max(0, loadMs) : null,
    ttftMs,
    promptTokensPerSecond: ratePerSecond(validTokensIn, promptMs),
    decodeTokensPerSecond: ratePerSecond(validTokensOut, decodeMs),
    tokensIn: validTokensIn,
    tokensOut: validTokensOut,
    variantId: typeof variantId === 'string' && variantId ? variantId : null,
    executionProvider: typeof executionProvider === 'string' && executionProvider
      ? executionProvider
      : null,
    warm,
  };
}
