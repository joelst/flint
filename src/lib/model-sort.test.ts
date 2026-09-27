import { describe, it, expect } from 'vitest';
import {
  sortModels,
  compareModels,
  deriveModelFamily,
  modelFamilyLabel,
  modelMatchesSearch,
  modelUpdatedAt,
  isModelSortMode,
} from './model-sort';

const models = [
  { alias: 'qwen3-1.7b', family: 'Qwen', createdAt: 1_700_000_000 },
  { alias: 'phi-4-mini', family: 'Phi', createdAt: 1_750_000_000 },
  { alias: 'deepseek-r1', family: 'Qwen', createdAt: 1_720_000_000 },
  { alias: '', createdAt: null },
];

describe('sortModels', () => {
  it('orders by alias for name mode', () => {
    expect(sortModels(models, 'name').map(m => m.alias))
      .toEqual(['', 'deepseek-r1', 'phi-4-mini', 'qwen3-1.7b']);
  });

  it('groups by family and orders by alias inside a family', () => {
    expect(sortModels(models, 'family').map(m => m.alias))
      .toEqual(['phi-4-mini', 'deepseek-r1', 'qwen3-1.7b', '']);
  });

  it('puts models with no family last rather than first', () => {
    expect(sortModels(models, 'family').at(-1)?.alias).toBe('');
  });

  it('orders newest first for updated mode, undated last', () => {
    expect(sortModels(models, 'updated').map(m => m.alias))
      .toEqual(['phi-4-mini', 'deepseek-r1', 'qwen3-1.7b', '']);
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

  describe('derived family behavior', () => {
    it('derives a useful family only when catalog metadata is missing', () => {
      expect(deriveModelFamily('qwen2.5-coder-7b-instruct')).toBe('qwen2.5-coder');
      expect(deriveModelFamily('whisper-large-v3-turbo')).toBe('whisper');
      expect(modelFamilyLabel({ alias: 'qwen2.5-coder-7b', family: 'Qwen Coder' }))
        .toBe('qwen coder');
    });

    it('keeps family search additive to alias search', () => {
      const model = { alias: 'qwen2.5-coder-7b' };
      expect(modelMatchesSearch(model, '7b')).toBe(true);
      expect(modelMatchesSearch(model, 'qwen2.5-coder')).toBe(true);
      expect(modelMatchesSearch(model, 'phi')).toBe(false);
    });

    it('groups models with missing catalog families by their derived alias family', () => {
      const aliases = sortModels(
        [
          { alias: 'qwen2.5-coder-14b' },
          { alias: 'phi-4-mini' },
          { alias: 'qwen2.5-coder-7b' },
        ],
        'family',
      ).map((model) => model.alias);
      expect(aliases).toEqual(['phi-4-mini', 'qwen2.5-coder-7b', 'qwen2.5-coder-14b']);
    });
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

  // A 0 for two labels that are not the same string makes the order depend on input
  // sequence, which is what splits family headings and reshuffles the list on refresh.
  it.each([
    { name: 'zero-padded family', mode: 'family' as const, a: { alias: 'a', family: 'phi-4' }, b: { alias: 'b', family: 'phi-04' } },
    { name: 'zero-padded alias', mode: 'name' as const, a: { alias: 'Model-1' }, b: { alias: 'model-01' } },
    { name: 'case-only alias', mode: 'name' as const, a: { alias: 'x' }, b: { alias: 'X' } },
  ])('never ties distinct labels ($name)', ({ mode, a, b }) => {
    expect(compareModels(a, b, mode)).not.toBe(0);
    expect(Math.sign(compareModels(a, b, mode))).toBe(-Math.sign(compareModels(b, a, mode)));
  });

  it('keeps one heading per family regardless of input order', () => {
    const models = [
      { alias: 'p-b', family: 'phi-4' },
      { alias: 'p-a', family: 'phi-04' },
      { alias: 'p-c', family: 'phi-4' },
    ];
    const orders = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1]].map((permutation) =>
      sortModels(permutation.map((index) => models[index]), 'family').map((m) => m.family),
    );

    for (const order of orders) expect(order).toEqual(orders[0]);

    // The page emits a heading whenever the label differs from the previous row, so
    // equal labels must be adjacent or the same family is titled more than once.
    const headings = orders[0].filter((family, index) => index === 0 || orders[0][index - 1] !== family);
    expect(headings).toEqual(['phi-04', 'phi-4']);
  });

  it('still orders numerically rather than lexically', () => {
    expect(
      sortModels([{ alias: 'phi-10' }, { alias: 'phi-9' }, { alias: 'phi-2' }], 'name').map((m) => m.alias),
    ).toEqual(['phi-2', 'phi-9', 'phi-10']);
  });
});

describe('isModelSortMode', () => {
  it('accepts the three supported modes and nothing else', () => {
    expect(['name', 'family', 'updated'].every(isModelSortMode)).toBe(true);
    expect(isModelSortMode('size')).toBe(false);
    expect(isModelSortMode(null)).toBe(false);
  });
});

describe('modelFamilyLabel without catalog metadata', () => {
  it.each([
    ['phi-4', 'phi-4-mini', 'phi-4'],
    ['deepseek-r1', 'deepseek-r1-distill-qwen-7b', 'deepseek-r1'],
  ])('groups the bare alias %s with its sibling %s', (base, sibling, family) => {
    // Dropping a derived family because nothing was stripped put the bare alias under
    // "Other" while its own variant headed a group of the same name.
    expect([base, sibling].map((alias) => modelFamilyLabel({ alias }))).toEqual([
      family,
      family,
    ]);
  });

  it.each([
    ['gemma', 'gemma'],
    ['mistral', 'mistral'],
    ['my-import', 'my-import'],
  ])('labels %s with its own name', (alias, expected) => {
    expect(modelFamilyLabel({ alias })).toBe(expected);
  });

  it.each(['mini', 'mini-chat', '7b', 'v3', '123', '', '   '])(
    'leaves the descriptor-only alias %s unlabelled',
    (alias) => {
      // `mini` describes a size, so heading a group with it would invent a family.
      expect(modelFamilyLabel({ alias })).toBe('');
    },
  );

  it('still prefers catalog metadata, nested or not', () => {
    expect(modelFamilyLabel({ alias: 'phi-4', family: 'Phi' })).toBe('phi');
    expect(modelFamilyLabel({ alias: 'phi-4', info: { family: 'Phi' } })).toBe('phi');
  });

  it('renders one heading per family however the list arrives', () => {
    const roster = [
      { alias: 'phi-4' },
      { alias: 'deepseek-r1-distill-qwen-7b' },
      { alias: 'phi-4-mini' },
      { alias: 'deepseek-r1' },
      { alias: '' },
    ];
    for (const order of [roster, [...roster].reverse(), [...roster].sort((a, b) => a.alias < b.alias ? 1 : -1)]) {
      const labels = sortModels(order, 'family').map((m) => modelFamilyLabel(m));
      // The page emits a heading whenever the label differs from the previous row.
      const headings = labels.filter((label, i) => label !== labels[i - 1]).map((l) => l || 'Other');
      expect(headings).toEqual(['deepseek-r1', 'phi-4', 'Other']);
    }
  });
});
