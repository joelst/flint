import { describe, expect, it } from 'vitest';
import {
  buildCachedModelIndex,
  isCachedModel,
  isLocalCatalogEntry,
  resolveModelId,
} from './model-registry.js';

describe('isCachedModel', () => {
  it('reads the native getter and falls back to the info snapshot only when it throws', () => {
    expect(isCachedModel({ isCached: true })).toBe(true);
    expect(isCachedModel({ isCached: false, info: { cached: true } })).toBe(false);
    expect(isCachedModel({
      get isCached() { throw new Error('native getter failed'); },
      info: { cached: true },
    })).toBe(true);
    expect(isCachedModel({ get isCached() { throw new Error('native getter failed'); } })).toBe(false);
    expect(isCachedModel(null)).toBe(false);
  });
});

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

  describe('isLocalCatalogEntry', () => {
    it('recognizes only local catalog URIs', () => {
      expect(isLocalCatalogEntry({ info: { uri: 'local://custom-model' } })).toBe(true);
      expect(isLocalCatalogEntry({ info: { uri: 'azureml://registry/model' } })).toBe(false);
      expect(isLocalCatalogEntry({ info: {} })).toBe(false);
      expect(isLocalCatalogEntry(null)).toBe(false);
    });
  });

  it('does not resolve models absent from the cached-only inventory', () => {
    const index = buildCachedModelIndex([
      { alias: 'cached-model', id: 'cached-model-cpu:1' },
    ]);

    expect(resolveModelId(index, 'uncached-model')).toBeNull();
    expect(resolveModelId(index, 'cached-model:999')).toBeNull();
    expect(resolveModelId(index, 'cached-model-cpu:999')).toEqual({
      alias: 'cached-model',
      variantId: 'cached-model-cpu:1',
    });
  });

  it('keeps a BYOM alias distinct from its same-named versioned variant', () => {
    const index = buildCachedModelIndex([
      { alias: 'local-model', id: 'local-model:1' },
    ]);

    expect(resolveModelId(index, 'local-model')).toEqual({
      alias: 'local-model',
      variantId: null,
    });
    expect(resolveModelId(index, 'local-model:1')).toEqual({
      alias: 'local-model',
      variantId: 'local-model:1',
    });
    expect(resolveModelId(index, 'local-model:999')).toBeNull();
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
