import { describe, expect, it, vi } from 'vitest';
import {
  applyPreferredExecutionProvider,
  assertAcceleratorRegistrationSucceeded,
} from './execution-provider.js';

describe('applyPreferredExecutionProvider', () => {
  it('reports an unsupported preference without failing startup', async () => {
    const result = await applyPreferredExecutionProvider({
      preferredEp: 'CUDAExecutionProvider',
      manager: {},
      model: {},
      log: vi.fn(),
    });

    expect(result).toEqual({
      requested: 'CUDAExecutionProvider',
      applied: null,
      method: null,
    });
  });

  describe('assertAcceleratorRegistrationSucceeded', () => {
    it('rejects a resolved failure result', () => {
      expect(() => assertAcceleratorRegistrationSucceeded({
        success: false,
        failedEps: [{ name: 'CUDAExecutionProvider' }],
      })).toThrow('CUDAExecutionProvider');
    });

    it('accepts successful and unspecified results', () => {
      expect(() => assertAcceleratorRegistrationSucceeded({ success: true })).not.toThrow();
      expect(() => assertAcceleratorRegistrationSucceeded(undefined)).not.toThrow();
    });
  });

  it('throws when every supported preference setter rejects', async () => {
    await expect(applyPreferredExecutionProvider({
      preferredEp: 'CUDAExecutionProvider',
      manager: {
        setPreferredExecutionProvider: () => {
          throw new Error('CUDA unavailable');
        },
      },
      log: vi.fn(),
    })).rejects.toThrow('CUDA unavailable');
  });

  it('uses a later supported setter when an earlier setter rejects', async () => {
    const later = vi.fn();

    const result = await applyPreferredExecutionProvider({
      preferredEp: 'CUDAExecutionProvider',
      manager: {
        setPreferredExecutionProvider: () => {
          throw new Error('first rejected');
        },
      },
      model: { setPreferredEp: later },
      log: vi.fn(),
    });

    expect(later).toHaveBeenCalledWith('CUDAExecutionProvider');
    expect(result.applied).toBe('CUDAExecutionProvider');
    expect(result.method).toBe('setPreferredEp');
  });
});
