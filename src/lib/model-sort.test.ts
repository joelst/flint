import { describe, it, expect } from 'vitest';
import { sortModels, compareModels, modelUpdatedAt, isModelSortMode } from './model-sort';

const models = [
  { alias: 'qwen3-1.7b', family: 'Qwen', createdAt: 1_700_000_000 },
  { alias: 'phi-4-mini', family: 'Phi', createdAt: 1_750_000_000 },
  { alias: 'deepseek-r1', family: 'Qwen', createdAt: 1_720_000_000 },
  { alias: 'my-import', createdAt: null },
];

describe('sortModels', () => {
  it('orders by alias for name mode', () => {
    expect(sortModels(models, 'name').map(m => m.alias))
      .toEqual(['deepseek-r1', 'my-import', 'phi-4-mini', 'qwen3-1.7b']);
  });

  it('groups by family and orders by alias inside a family', () => {
    expect(sortModels(models, 'family').map(m => m.alias))
      .toEqual(['phi-4-mini', 'deepseek-r1', 'qwen3-1.7b', 'my-import']);
  });

  it('puts models with no family last rather than first', () => {
    expect(sortModels(models, 'family').at(-1)?.alias).toBe('my-import');
  });

  it('orders newest first for updated mode, undated last', () => {
    expect(sortModels(models, 'updated').map(m => m.alias))
      .toEqual(['phi-4-mini', 'deepseek-r1', 'qwen3-1.7b', 'my-import']);
  });

  it('does not mutate the input array', () => {
    const input = [...models];
    sortModels(input, 'updated');
    expect(input.map(m => m.alias)).toEqual(models.map(m => m.alias));
  });

  it('breaks ties by alias so refreshes do not reshuffle the list', () => {
    const tied = [
      { alias: 'b-model', family: 'Qwen', createdAt: 100 },
      { alias: 'a-model', family: 'Qwen', createdAt: 100 },
    ];
    for (const mode of ['name', 'family', 'updated'] as const) {
      expect(sortModels(tied, mode).map(m => m.alias), mode).toEqual(['a-model', 'b-model']);
    }
  });

  it('tolerates missing alias and family without throwing', () => {
    expect(() => sortModels([{}, { alias: 'x' }] as any, 'family')).not.toThrow();
  });
});

describe('modelUpdatedAt', () => {
  it('reads createdAt from the model or its info block', () => {
    expect(modelUpdatedAt({ createdAt: 5 })).toBe(5);
    expect(modelUpdatedAt({ info: { createdAt: 7 } })).toBe(7);
  });

  it('treats a missing or non-finite date as oldest', () => {
    expect(modelUpdatedAt({})).toBe(0);
    expect(modelUpdatedAt({ createdAt: NaN })).toBe(0);
    expect(modelUpdatedAt({ createdAt: '2024-01-01' })).toBe(0);
  });
});

describe('compareModels', () => {
  it('is symmetric in sign', () => {
    const a = { alias: 'a', family: 'X', createdAt: 1 };
    const b = { alias: 'b', family: 'Y', createdAt: 2 };
    for (const mode of ['name', 'family', 'updated'] as const) {
      expect(Math.sign(compareModels(a, b, mode))).toBe(-Math.sign(compareModels(b, a, mode)));
    }
  });
});

describe('isModelSortMode', () => {
  it('accepts the three supported modes and nothing else', () => {
    expect(['name', 'family', 'updated'].every(isModelSortMode)).toBe(true);
    expect(isModelSortMode('size')).toBe(false);
    expect(isModelSortMode(null)).toBe(false);
  });
});
