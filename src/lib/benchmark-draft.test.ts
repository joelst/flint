import { describe, expect, it } from 'vitest';
import { applyTargetAlias, buildSuiteFromDraft, cachedVariantIds, draftFromSuite, estimateDraftAttempts, variantChoicesForTarget, type SuiteDraft } from './benchmark-draft';
import { BENCHMARK_MAX_ATTEMPTS, BENCHMARK_MAX_JSONL_CHARS } from './benchmark-suite';
import type { BenchmarkSuite } from './benchmark-suite';

const baseDraft = (over: Partial<SuiteDraft> = {}): SuiteDraft => ({
  name: 'Arithmetic',
  targets: [{ alias: 'model-a', variantId: null }],
  casesJsonl: '{"id":"c1","prompt":"What is 2+2?"}',
  warmupCount: 1,
  repeatCount: 1,
  ...over,
});

describe('buildSuiteFromDraft', () => {
  it('builds a valid suite from a well-formed draft, generating an id and createdAt', () => {
    const result = buildSuiteFromDraft(baseDraft(), 1700000000000);
    expect(result.ok).toBe(true);
    expect(result.value!.name).toBe('Arithmetic');
    expect(result.value!.createdAt).toBe(1700000000000);
    expect(result.value!.id).toMatch(/^suite_/);
    expect(result.value!.cases).toEqual([{ id: 'c1', prompt: 'What is 2+2?' }]);
  });

  it('preserves an existing id/createdAt when editing (never generates a new identity for an edit)', () => {
    const result = buildSuiteFromDraft(baseDraft({ id: 'suite-existing', createdAt: 1 }), 999);
    expect(result.ok).toBe(true);
    expect(result.value!.id).toBe('suite-existing');
    expect(result.value!.createdAt).toBe(1);
  });

  it('rejects a draft whose JSONL cases text fails to parse, surfacing parseBenchmarkCasesJsonl\'s own error text', () => {
    const result = buildSuiteFromDraft(baseDraft({ casesJsonl: 'not json' }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/not valid JSON/);
  });

  it('rejects a draft that would exceed the attempt cap, going through the same validateBenchmarkSuite check a JSONL import would', () => {
    const manyCases = Array.from({ length: 100 }, (_, i) => `{"id":"c${i}","prompt":"x"}`).join('\n');
    const result = buildSuiteFromDraft(baseDraft({
      targets: [{ alias: 'model-a', variantId: null }, { alias: 'model-b', variantId: null }, { alias: 'model-c', variantId: null }],
      casesJsonl: manyCases,
      repeatCount: 3,
      warmupCount: 1,
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(new RegExp(`exceeding the ${BENCHMARK_MAX_ATTEMPTS}-attempt`));
  });

  it('omits a blank description rather than passing it through to validation as an empty string', () => {
    const result = buildSuiteFromDraft(baseDraft({ description: '   ' }));
    expect(result.ok).toBe(true);
    expect(result.value!.description).toBeUndefined();
  });

  it('rejects a draft with no targets, matching validateBenchmarkSuite\'s own target-count rule', () => {
    const result = buildSuiteFromDraft(baseDraft({ targets: [] }));
    expect(result.ok).toBe(false);
  });
});

describe('cachedVariantIds', () => {
  it('keeps only variants that are already on disk', () => {
    expect(cachedVariantIds([
      { id: 'cuda', cached: true },
      { id: 'cpu', cached: false },
      { id: 'npu', cached: true },
    ])).toEqual(['cuda', 'npu']);
    expect(cachedVariantIds(undefined)).toEqual([]);
  });
});

describe('variantChoicesForTarget', () => {
  it('keeps a stored explicit variant that is no longer cached, marked unavailable', () => {
    expect(variantChoicesForTarget(['cuda'], 'cpu')).toEqual([
      { id: 'cpu', available: false },
      { id: 'cuda', available: true },
    ]);
  });

  it('does not duplicate a stored id that is still cached', () => {
    expect(variantChoicesForTarget(['cuda', 'cpu'], 'cuda')).toEqual([
      { id: 'cuda', available: true },
      { id: 'cpu', available: true },
    ]);
  });
});

describe('estimateDraftAttempts', () => {
  it('counts non-blank JSONL lines without requiring a parse', () => {
    expect(estimateDraftAttempts(baseDraft({
      casesJsonl: '{"id":"c1","prompt":"x"}\n\n{"id":"c2","prompt":"y"}\n',
      warmupCount: 0,
      repeatCount: 1,
    }))).toBe(2);
  });

  it('returns null without splitting when the paste exceeds the JSONL character cap', () => {
    const huge = 'x'.repeat(BENCHMARK_MAX_JSONL_CHARS + 1);
    expect(estimateDraftAttempts(baseDraft({ casesJsonl: huge }))).toBeNull();
  });

  it('returns null instead of NaN when warmupCount/repeatCount are empty form fields (bound as undefined)', () => {
    // Svelte's bind:value on a number input yields `undefined` while the field is blank
    // mid-edit; SuiteDraft types these as `number`, so an empty field is a real runtime value
    // this function must tolerate, not just a type-level impossibility.
    expect(estimateDraftAttempts(baseDraft({ warmupCount: undefined as unknown as number }))).toBeNull();
    expect(estimateDraftAttempts(baseDraft({ repeatCount: undefined as unknown as number }))).toBeNull();
  });

  it('returns null for a non-integer or otherwise non-finite count rather than a fractional/NaN estimate', () => {
    expect(estimateDraftAttempts(baseDraft({ warmupCount: 1.5 }))).toBeNull();
    expect(estimateDraftAttempts(baseDraft({ repeatCount: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(estimateDraftAttempts(baseDraft({ repeatCount: NaN }))).toBeNull();
  });
});

describe('applyTargetAlias', () => {
  it('clears a variant that does not exist on the new alias', () => {
    expect(applyTargetAlias({ alias: 'model-a', variantId: 'v1' }, 'model-b', ['other'])).toEqual({
      alias: 'model-b',
      variantId: null,
    });
  });

  it('keeps a variant id that the new alias also exposes', () => {
    expect(applyTargetAlias({ alias: 'model-a', variantId: 'shared' }, 'model-b', ['shared', 'v2'])).toEqual({
      alias: 'model-b',
      variantId: 'shared',
    });
  });

  it('does not clear the variant when the alias is unchanged', () => {
    expect(applyTargetAlias({ alias: 'model-a', variantId: 'v1' }, 'model-a', [])).toEqual({
      alias: 'model-a',
      variantId: 'v1',
    });
  });
});

describe('draftFromSuite', () => {
  it('round-trips a stored suite into an editable draft and back into an equivalent suite', () => {
    const stored: BenchmarkSuite = {
      id: 'suite-1',
      name: 'Arithmetic',
      description: 'basic math',
      createdAt: 1700000000000,
      targets: [{ alias: 'model-a', variantId: 'v1' }],
      cases: [{ id: 'c1', prompt: 'What is 2+2?' }],
      temperature: 0.5,
      maxTokens: 256,
      warmupCount: 1,
      repeatCount: 2,
    };
    const draft = draftFromSuite(stored);
    const rebuilt = buildSuiteFromDraft(draft);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.value).toEqual(stored);
  });

  it('round-trips a case using structured messages, not just prompt', () => {
    const stored: BenchmarkSuite = {
      id: 'suite-2',
      name: 'Messages suite',
      createdAt: 1,
      targets: [{ alias: 'model-a', variantId: null }],
      cases: [{ id: 'c1', messages: [{ role: 'user', content: 'hi' }] }],
      warmupCount: 0,
      repeatCount: 1,
    };
    const draft = draftFromSuite(stored);
    const rebuilt = buildSuiteFromDraft(draft);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.value!.cases).toEqual(stored.cases);
  });
});
