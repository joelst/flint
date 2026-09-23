import { describe, expect, it } from 'vitest';
import { buildCachedModelIndex, resolveModelId } from './model-registry.js';

describe('buildCachedModelIndex', () => {
  it('resolves cached aliases and versioned or bare variant ids', () => {
    const index = buildCachedModelIndex([
      { alias: 'gemma-4-e2b-it', id: 'gemma-4-e2b-it-cuda-gpu:3' },
      { alias: 'gemma-4-e2b-it', id: 'gemma-4-e2b-it-generic-cpu:3' },
    ]);

    expect(resolveModelId(index, 'gemma-4-e2b-it')).toEqual({
      alias: 'gemma-4-e2b-it',
      variantId: null,
    });
    expect(resolveModelId(index, 'gemma-4-e2b-it-cuda-gpu:3')).toEqual({
      alias: 'gemma-4-e2b-it',
      variantId: 'gemma-4-e2b-it-cuda-gpu:3',
    });
    expect(resolveModelId(index, 'gemma-4-e2b-it-cuda-gpu')).toEqual({
      alias: 'gemma-4-e2b-it',
      variantId: 'gemma-4-e2b-it-cuda-gpu:3',
    });
  });

  it('does not resolve models absent from the cached-only inventory', () => {
    const index = buildCachedModelIndex([
      { alias: 'cached-model', id: 'cached-model-cpu:1' },
    ]);

    expect(resolveModelId(index, 'uncached-model')).toBeNull();
  });

  it('skips a cached row whose native-backed getters throw', () => {
    const unreadable = {
      get alias() {
        throw new Error('native getter failed');
      },
    };
    const index = buildCachedModelIndex([
      unreadable,
      { alias: 'usable-model', id: 'usable-model-cpu:1' },
    ]);

    expect(resolveModelId(index, 'usable-model')).toEqual({
      alias: 'usable-model',
      variantId: null,
    });
  });
});
