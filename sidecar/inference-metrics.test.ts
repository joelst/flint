import { describe, expect, it } from 'vitest';
import { buildInferenceMetrics } from './inference-metrics.js';

describe('buildInferenceMetrics', () => {
  it('reports observable timing, rates, identity, and warm state', () => {
    expect(buildInferenceMetrics({
      startedAt: 1000,
      loadMs: 200,
      firstTokenAt: 1500,
      completedAt: 2500,
      tokensIn: 60,
      tokensOut: 100,
      variantId: 'model-gpu',
      executionProvider: 'CUDAExecutionProvider',
      warm: false,
    })).toEqual({
      durationMs: 1500,
      loadMs: 200,
      ttftMs: 500,
      promptTokensPerSecond: 200,
      decodeTokensPerSecond: 100,
      tokensIn: 60,
      tokensOut: 100,
      variantId: 'model-gpu',
      executionProvider: 'CUDAExecutionProvider',
      warm: false,
    });
  });

  it('leaves unavailable timing-derived rates unknown', () => {
    expect(buildInferenceMetrics({
      startedAt: 1000,
      completedAt: 2000,
      tokensIn: 10,
      tokensOut: 20,
      warm: true,
    })).toMatchObject({
      durationMs: 1000,
      loadMs: null,
      ttftMs: null,
      promptTokensPerSecond: null,
      decodeTokensPerSecond: null,
      warm: true,
    });
  });

  it('rejects invalid or negative timing through null/clamped values', () => {
    expect(buildInferenceMetrics({
      startedAt: 2000,
      loadMs: -5,
      firstTokenAt: 1000,
      completedAt: 1500,
      tokensIn: -1,
      tokensOut: '20',
    })).toMatchObject({
      durationMs: 0,
      loadMs: 0,
      ttftMs: 0,
      tokensIn: null,
      tokensOut: null,
      promptTokensPerSecond: null,
      decodeTokensPerSecond: null,
    });
  });
});
