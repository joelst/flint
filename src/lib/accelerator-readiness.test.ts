import { describe, expect, it } from 'vitest';
import { evaluateStartupPreload } from './accelerator-readiness';

const partialReadiness = {
  generation: 1,
  registration: {
    success: false,
    status: 'CUDA failed; QNN registered',
    registeredEps: ['QNNExecutionProvider'],
    failedEps: ['CUDAExecutionProvider'],
  },
  providers: [
    { name: 'CPUExecutionProvider', isRegistered: true },
    { name: 'QNNExecutionProvider', isRegistered: true },
    { name: 'CUDAExecutionProvider', isRegistered: false },
  ],
};

const model = {
  alias: 'example',
  variants: [
    { id: 'example-generic-cpu:1', executionProvider: 'generic' },
    { id: 'example-cuda-gpu:1', executionProvider: 'CUDA' },
    { id: 'example-qnn-npu:1', executionProvider: 'QNN' },
    { id: 'example-dml-gpu:1', executionProvider: 'DirectML' },
  ],
};

describe('evaluateStartupPreload', () => {
  it('allows alias-only loads for runtime provider resolution', () => {
    expect(evaluateStartupPreload(model, null, partialReadiness).allowed).toBe(true);
  });

  it('allows CPU and successfully registered accelerator variants', () => {
    expect(evaluateStartupPreload(
      model,
      'example-generic-cpu:1',
      partialReadiness,
    ).allowed).toBe(true);
    expect(evaluateStartupPreload(
      model,
      'example-qnn-npu:1',
      partialReadiness,
    ).allowed).toBe(true);
  });

  it('blocks an explicit variant whose provider failed registration', () => {
    expect(evaluateStartupPreload(
      model,
      'example-cuda-gpu:1',
      partialReadiness,
    )).toEqual({
      allowed: false,
      requiredProvider: 'CUDA',
      reason: 'example requires CUDA, which is not registered',
    });
  });

  it('normalizes DirectML and DML provider names', () => {
    const readiness = {
      generation: 1,
      registration: null,
      providers: [{ name: 'DmlExecutionProvider', isRegistered: true }],
    };
    expect(evaluateStartupPreload(
      model,
      'example-dml-gpu:1',
      readiness,
    ).allowed).toBe(true);
  });

  it('does not invent a requirement when variant metadata is unavailable', () => {
    expect(evaluateStartupPreload(
      model,
      'missing-variant',
      partialReadiness,
    ).allowed).toBe(true);
  });
});
