import { describe, expect, it } from 'vitest';
import { aliasChoicesForTarget, applyTargetAlias, buildSuiteFromDraft, cachedVariantIds, caseRowsFromJsonl, copiedSuiteName, draftEditsSuite, draftFromSuite, duplicateSuiteDraft, estimateDraftAttempts, jsonlFromCaseRows, jsonlImportCanFitCharacterLimit, newPromptCaseRow, optionalDraftNumber, tagsJsonError, variantChoicesForTarget, type SuiteDraft } from './benchmark-draft';
import { BENCHMARK_MAX_ATTEMPTS, BENCHMARK_MAX_JSONL_CHARS, BENCHMARK_MAX_NAME_LENGTH } from './benchmark-suite';
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

  it('omits a cleared temperature or max tokens instead of storing a runtime default as a number', () => {
    const cleared = buildSuiteFromDraft(baseDraft({ temperature: null, maxTokens: null }));
    expect(cleared.ok).toBe(true);
    expect(cleared.value!.temperature).toBeUndefined();
    expect(cleared.value!.maxTokens).toBeUndefined();
    const invalid = buildSuiteFromDraft(baseDraft({ temperature: Number.NaN }));
    expect(invalid.ok).toBe(false);
  });

  it('keeps numeric input text parseable until save', () => {
    const intermediate = baseDraft({ temperature: '0.', maxTokens: '256' });
    expect(intermediate.temperature).toBe('0.');
    const result = buildSuiteFromDraft(intermediate);
    expect(result.ok).toBe(true);
    expect(result.value!.temperature).toBe(0);
    expect(result.value!.maxTokens).toBe(256);
  });

  it('rejects a draft with no targets, matching validateBenchmarkSuite\'s own target-count rule', () => {
    const result = buildSuiteFromDraft(baseDraft({ targets: [] }));
    expect(result.ok).toBe(false);
  });
});

describe('draftEditsSuite', () => {
  it('is true only for a draft that names that stored suite', () => {
    expect(draftEditsSuite({ id: 'suite-1' }, 'suite-1')).toBe(true);
    expect(draftEditsSuite({ id: 'suite-1' }, 'suite-2')).toBe(false);
    expect(draftEditsSuite({ id: undefined }, 'suite-1')).toBe(false);
    expect(draftEditsSuite(null, 'suite-1')).toBe(false);
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

describe('aliasChoicesForTarget', () => {
  it('keeps a stored alias that is no longer in the cached picker, marked unavailable', () => {
    expect(aliasChoicesForTarget(['phi'], 'old-model')).toEqual([
      { alias: 'old-model', available: false },
      { alias: 'phi', available: true },
    ]);
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

  it('returns null for an in-range integer that is still out of the same warmup/repeat bounds Save enforces', () => {
    // Regression: an integer failed only isFiniteInteger before, so an out-of-range value (e.g.
    // warmup -1, or repeat 0/4 -- valid range is 0-1 warmup, 1-3 repeat per benchmark-suite.ts)
    // produced a misleading zero/negative "Estimated attempts" preview even though Save's real
    // validateBenchmarkSuite would reject the identical draft outright.
    expect(estimateDraftAttempts(baseDraft({ warmupCount: -1, repeatCount: 1 }))).toBeNull();
    expect(estimateDraftAttempts(baseDraft({ warmupCount: 2, repeatCount: 1 }))).toBeNull();
    expect(estimateDraftAttempts(baseDraft({ warmupCount: 0, repeatCount: 0 }))).toBeNull();
    expect(estimateDraftAttempts(baseDraft({ warmupCount: 0, repeatCount: 4 }))).toBeNull();
    // The boundary values themselves remain valid.
    expect(estimateDraftAttempts(baseDraft({
      casesJsonl: '{"id":"c1","prompt":"x"}\n',
      warmupCount: 1,
      repeatCount: 3,
    }))).toBe(4);
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

describe('optionalDraftNumber', () => {
  it('treats an empty input as omitted and parses a typed number', () => {
    expect(optionalDraftNumber(null)).toBeUndefined();
    expect(optionalDraftNumber('')).toBeUndefined();
    expect(optionalDraftNumber('  ')).toBeUndefined();
    expect(optionalDraftNumber('0.2')).toBe(0.2);
    expect(optionalDraftNumber(0)).toBe(0);
    expect(optionalDraftNumber('nope')).toBeNaN();
  });
});

describe('jsonlImportCanFitCharacterLimit', () => {
  it('allows multibyte UTF-8 files that can still fit the character cap', () => {
    expect(jsonlImportCanFitCharacterLimit(BENCHMARK_MAX_JSONL_CHARS * 2)).toBe(true);
  });

  it('rejects only byte sizes that cannot fit the character cap', () => {
    expect(jsonlImportCanFitCharacterLimit(BENCHMARK_MAX_JSONL_CHARS * 3)).toBe(true);
    expect(jsonlImportCanFitCharacterLimit(BENCHMARK_MAX_JSONL_CHARS * 3 + 1)).toBe(false);
  });
});

describe('case rows', () => {
  it('treats a blank case list as no rows, not a parse failure', () => {
    expect(caseRowsFromJsonl('')).toEqual({ ok: true, rows: [] });
    expect(caseRowsFromJsonl('  \n')).toEqual({ ok: true, rows: [] });
    expect(jsonlFromCaseRows([])).toBe('');
  });

  it('round-trips prompt rows, including expected and tags, through the suite validator', () => {
    const rows = caseRowsFromJsonl('{"id":"c1","prompt":"2+2","expected":"4","tags":["math"]}');
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    expect(rows.rows).toEqual([{ kind: 'prompt', id: 'c1', prompt: '2+2', expected: '4', tagsJson: '["math"]' }]);
    const rebuilt = buildSuiteFromDraft(baseDraft({ casesJsonl: jsonlFromCaseRows(rows.rows) }));
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.value!.cases).toEqual([{ id: 'c1', prompt: '2+2', expected: '4', tags: ['math'] }]);
  });

  it('keeps a messages case verbatim when prompt rows around it are edited', () => {
    const text = [
      '{"id":"c1","prompt":"hi"}',
      '{"id":"c2","messages":[{"role":"user","content":"hello"}]}',
    ].join('\n');
    const parsed = caseRowsFromJsonl(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const messages = parsed.rows[1];
    expect(messages).toMatchObject({ kind: 'messages', id: 'c2', messageCount: 1 });
    const reordered = [messages, { kind: 'prompt' as const, id: 'c1', prompt: 'edited', expected: '', tagsJson: '' }];
    const rebuilt = buildSuiteFromDraft(baseDraft({ casesJsonl: jsonlFromCaseRows(reordered) }));
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.value!.cases.map((entry) => entry.id)).toEqual(['c2', 'c1']);
    expect(rebuilt.value!.cases[0].messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(rebuilt.value!.cases[1].prompt).toBe('edited');
  });

  it('round-trips tags containing commas without changing their identity', () => {
    const parsed = caseRowsFromJsonl('{"id":"c1","prompt":"hi","tags":["a,b","plain"]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows[0]).toMatchObject({ tagsJson: '["a,b","plain"]' });
    const rebuilt = buildSuiteFromDraft(baseDraft({ casesJsonl: jsonlFromCaseRows(parsed.rows) }));
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.value!.cases[0].tags).toEqual(['a,b', 'plain']);
  });

  it('does not add an empty tags array to a tagless case', () => {
    const parsed = caseRowsFromJsonl('{"id":"c1","prompt":"hi"}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows[0]).toMatchObject({ tagsJson: '' });
    const rebuilt = buildSuiteFromDraft(baseDraft({ casesJsonl: jsonlFromCaseRows(parsed.rows) }));
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.value!.cases[0]).toEqual({ id: 'c1', prompt: 'hi' });
  });

  it('preserves an explicit empty tags array', () => {
    const parsed = caseRowsFromJsonl('{"id":"c1","prompt":"hi","tags":[]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rebuilt = buildSuiteFromDraft(baseDraft({ casesJsonl: jsonlFromCaseRows(parsed.rows) }));
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.value!.cases[0]).toEqual({ id: 'c1', prompt: 'hi', tags: [] });
  });

  it('keeps invalid tag JSON as a validation error instead of throwing during editing', () => {
    const rows = [{
      kind: 'prompt' as const,
      id: 'c1',
      prompt: 'hi',
      expected: '',
      tagsJson: '[',
    }];
    expect(() => jsonlFromCaseRows(rows)).not.toThrow();
    const rebuilt = buildSuiteFromDraft(baseDraft({ casesJsonl: jsonlFromCaseRows(rows) }));
    expect(rebuilt.ok).toBe(false);
    expect(rebuilt.errors.join(' ')).toContain('tags must be an array');
  });

  it('explains tag JSON errors using the suite tag validator', () => {
    expect(tagsJsonError('')).toBeNull();
    expect(tagsJsonError('[')).toBe('Tags must be valid JSON.');
    expect(tagsJsonError('"math"')).toBe('tags must be an array');
    expect(tagsJsonError('["math"]')).toBeNull();
  });

  it('accepts a UTF-8 BOM through the form row conversion path', () => {
    expect(caseRowsFromJsonl('\uFEFF{"id":"c1","prompt":"hi"}')).toEqual({
      ok: true,
      rows: [{ kind: 'prompt', id: 'c1', prompt: 'hi', expected: '', tagsJson: '' }],
    });
  });

  it('surfaces the JSONL parser error instead of a partial row list', () => {
    const parsed = caseRowsFromJsonl('not json');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/not valid JSON/);
  });

  it('picks a case id that does not collide with rows already on the form', () => {
    expect(newPromptCaseRow(['c1'])).toMatchObject({ kind: 'prompt', id: 'c2' });
    expect(newPromptCaseRow(['c1', 'c2'])).toMatchObject({ id: 'c3' });
    expect(newPromptCaseRow(['c1', 'c3'])).toMatchObject({ id: 'c4' });
    expect(newPromptCaseRow([' c2 '])).toMatchObject({ id: 'c3' });
  });
});

describe('duplicateSuiteDraft', () => {
  it('drops the stored id so Save creates a suite with no runs', () => {
    const stored: BenchmarkSuite = {
      id: 'suite-1',
      name: 'Arithmetic',
      description: 'basic math',
      createdAt: 5,
      targets: [{ alias: 'model-a', variantId: 'v1' }],
      cases: [{ id: 'c1', prompt: 'What is 2+2?' }],
      temperature: 0.5,
      maxTokens: 256,
      warmupCount: 1,
      repeatCount: 2,
    };
    const draft = duplicateSuiteDraft(stored);
    expect(draft.id).toBeUndefined();
    expect(draft.createdAt).toBeUndefined();
    expect(draft.name).toBe('Arithmetic copy');
    expect(draft.temperature).toBe(0.5);
    expect(draft.casesJsonl).toContain('"prompt":"What is 2+2?"');
    const rebuilt = buildSuiteFromDraft(draft, 99);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.value!.id).not.toBe('suite-1');
    expect(rebuilt.value!.createdAt).toBe(99);
    expect(rebuilt.value!.cases).toEqual(stored.cases);
  });

  it('makes a legacy duplicate-alias suite saveable by keeping the first target per alias', () => {
    const stored: BenchmarkSuite = {
      id: 'suite-legacy',
      name: 'Legacy variants',
      createdAt: 5,
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
        { alias: 'model-b', variantId: null },
      ],
      cases: [{ id: 'c1', prompt: 'hello' }],
      warmupCount: 0,
      repeatCount: 1,
    };
    const draft = duplicateSuiteDraft(stored);
    expect(draft.targets).toEqual([
      { alias: 'model-a', variantId: 'v1' },
      { alias: 'model-b', variantId: null },
    ]);
    expect(buildSuiteFromDraft(draft).ok).toBe(true);
  });

  it('uses trimmed alias identity when repairing a legacy duplicate', () => {
    const stored: BenchmarkSuite = {
      id: 'suite-legacy-whitespace',
      name: 'Legacy whitespace',
      createdAt: 5,
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: ' model-a ', variantId: 'v2' },
      ],
      cases: [{ id: 'c1', prompt: 'hello' }],
      warmupCount: 0,
      repeatCount: 1,
    };
    const draft = duplicateSuiteDraft(stored);
    expect(draft.targets).toEqual([{ alias: 'model-a', variantId: 'v1' }]);
    expect(buildSuiteFromDraft(draft).ok).toBe(true);
  });

  it('preserves every target when their aliases are distinct', () => {
    const stored: BenchmarkSuite = {
      id: 'suite-distinct',
      name: 'Distinct models',
      createdAt: 5,
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-b', variantId: 'v2' },
      ],
      cases: [{ id: 'c1', prompt: 'hello' }],
      warmupCount: 0,
      repeatCount: 1,
    };
    expect(duplicateSuiteDraft(stored).targets).toEqual(stored.targets);
  });

  it('shortens a max-length name so the copy suffix still fits', () => {
    const name = 'a'.repeat(BENCHMARK_MAX_NAME_LENGTH);
    const copied = copiedSuiteName(name);
    expect(copied.length).toBe(BENCHMARK_MAX_NAME_LENGTH);
    expect(copied.endsWith(' copy')).toBe(true);
    expect(copiedSuiteName('   ')).toBe('copy');
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
