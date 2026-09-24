import { describe, expect, it } from 'vitest';
import {
  buildModelIndex,
  buildCachedModelIndex,
  isCachedModel,
  isLocalCatalogEntry,
  resolveModelId,
  stripVersion,
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
    // An explicit version that is not cached is not served by another version; only the
    // versionless id falls back to the highest cached one.
    expect(resolveModelId(index, 'cached-model-cpu:999')).toBeNull();
    expect(resolveModelId(index, 'cached-model-cpu')).toEqual({
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

const models = [
  {
    alias: 'qwen3-0.6b',
    variants: [
      { id: 'qwen3-0.6b-generic-cpu:3', cached: true },
      { id: 'qwen3-0.6b-generic-cpu:4', cached: true },
      { id: 'qwen3-0.6b-generic-cpu:5', cached: false },
      { id: 'qwen3-0.6b-cuda-gpu:4', cached: true },
    ],
  },
  { alias: 'not-downloaded', variants: [{ id: 'not-downloaded-generic-cpu:1', cached: false }] },
];

describe('model registry BYOM', () => {
  it('keeps an alias distinct from its same-named versioned variant, in any casing', () => {
    const index = buildModelIndex([
      { alias: 'Local-Model', variants: [{ id: 'local-model:1', cached: true }] },
    ]);
    expect(resolveModelId(index, 'local-model')).toEqual({ alias: 'Local-Model', variantId: null });
    expect(resolveModelId(index, 'LOCAL-MODEL:1')).toEqual({ alias: 'Local-Model', variantId: 'local-model:1' });
    expect(resolveModelId(index, 'local-model:999')).toBeNull();
  });
});

describe('model registry', () => {
  const index = buildModelIndex(models);

  it('resolves an alias with no variant pinned', () => {
    expect(resolveModelId(index, 'qwen3-0.6b')).toEqual({ alias: 'qwen3-0.6b', variantId: null });
  });

  it('resolves an exact cached variant id to itself', () => {
    expect(resolveModelId(index, 'qwen3-0.6b-generic-cpu:3')?.variantId).toBe('qwen3-0.6b-generic-cpu:3');
    expect(resolveModelId(index, 'qwen3-0.6b-cuda-gpu:4')?.variantId).toBe('qwen3-0.6b-cuda-gpu:4');
  });

  it('resolves a versionless id to the highest cached version', () => {
    expect(resolveModelId(index, 'qwen3-0.6b-generic-cpu')?.variantId).toBe('qwen3-0.6b-generic-cpu:4');
  });

  it('ignores case and surrounding whitespace, keeping the catalog spelling in the result', () => {
    expect(resolveModelId(index, 'QWEN3-0.6B-GENERIC-CPU:4')?.variantId).toBe('qwen3-0.6b-generic-cpu:4');
    expect(resolveModelId(index, '  Qwen3-0.6b ')).toEqual({ alias: 'qwen3-0.6b', variantId: null });
  });

  it('does not substitute another version for an explicit one that is not cached', () => {
    expect(resolveModelId(index, 'qwen3-0.6b-generic-cpu:999')).toBeNull();
    expect(resolveModelId(index, 'qwen3-0.6b-generic-cpu:5')).toBeNull();
  });

  it('never resolves a model with no cached variant', () => {
    expect(resolveModelId(index, 'not-downloaded')).toBeNull();
    expect(resolveModelId(index, 'not-downloaded-generic-cpu')).toBeNull();
    expect(resolveModelId(index, 'not-downloaded-generic-cpu:1')).toBeNull();
  });

  it('returns null for unknown, blank, or non-string input', () => {
    expect(resolveModelId(index, 'unrelated')).toBeNull();
    expect(resolveModelId(index, '   ')).toBeNull();
    expect(resolveModelId(index, 42)).toBeNull();
    expect(buildModelIndex(null).size).toBe(0);
  });

  it('strips only a trailing numeric version', () => {
    expect(stripVersion('a-b:4')).toBe('a-b');
    expect(stripVersion('a-b')).toBe('a-b');
    expect(stripVersion('a:b:12')).toBe('a:b');
  });
});
