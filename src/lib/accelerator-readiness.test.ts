import { describe, expect, it } from 'vitest';
import {
  evaluateStartupPreload,
  hasRegisteredAccelerator,
  publishedAccelerationLabels,
} from './accelerator-readiness';

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

describe('publishedAccelerationLabels', () => {
  it('lists only device builds the catalog publishes', () => {
    expect(publishedAccelerationLabels([
      { id: 'gemma-4-e2b-it-generic-cpu:3', deviceType: 'CPU', executionProvider: 'generic' },
    ])).toEqual(['CPU']);
    expect(publishedAccelerationLabels([
      { id: 'example-generic-cpu:1', executionProvider: 'generic' },
      { id: 'example-cuda-gpu:1', deviceType: 'GPU', executionProvider: 'CUDA' },
      { id: 'example-qnn-npu:1', executionProvider: 'QNN' },
    ])).toEqual(['GPU', 'CPU', 'NPU']);
  });

  it('does not invent a GPU build when the only variant is CPU', () => {
    expect(publishedAccelerationLabels([
      { id: 'gemma-4-e2b-it-generic-cpu:3' },
    ])).toEqual(['CPU']);
  });

  it('lets the execution provider override a CPU-looking id when deviceType is absent', () => {
    expect(publishedAccelerationLabels([
      { id: 'model-generic-cpu:1', executionProvider: 'DmlExecutionProvider' },
      { id: 'model-generic-cpu:2', executionProvider: 'CUDAExecutionProvider' },
      { id: 'model-cpu:3', executionProvider: 'WebGpuExecutionProvider' },
    ])).toEqual(['GPU']);
    expect(publishedAccelerationLabels([
      { id: 'model-generic-cpu:4', executionProvider: 'QNNExecutionProvider' },
      { id: 'model-generic-cpu:5', executionProvider: 'VitisAIExecutionProvider' },
    ])).toEqual(['NPU']);
  });

  it('classifies device-qualified OpenVINO builds without treating generic OpenVINO as GPU', () => {
    expect(publishedAccelerationLabels([
      { id: 'example-openvino-gpu:1', executionProvider: 'OpenVINO' },
      { id: 'example-openvino-cpu:1', executionProvider: 'OpenVINO' },
    ])).toEqual(['GPU', 'CPU']);
    expect(publishedAccelerationLabels([
      { id: 'example-openvino:1', executionProvider: 'OpenVINO' },
    ])).toEqual([]);
  });
});

describe('evaluateStartupPreload', () => {
  it('allows alias-only loads for runtime provider resolution', () => {
    expect(evaluateStartupPreload(model, null, partialReadiness).allowed).toBe(true);
  });

  describe('hasRegisteredAccelerator', () => {
    it('does not count the CPU provider as hardware acceleration', () => {
      expect(hasRegisteredAccelerator([
        { name: 'CPUExecutionProvider', isRegistered: true },
        { name: 'CUDAExecutionProvider', isRegistered: false },
      ])).toBe(false);
    });

    it('requires a registered non-CPU provider', () => {
      expect(hasRegisteredAccelerator([
        { name: 'CPUExecutionProvider', isRegistered: true },
        { name: 'QNNExecutionProvider', isRegistered: true },
      ])).toBe(true);
    });
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
