import type { CompareResult } from './comparison-history';

export type CompareSlotError = {
  certainty?: string;
  cmd?: string;
  message?: string;
};

export type CompareSlotErrorKind = 'pre-dispatch-stop' | 'prep-stop' | 'failed';

/**
 * Stop of the timed chatCompletion before write() is a known-never-sent slot.
 * Stop during download/load is "never reached inference". Any other cancel is a failure.
 */
export function classifyCompareSlotError(opts: {
  stopRequested: boolean;
  error: CompareSlotError;
  inferenceStarted: number | null;
}): CompareSlotErrorKind {
  const cancelled = opts.error.certainty === 'cancelled';
  if (cancelled && opts.stopRequested) {
    if (opts.error.cmd === 'chatCompletion' && opts.inferenceStarted != null) {
      return 'pre-dispatch-stop';
    }
    return 'prep-stop';
  }
  return 'failed';
}

export function buildStoppedPreDispatchResult(): CompareResult {
  return {
    content: '[Stopped] Cancelled before it was sent to the model.',
    rating: null,
    status: 'stopped',
  };
}

export function buildFailedCompareResult(
  error: CompareSlotError,
  inferenceStarted: number | null,
  now: number,
): CompareResult {
  const message = error.message || String(error);
  return {
    content: `[Error] ${message}`,
    latencyMs: inferenceStarted != null ? now - inferenceStarted : undefined,
    error: message,
    rating: null,
    status: 'failed',
  };
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function buildSettledCompareResult(opts: {
  content: string;
  stopRequested: boolean;
  inferenceStarted: number | null;
  now: number;
  nativeStreaming: boolean;
  firstDeltaAt: number | null;
  usage: {
    prompt_tokens?: number | null;
    input_tokens?: number | null;
    completion_tokens?: number | null;
    output_tokens?: number | null;
  };
  servedVariantId?: string | null;
  activeExecutionProvider?: string | null;
}): CompareResult {
  return {
    content: opts.content,
    latencyMs:
      opts.stopRequested || opts.inferenceStarted == null
        ? undefined
        : opts.now - opts.inferenceStarted,
    tokensIn: finiteToken(opts.usage.prompt_tokens) ?? finiteToken(opts.usage.input_tokens),
    tokensOut: finiteToken(opts.usage.completion_tokens) ?? finiteToken(opts.usage.output_tokens),
    rating: null,
    status: opts.stopRequested ? 'stopped' : 'completed',
    ttftMs:
      opts.nativeStreaming && opts.firstDeltaAt != null && opts.inferenceStarted != null
        ? opts.firstDeltaAt - opts.inferenceStarted
        : undefined,
    nativeStreaming: opts.nativeStreaming,
    servedVariantId: opts.servedVariantId ?? null,
    activeExecutionProvider: opts.activeExecutionProvider ?? null,
  };
}
