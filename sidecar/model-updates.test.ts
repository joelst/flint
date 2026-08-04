import { describe, expect, it } from 'vitest';
import { annotateVariantUpdates } from './model-updates.js';

describe('annotateVariantUpdates', () => {
  it('finds updates within the same acceleration-specific model track', () => {
    const variants = annotateVariantUpdates([
      {
        id: 'model-cuda-gpu:1',
        name: 'model-cuda-gpu',
        version: 1,
        cached: true,
        deviceType: 'GPU',
        executionProvider: 'CUDA',
      },
      {
        id: 'model-cuda-gpu:2',
        name: 'model-cuda-gpu',
        version: 2,
        cached: false,
        deviceType: 'GPU',
        executionProvider: 'CUDA',
      },
      {
        id: 'model-cpu:3',
        name: 'model-cpu',
        version: 3,
        cached: false,
        deviceType: 'CPU',
        executionProvider: 'CPU',
      },
    ]);

    expect(variants[0].update).toEqual({
      currentVersion: 1,
      latestVersion: 2,
      latestVariantId: 'model-cuda-gpu:2',
      deviceType: 'GPU',
      executionProvider: 'CUDA',
    });
    expect(variants[2].update).toBeNull();
  });

  it('does not notify when the latest compatible variant is already cached', () => {
    const variants = annotateVariantUpdates([
      { id: 'model-qnn-npu:1', name: 'model-qnn-npu', version: 1, cached: true },
      { id: 'model-qnn-npu:2', name: 'model-qnn-npu', version: 2, cached: true },
    ]);

    expect(variants.every((variant) => variant.update === null)).toBe(true);
  });

  it('uses runtime metadata as a compatibility fallback when name is unavailable', () => {
    const variants = annotateVariantUpdates([
      {
        id: 'old',
        version: 4,
        cached: true,
        deviceType: 'GPU',
        executionProvider: 'DirectML',
      },
      {
        id: 'new',
        version: 5,
        cached: false,
        deviceType: 'GPU',
        executionProvider: 'DirectML',
      },
      {
        id: 'npu',
        version: 9,
        cached: false,
        deviceType: 'NPU',
        executionProvider: 'QNN',
      },
    ]);

    expect(variants[0].update?.latestVariantId).toBe('new');
    expect(variants[2].update).toBeNull();
  });
});
