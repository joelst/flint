import { describe, it, expect } from 'vitest';
import {
  BENCHMARK_MAX_ATTEMPTS,
  BENCHMARK_MAX_CASES,
  BENCHMARK_MAX_JSONL_CHARS,
  BENCHMARK_MAX_JSONL_LINE_CHARS,
  BENCHMARK_MAX_MESSAGES_PER_CASE,
  BENCHMARK_MAX_TARGETS,
  BENCHMARK_MAX_TOKENS_LIMIT,
  benchmarkAttemptCount,
  isBenchmarkSuite,
  isStoredBenchmarkSuite,
  parseBenchmarkCasesJsonl,
  validateBenchmarkCase,
  validateBenchmarkSuite,
  type BenchmarkCase,
  type BenchmarkSuite,
} from './benchmark-suite';

const validCase = (over: Partial<BenchmarkCase> = {}): BenchmarkCase => ({
  id: 'case-1',
  prompt: 'What is 2+2?',
  ...over,
});

const validSuite = (over: Partial<BenchmarkSuite> = {}): BenchmarkSuite => ({
  id: 'suite-1',
  name: 'Arithmetic',
  createdAt: 1700000000000,
  targets: [{ alias: 'model-a', variantId: null }],
  cases: [validCase()],
  warmupCount: 1,
  repeatCount: 1,
  ...over,
});

describe('benchmarkAttemptCount', () => {
  it('is targets * (warmup + cases * repeats), warmup counted once per target not per case', () => {
    const suite = validSuite({
      targets: [{ alias: 'a', variantId: null }, { alias: 'b', variantId: null }],
      cases: [validCase({ id: 'c1' }), validCase({ id: 'c2' })],
      warmupCount: 1,
      repeatCount: 3,
    });
    // 2 targets * (1 warmup + 2 cases * 3 repeats) = 2 * 7 = 14
    expect(benchmarkAttemptCount(suite)).toBe(14);
  });

  it('is zero cases contribute nothing beyond the per-target warmup', () => {
    expect(benchmarkAttemptCount({
      targets: [{ alias: 'a', variantId: null }],
      cases: [],
      warmupCount: 1,
      repeatCount: 1,
    })).toBe(1);
  });
});

describe('validateBenchmarkCase', () => {
  it('accepts a prompt-only case', () => {
    const r = validateBenchmarkCase(validCase(), 'case');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ id: 'case-1', prompt: 'What is 2+2?' });
  });

  it('accepts a messages-only case', () => {
    const r = validateBenchmarkCase(
      { id: 'case-1', messages: [{ role: 'user', content: 'hi' }] },
      'case',
    );
    expect(r.ok).toBe(true);
    expect(r.value?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('trims message content', () => {
    const r = validateBenchmarkCase(
      { id: 'case-1', messages: [{ role: 'user', content: '  hi  ' }] },
      'case',
    );
    expect(r.ok).toBe(true);
    expect(r.value?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it.each([
    ['neither prompt nor messages', { id: 'c' }],
    ['both prompt and messages', { id: 'c', prompt: 'x', messages: [{ role: 'user', content: 'x' }] }],
    ['empty prompt', { id: 'c', prompt: '   ' }],
    ['empty messages array', { id: 'c', messages: [] }],
    ['prompt and empty messages both present', { id: 'c', prompt: 'x', messages: [] }],
    ['malformed prompt alongside messages', { id: 'c', prompt: 123, messages: [{ role: 'user', content: 'x' }] }],
  ])('rejects %s', (_label, raw) => {
    const r = validateBenchmarkCase(raw, 'case');
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid message role', () => {
    const r = validateBenchmarkCase({ id: 'c', messages: [{ role: 'tool', content: 'x' }] }, 'case');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/role/);
  });

  it('rejects a message that is not an object', () => {
    const r = validateBenchmarkCase({ id: 'c', messages: ['not-an-object'] }, 'case');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/message must be an object/);
  });

  it('rejects a message with missing/blank content', () => {
    const r = validateBenchmarkCase({ id: 'c', messages: [{ role: 'user', content: '  ' }] }, 'case');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/content/);
  });

  it('rejects a case that is not an object', () => {
    expect(validateBenchmarkCase('not-an-object', 'case').ok).toBe(false);
  });

  it('rejects a prompt longer than the max text length', () => {
    const r = validateBenchmarkCase({ id: 'c', prompt: 'x'.repeat(8001) }, 'case');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/prompt must be a non-empty string of at most/);
  });

  it('rejects an expected value longer than the max text length', () => {
    const r = validateBenchmarkCase({ id: 'c', prompt: 'x', expected: 'y'.repeat(8001) }, 'case');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/expected must be a non-empty string/);
  });

  it('rejects tags that are not an array', () => {
    const r = validateBenchmarkCase({ id: 'c', prompt: 'x', tags: 'not-an-array' }, 'case');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/tags must be an array/);
  });

  it('rejects a tag that is not a non-empty string', () => {
    const r = validateBenchmarkCase({ id: 'c', prompt: 'x', tags: ['ok', '  '] }, 'case');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/each tag must be a non-empty string/);
  });

  it('rejects a missing or blank id', () => {
    expect(validateBenchmarkCase({ prompt: 'x' }, 'case').ok).toBe(false);
    expect(validateBenchmarkCase({ id: '  ', prompt: 'x' }, 'case').ok).toBe(false);
  });

  it('trims id, prompt, expected, and tags; dedupes tags', () => {
    const r = validateBenchmarkCase(
      { id: ' c1 ', prompt: ' hi ', expected: ' 4 ', tags: [' math ', 'math', ' math '] },
      'case',
    );
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ id: 'c1', prompt: 'hi', expected: '4', tags: ['math'] });
  });

  it('rejects too many tags', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(validateBenchmarkCase({ id: 'c', prompt: 'x', tags }, 'case').ok).toBe(false);
  });

  it('accepts the per-case message-count limit and rejects one over', () => {
    const atLimit = Array.from({ length: BENCHMARK_MAX_MESSAGES_PER_CASE }, () => ({ role: 'user', content: 'x' }));
    expect(validateBenchmarkCase({ id: 'c', messages: atLimit }, 'case').ok).toBe(true);
    expect(validateBenchmarkCase({
      id: 'c',
      messages: [...atLimit, { role: 'user', content: 'x' }],
    }, 'case').ok).toBe(false);
  });
});

describe('validateBenchmarkSuite', () => {
  it('accepts a minimal valid suite', () => {
    const r = validateBenchmarkSuite(validSuite());
    expect(r.ok).toBe(true);
  });

  it('accepts optional temperature, maxTokens, and description', () => {
    const r = validateBenchmarkSuite(validSuite({
      description: 'A test suite',
      temperature: 0.7,
      maxTokens: 512,
    }));
    expect(r.ok).toBe(true);
    expect(r.value?.temperature).toBe(0.7);
    expect(r.value?.maxTokens).toBe(512);
  });

  it.each([
    ['no targets', { targets: [] }],
    [`more than ${BENCHMARK_MAX_TARGETS} targets`, {
      targets: Array.from({ length: BENCHMARK_MAX_TARGETS + 1 }, (_, i) => ({ alias: `m${i}`, variantId: null })),
    }],
    ['no cases', { cases: [] }],
    [`more than ${BENCHMARK_MAX_CASES} cases`, {
      cases: Array.from({ length: BENCHMARK_MAX_CASES + 1 }, (_, i) => validCase({ id: `c${i}` })),
    }],
    ['repeatCount below 1', { repeatCount: 0 }],
    ['repeatCount above 3', { repeatCount: 4 }],
    ['warmupCount below 0', { warmupCount: -1 }],
    ['warmupCount above 1', { warmupCount: 2 }],
    ['non-integer repeatCount', { repeatCount: 1.5 }],
    ['temperature above 2', { temperature: 2.1 }],
    ['temperature below 0', { temperature: -0.1 }],
    ['maxTokens above the preview limit', { maxTokens: BENCHMARK_MAX_TOKENS_LIMIT + 1 }],
    ['maxTokens of zero', { maxTokens: 0 }],
    ['non-integer maxTokens', { maxTokens: 100.5 }],
    ['blank id', { id: '  ' }],
    ['blank name', { name: '' }],
    ['negative createdAt', { createdAt: -1 }],
    ['non-integer createdAt', { createdAt: 1.5 }],
    ['createdAt outside the Date range', { createdAt: 8.65e15 }],
    ['description too long', { description: 'x'.repeat(2001) }],
    ['description of the wrong type', { description: 123 as unknown as string }],
  ])('rejects %s', (_label, over) => {
    const r = validateBenchmarkSuite(validSuite(over as Partial<BenchmarkSuite>));
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate target alias+variant pairs', () => {
    const r = validateBenchmarkSuite(validSuite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v1' },
      ],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/duplicate target/);
  });

  it('describes an alias-only duplicate as runtime-selected', () => {
    const r = validateBenchmarkSuite(validSuite({
      targets: [
        { alias: 'model-a', variantId: null },
        { alias: 'model-a', variantId: null },
      ],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('runtime-selected');
  });

  it('rejects the same alias with different variants as distinct targets (pool is keyed by alias)', () => {
    // The sidecar model pool and the alias-only chat transport are both keyed by alias, not
    // alias+variant — loading a second target with the same alias silently replaces the first
    // target's resident variant before execution, so this must be rejected, not allowed.
    const r = validateBenchmarkSuite(validSuite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
      ],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/duplicate target alias/);
  });

  it('allows the legacy same-alias-different-variant shape only when read as a stored suite', () => {
    // A pre-1.0 release accepted this shape; a run/suite already persisted with it must stay
    // readable even though a create/edit write now rejects it (isBenchmarkSuite, strict).
    const legacySuite = validSuite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
      ],
    });
    expect(isBenchmarkSuite(legacySuite)).toBe(false);
    expect(isStoredBenchmarkSuite(legacySuite)).toBe(true);
    const r = validateBenchmarkSuite(legacySuite, { allowDuplicateAliases: true });
    expect(r.ok).toBe(true);
    expect(r.value?.targets).toHaveLength(2);
  });

  it('still rejects an exact alias+variant duplicate even on tolerant stored-suite reads', () => {
    const corrupt = validSuite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v1' },
      ],
    });
    expect(validateBenchmarkSuite(corrupt, { allowDuplicateAliases: true }).ok).toBe(false);
    expect(isStoredBenchmarkSuite(corrupt)).toBe(false);
  });

  it('rejects duplicate case ids', () => {
    const r = validateBenchmarkSuite(validSuite({
      cases: [validCase({ id: 'dup' }), validCase({ id: 'dup' })],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/duplicate case id/);
  });

  it('rejects a target that is not an object', () => {
    const r = validateBenchmarkSuite(validSuite({ targets: ['not-an-object'] as unknown as BenchmarkSuite['targets'] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/target must be an object/);
  });

  it('rejects a target with a missing/blank alias', () => {
    const r = validateBenchmarkSuite(validSuite({ targets: [{ alias: '  ', variantId: null }] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/alias must be a non-empty string/);
  });

  it('rejects a target whose variantId is neither a string nor null', () => {
    const r = validateBenchmarkSuite(validSuite({
      targets: [{ alias: 'model-a', variantId: 123 as unknown as string }],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/variantId must be a non-empty string or null/);
  });

  it('rejects a target that omits variantId entirely', () => {
    const r = validateBenchmarkSuite(validSuite({
      targets: [{ alias: 'model-a' } as unknown as { alias: string; variantId: string | null }],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/variantId must be a non-empty string or null/);
  });

  it('rejects a target whose variantId is a blank string (must be null, not empty)', () => {
    const r = validateBenchmarkSuite(validSuite({
      targets: [{ alias: 'model-a', variantId: '   ' }],
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/variantId must be a non-empty string or null/);
  });

  it('does not conflate distinct alias/variantId pairs that share characters across the boundary', () => {
    // ('a', 'b::c') and ('a::b', 'c') must not collide just because a naive delimiter-joined
    // key would look the same for both.
    const r = validateBenchmarkSuite(validSuite({
      targets: [
        { alias: 'a', variantId: 'b::c' },
        { alias: 'a::b', variantId: 'c' },
      ],
    }));
    expect(r.ok).toBe(true);
  });

  it('rejects a suite description that is present but blank', () => {
    const r = validateBenchmarkSuite(validSuite({ description: '   ' }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/description must be a non-empty string/);
  });

  it('trims a valid description', () => {
    const r = validateBenchmarkSuite(validSuite({ description: '  hello  ' }));
    expect(r.ok).toBe(true);
    expect(r.value?.description).toBe('hello');
  });

  it('propagates a per-case validation error (not just duplicate-id) up to the suite result', () => {
    const r = validateBenchmarkSuite(validSuite({
      cases: [{ id: 'c1' } as unknown as BenchmarkCase], // neither prompt nor messages
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/exactly one of prompt\/messages/);
  });

  it('rejects a suite whose total attempt count exceeds the preview limit', () => {
    const r = validateBenchmarkSuite(validSuite({
      targets: Array.from({ length: BENCHMARK_MAX_TARGETS }, (_, i) => ({ alias: `m${i}`, variantId: null })),
      cases: Array.from({ length: BENCHMARK_MAX_CASES }, (_, i) => validCase({ id: `c${i}` })),
      warmupCount: 1,
      repeatCount: 3,
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(new RegExp(`exceeding the ${BENCHMARK_MAX_ATTEMPTS}-attempt`));
  });

  it('accepts a suite right at the attempt limit boundary', () => {
    // 3 targets * (0 warmup + 100 cases * 3 repeats) = 3 * 300 = 900
    const r = validateBenchmarkSuite(validSuite({
      targets: Array.from({ length: BENCHMARK_MAX_TARGETS }, (_, i) => ({ alias: `m${i}`, variantId: null })),
      cases: Array.from({ length: BENCHMARK_MAX_CASES }, (_, i) => validCase({ id: `c${i}` })),
      warmupCount: 0,
      repeatCount: 3,
    }));
    expect(r.ok).toBe(true);
  });
});

describe('isBenchmarkSuite', () => {
  it('accepts a valid suite and rejects garbage', () => {
    expect(isBenchmarkSuite(validSuite())).toBe(true);
    expect(isBenchmarkSuite({ not: 'a suite' })).toBe(false);
    expect(isBenchmarkSuite(null)).toBe(false);
  });
});

describe('parseBenchmarkCasesJsonl', () => {
  it('parses multiple lines, skipping blank ones', () => {
    const text = [
      '{"id":"c1","prompt":"a"}',
      '',
      '{"id":"c2","prompt":"b"}',
      '  ',
    ].join('\n');
    const r = parseBenchmarkCasesJsonl(text);
    expect(r.ok).toBe(true);
    expect(r.cases).toEqual([
      { id: 'c1', prompt: 'a' },
      { id: 'c2', prompt: 'b' },
    ]);
  });

  it('accepts a UTF-8 BOM before the first JSONL row', () => {
    const r = parseBenchmarkCasesJsonl('\uFEFF{"id":"c1","prompt":"a"}');
    expect(r.ok).toBe(true);
    expect(r.cases).toEqual([{ id: 'c1', prompt: 'a' }]);
  });

  it('generates an id from the line number when one is missing', () => {
    const r = parseBenchmarkCasesJsonl('{"prompt":"a"}\n{"prompt":"b"}');
    expect(r.ok).toBe(true);
    expect(r.cases?.map((c) => c.id)).toEqual(['case-line-1', 'case-line-2']);
  });

  it('rejects a row with a present-but-blank id rather than treating it as absent', () => {
    const r = parseBenchmarkCasesJsonl('{"id":"  ","prompt":"a"}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/line 1.*id must be a non-empty string/);
  });

  it('rejects the whole file when any line is invalid JSON', () => {
    const r = parseBenchmarkCasesJsonl('{"id":"c1","prompt":"a"}\nnot json');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/line 2/);
  });

  it('rejects the whole file on a duplicate explicit id, citing the line', () => {
    const r = parseBenchmarkCasesJsonl('{"id":"dup","prompt":"a"}\n{"id":"dup","prompt":"b"}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/line 2/);
    expect(r.error).toMatch(/duplicate/);
  });

  it('rejects a generated id that collides with an explicit id elsewhere in the file', () => {
    // Line 2 has no id, so it would generate "case-line-2" — but line 1 already claims that id.
    const r = parseBenchmarkCasesJsonl('{"id":"case-line-2","prompt":"a"}\n{"prompt":"b"}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/line 2/);
    expect(r.error).toMatch(/collides/);
  });

  it('rejects an empty file', () => {
    expect(parseBenchmarkCasesJsonl('').ok).toBe(false);
    expect(parseBenchmarkCasesJsonl('   \n  \n').ok).toBe(false);
  });

  it('rejects a file larger than the character cap before parsing', () => {
    const r = parseBenchmarkCasesJsonl('x'.repeat(BENCHMARK_MAX_JSONL_CHARS + 1));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/larger than/);
  });

  it('rejects a line longer than the per-line cap before JSON.parse', () => {
    const r = parseBenchmarkCasesJsonl('{"id":"c1","prompt":"' + 'x'.repeat(BENCHMARK_MAX_JSONL_LINE_CHARS) + '"}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/line 1/);
    expect(r.error).toMatch(/exceeds/);
  });

  it('rejects more cases than the case limit', () => {
    const lines = Array.from({ length: BENCHMARK_MAX_CASES + 1 }, (_, i) => `{"id":"c${i}","prompt":"x"}`);
    const r = parseBenchmarkCasesJsonl(lines.join('\n'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/case limit/);
  });

  it('rejects the whole file when one row is otherwise invalid (e.g. bad role)', () => {
    const r = parseBenchmarkCasesJsonl(
      '{"id":"c1","prompt":"a"}\n{"id":"c2","messages":[{"role":"tool","content":"x"}]}',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/line 2/);
  });
});
