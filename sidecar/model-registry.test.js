import { describe, expect, it } from 'vitest';
import { buildModelIndex, resolveModelId, stripVersion } from './model-registry.js';

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
