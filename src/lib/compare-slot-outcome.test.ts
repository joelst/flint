import { describe, expect, it } from 'vitest';
import {
  buildFailedCompareResult,
  buildSettledCompareResult,
  buildStoppedPreDispatchResult,
  classifyCompareSlotError,
} from './compare-slot-outcome';

describe('classifyCompareSlotError', () => {
  it('treats a Stop of the timed chatCompletion before dispatch as pre-dispatch-stop', () => {
    expect(
      classifyCompareSlotError({
        stopRequested: true,
        error: { certainty: 'cancelled', cmd: 'chatCompletion', message: 'cancelled' },
        inferenceStarted: 1000,
      }),
    ).toBe('pre-dispatch-stop');
  });

  it('treats a Stop during download/load as prep-stop, not a user-visible failure', () => {
    expect(
      classifyCompareSlotError({
        stopRequested: true,
        error: { certainty: 'cancelled', cmd: 'download', message: 'cancelled' },
        inferenceStarted: null,
      }),
    ).toBe('prep-stop');
  });

  it('treats runtime-drain cancellation as a failure even for chatCompletion', () => {
    expect(
      classifyCompareSlotError({
        stopRequested: false,
        error: { certainty: 'cancelled', cmd: 'chatCompletion', message: 'Runtime is draining' },
        inferenceStarted: 1000,
      }),
    ).toBe('failed');
  });

  it('treats a genuine load/inference error as failed', () => {
    expect(
      classifyCompareSlotError({
        stopRequested: true,
        error: { cmd: 'load', message: 'out of memory' },
        inferenceStarted: null,
      }),
    ).toBe('failed');
  });
});

describe('compare slot result builders', () => {
  it('omits latency on a pre-dispatch Stop', () => {
    expect(buildStoppedPreDispatchResult()).toEqual({
      content: '[Stopped] Cancelled before it was sent to the model.',
      rating: null,
      status: 'stopped',
    });
  });

  it('records inference wait as latency only on a real failure after dispatch', () => {
    expect(buildFailedCompareResult({ message: 'boom' }, 1000, 1250)).toEqual({
      content: '[Error] boom',
      latencyMs: 250,
      error: 'boom',
      rating: null,
      status: 'failed',
    });
    expect(buildFailedCompareResult({ message: 'boom' }, null, 1250).latencyMs).toBeUndefined();
  });

  it('records usage and TTFT on a completed native stream, and omits drain time when stopped', () => {
    const completed = buildSettledCompareResult({
      content: 'hello',
      stopRequested: false,
      inferenceStarted: 1000,
      now: 1400,
      nativeStreaming: true,
      firstDeltaAt: 1080,
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      servedVariantId: 'v1',
      activeExecutionProvider: 'CPUExecutionProvider',
    });
    expect(completed).toMatchObject({
      content: 'hello',
      latencyMs: 400,
      tokensIn: 3,
      tokensOut: 2,
      status: 'completed',
      ttftMs: 80,
      nativeStreaming: true,
    });

    const stopped = buildSettledCompareResult({
      content: 'hel',
      stopRequested: true,
      inferenceStarted: 1000,
      now: 5000,
      nativeStreaming: true,
      firstDeltaAt: 1080,
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    expect(stopped.latencyMs).toBeUndefined();
    expect(stopped.status).toBe('stopped');
    expect(stopped.tokensOut).toBe(1);
    expect(stopped.ttftMs).toBe(80);
  });
});
