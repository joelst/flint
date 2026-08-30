import { describe, it, expect } from 'vitest';
import {
  deriveModelFamily,
  modelFamilyLabel,
  sortModels,
  modelMatchesSearch,
  isModelSortKey,
} from './model-sort';

describe('deriveModelFamily', () => {
  it('strips parameter-size suffixes', () => {
    expect(deriveModelFamily('qwen2.5-coder-7b')).toBe('qwen2.5-coder');
    expect(deriveModelFamily('qwen3-0.6b')).toBe('qwen3');
    expect(deriveModelFamily('nemotron-speech-streaming-en-0.6b')).toBe('nemotron-speech-streaming-en');
  });

  it('strips variant and version suffixes', () => {
    expect(deriveModelFamily('whisper-large-v3-turbo')).toBe('whisper');
    expect(deriveModelFamily('phi-4-mini-reasoning')).toBe('phi-4');
    expect(deriveModelFamily('mistral-7b-v0.2')).toBe('mistral');
    expect(deriveModelFamily('ministral-3-3b-instruct-2512')).toBe('ministral-3');
  });

  it('groups real catalog aliases into shared families', () => {
    const whisper = ['whisper-base', 'whisper-tiny', 'whisper-medium', 'whisper-large-v3-turbo'];
    expect(new Set(whisper.map(deriveModelFamily)).size).toBe(1);

    const qwen3 = ['qwen3-14b', 'qwen3-1.7b', 'qwen3-4b', 'qwen3-0.6b'];
    expect(new Set(qwen3.map(deriveModelFamily)).size).toBe(1);
  });

  it('keeps distinct families separate', () => {
    expect(deriveModelFamily('qwen3-4b')).not.toBe(deriveModelFamily('qwen3.5-4b'));
    expect(deriveModelFamily('qwen2.5-coder-7b')).not.toBe(deriveModelFamily('qwen2.5-7b'));
    expect(deriveModelFamily('qwen3-vl-2b-instruct')).toBe('qwen3-vl');
  });

  it('never returns empty for a non-empty alias', () => {
    expect(deriveModelFamily('instruct')).toBe('instruct');
    expect(deriveModelFamily('7b')).toBe('7b');
    expect(deriveModelFamily('')).toBe('');
    expect(deriveModelFamily(null)).toBe('');
    expect(deriveModelFamily(undefined)).toBe('');
  });

  it('prefers a real catalog family when one is present', () => {
    expect(modelFamilyLabel({ alias: 'whisper-tiny', family: 'Whisper' })).toBe('whisper');
    // Catalog reports null today, so we fall back to derivation.
    expect(modelFamilyLabel({ alias: 'whisper-tiny', family: null })).toBe('whisper');
  });
});

describe('sortModels', () => {
  const models = [
    { alias: 'whisper-tiny', createdAt: 300, family: null },
    { alias: 'qwen3-14b', createdAt: 100, family: null },
    { alias: 'qwen3-2b', createdAt: 200, family: null },
    { alias: 'phi-4-mini', createdAt: 400, family: null },
  ];

  it('sorts by name using natural numeric ordering', () => {
    const aliases = sortModels(models, 'name').map((m) => m.alias);
    // qwen3-2b must precede qwen3-14b (numeric, not lexicographic).
    expect(aliases.indexOf('qwen3-2b')).toBeLessThan(aliases.indexOf('qwen3-14b'));
    expect(aliases[0]).toBe('phi-4-mini');
  });

  it('sorts by newest first', () => {
    expect(sortModels(models, 'newest').map((m) => m.alias)).toEqual([
      'phi-4-mini',
      'whisper-tiny',
      'qwen3-2b',
      'qwen3-14b',
    ]);
  });

  it('groups families together when sorting by family', () => {
    const aliases = sortModels(models, 'family').map((m) => m.alias);
    const a = aliases.indexOf('qwen3-2b');
    const b = aliases.indexOf('qwen3-14b');
    expect(Math.abs(a - b)).toBe(1);
  });

  it('does not mutate the input array', () => {
    const input = [...models];
    sortModels(input, 'newest');
    expect(input.map((m) => m.alias)).toEqual(models.map((m) => m.alias));
  });

  it('treats a missing createdAt as oldest instead of throwing', () => {
    const result = sortModels([{ alias: 'a' }, { alias: 'b', createdAt: 5 }], 'newest');
    expect(result[0].alias).toBe('b');
  });

  it('reads createdAt from nested catalog metadata', () => {
    // Foundry nests model info inconsistently; if the lookup misses, every model
    // scores 0 and "newest" silently degrades to alphabetical order.
    const nested = [
      { alias: 'aaa-old', info: { info: { createdAt: 100 } } },
      { alias: 'zzz-new', info: { info: { createdAt: 900 } } },
    ];
    expect(sortModels(nested, 'newest').map((m) => m.alias)).toEqual(['zzz-new', 'aaa-old']);
  });

  it('accepts string and createdAtUnix timestamps', () => {
    const mixed = [
      { alias: 'a', createdAt: '100' },
      { alias: 'b', createdAtUnix: 900 },
    ];
    expect(sortModels(mixed, 'newest').map((m) => m.alias)).toEqual(['b', 'a']);
  });

  it('normalizes millisecond timestamps against second timestamps', () => {
    const mixed = [
      { alias: 'seconds-newer', createdAt: 1_800_000_000 },
      { alias: 'millis-older', createdAt: 1_600_000_000_000 },
    ];
    expect(sortModels(mixed, 'newest').map((m) => m.alias)).toEqual([
      'seconds-newer',
      'millis-older',
    ]);
  });
});

describe('modelMatchesSearch', () => {
  it('matches on alias', () => {
    expect(modelMatchesSearch({ alias: 'whisper-tiny' }, 'tiny')).toBe(true);
  });

  it('matches on derived family', () => {
    expect(modelMatchesSearch({ alias: 'qwen2.5-coder-7b' }, 'coder')).toBe(true);
  });

  it('is additive so a mis-derived family cannot hide a model', () => {
    // 'instruct' is stripped from the family, but the alias still matches.
    expect(modelMatchesSearch({ alias: 'olmo-3-7b-instruct' }, 'instruct')).toBe(true);
  });

  it('returns all models for an empty query', () => {
    expect(modelMatchesSearch({ alias: 'anything' }, '')).toBe(true);
    expect(modelMatchesSearch({ alias: 'anything' }, '   ')).toBe(true);
  });

  it('rejects non-matches', () => {
    expect(modelMatchesSearch({ alias: 'whisper-tiny' }, 'llama')).toBe(false);
  });
});

describe('isModelSortKey', () => {
  it('accepts known keys and rejects anything else', () => {
    expect(isModelSortKey('family')).toBe(true);
    expect(isModelSortKey('newest')).toBe(true);
    expect(isModelSortKey('bogus')).toBe(false);
    expect(isModelSortKey(undefined)).toBe(false);
  });
});
