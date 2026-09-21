import type { CompareResult } from './comparison-history';
import { usageFromChatCompletion } from './chat-usage';

export type CompareSlotError = {
  certainty?: string;
  cmd?: string;
  message?: string;
};

export type CompareSlotErrorKind = 'pre-dispatch-stop' | 'prep-stop' | 'failed';

/**
 * Only `cancelBeforeDispatch()` proves the timed request was never written.
 * Sidecar `certainty: 'cancelled'` also covers drain of an already-dispatched call.
 * Stop during download/load is "never reached inference". Any other cancel is a failure.
 */
export function classifyCompareSlotError(opts: {
  stopRequested: boolean;
  error: CompareSlotError;
  inferenceStarted: number | null;
  preDispatchCancelled?: boolean;
}): CompareSlotErrorKind {
  if (opts.preDispatchCancelled) return 'pre-dispatch-stop';
  const cancelled = opts.error.certainty === 'cancelled';
  if (cancelled && opts.stopRequested) {
    if (opts.error.cmd === 'chatCompletion' && opts.inferenceStarted != null) {
      return 'failed';
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
  partialContent?: string,
): CompareResult {
  const message = error.message || String(error);
  const prefix = `[Error] ${message}`;
  const content = partialContent ? `${partialContent}\n\n${prefix}` : prefix;
  return {
    content,
    latencyMs: elapsedMs(inferenceStarted, now),
    error: message,
    rating: null,
    status: 'failed',
  };
}

/** Wall-clock deltas can go negative if the system clock steps backward. */
function elapsedMs(started: number | null, ended: number): number | undefined {
  if (started == null) return undefined;
  const delta = ended - started;
  if (!Number.isFinite(delta)) return undefined;
  return delta < 0 ? 0 : delta;
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
  const usage = usageFromChatCompletion(opts.usage);
  return {
    content: opts.content,
    latencyMs: opts.stopRequested ? undefined : elapsedMs(opts.inferenceStarted, opts.now),
    tokensIn: usage?.promptTokens,
    tokensOut: usage?.completionTokens,
    rating: null,
    status: opts.stopRequested ? 'stopped' : 'completed',
    ttftMs:
      opts.nativeStreaming && opts.firstDeltaAt != null
        ? elapsedMs(opts.inferenceStarted, opts.firstDeltaAt)
        : undefined,
    nativeStreaming: opts.nativeStreaming,
    servedVariantId: opts.servedVariantId ?? null,
    activeExecutionProvider: opts.activeExecutionProvider ?? null,
  };
}
