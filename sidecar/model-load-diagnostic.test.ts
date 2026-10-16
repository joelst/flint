import { describe, expect, it, vi } from 'vitest';
import { cudaAllocatorDiagnostic, loadModelWithDiagnostic } from './model-load-diagnostic.js';

const ALLOCATOR_ERROR = 'genai_model_instance.cc:204 failed to load model smollm3-3b-cuda-gpu:1: ' +
  'Failed to create allocator for CUDA: No requested allocator available';

describe('CUDA allocator diagnostic', () => {
  it('recognizes the native signature and gives conditional recovery advice', () => {
    const diagnostic = cudaAllocatorDiagnostic(ALLOCATOR_ERROR);
    expect(diagnostic).toContain('CUDA could not initialize a GPU allocator');
    expect(diagnostic).toContain('error does not establish which');
    expect(diagnostic).toContain('Recheck Providers');
    expect(diagnostic).toContain('If multiple NVIDIA GPUs are present');
    expect(diagnostic).toContain('CUDA GPU');
    expect(diagnostic).toContain('CUDA_VISIBLE_DEVICES=0');
    expect(diagnostic).toContain('downloaded CPU variant');
    expect(diagnostic).toContain('has not retried or switched devices automatically');
  });

  it('tolerates case and whitespace differences', () => {
    expect(cudaAllocatorDiagnostic('FAILED TO CREATE ALLOCATOR FOR cuda:\n No requested allocator available'))
      .not.toBeNull();
  });

  it.each([
    '',
    'CUDA out of memory',
    'No requested allocator available',
    'Failed to create allocator for CPU: No requested allocator available',
    'Failed to create allocator for CUDA: other failure',
    'Model not found',
  ])('does not diagnose unrelated failures: %s', (detail) => {
    expect(cudaAllocatorDiagnostic(detail)).toBeNull();
  });
});

describe('loadModelWithDiagnostic', () => {
  it('loads once without changing a successful outcome', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    await expect(loadModelWithDiagnostic({ load })).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([new Error(ALLOCATOR_ERROR), ALLOCATOR_ERROR])(
    'preserves the original failure without retrying',
    async (cause) => {
      const load = vi.fn().mockRejectedValue(cause);
      await expect(loadModelWithDiagnostic({ load })).rejects.toMatchObject({
        message: `${cudaAllocatorDiagnostic(ALLOCATOR_ERROR)}\nRuntime detail: ${ALLOCATOR_ERROR}`,
        cause,
      });
      expect(load).toHaveBeenCalledTimes(1);
    },
  );

  it('rethrows unrelated errors unchanged', async () => {
    const error = new Error('CUDA out of memory');
    await expect(loadModelWithDiagnostic({ load: async () => { throw error; } })).rejects.toBe(error);
  });
});
