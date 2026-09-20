/**
 * Benchmark Preview suite schema, validation, attempt-count accounting, and JSONL import.
 *
 * Pure and headless: no storage, no UI, no feature flag. This module only decides what a
 * well-formed suite looks like and how many attempts running it would take — the persistence
 * layer lives in `benchmark-repository.ts`, and no UI reads either module until a later PR wires
 * up an entry point. Dormant on purpose.
 */

export const BENCHMARK_MAX_TARGETS = 3;
export const BENCHMARK_MAX_CASES = 100;
export const BENCHMARK_MIN_REPEAT_COUNT = 1;
export const BENCHMARK_MAX_REPEAT_COUNT = 3;
export const BENCHMARK_MIN_WARMUP_COUNT = 0;
export const BENCHMARK_MAX_WARMUP_COUNT = 1;
/**
 * Closes the gap independent per-field limits leave open: 3 targets * 100 cases * (1 warmup +
 * 3 repeats) would otherwise allow 1200 attempts. This bounds the whole suite's total attempt
 * count, not just each dimension in isolation.
 */
export const BENCHMARK_MAX_ATTEMPTS = 900;
/** Conservative preview bound, independent of the attempt cap: bounds stored output volume. */
export const BENCHMARK_MAX_TOKENS_LIMIT = 4096;
export const BENCHMARK_MAX_NAME_LENGTH = 200;
export const BENCHMARK_MAX_DESCRIPTION_LENGTH = 2000;
export const BENCHMARK_MAX_TEXT_LENGTH = 8000;
/** Per-case cap so a messages array cannot bypass the other size limits. */
export const BENCHMARK_MAX_MESSAGES_PER_CASE = 32;
export const BENCHMARK_MAX_TAGS = 10;
export const BENCHMARK_MAX_TAG_LENGTH = 40;
/** Reject the import before splitting/parsing so a huge paste cannot exhaust memory. */
export const BENCHMARK_MAX_JSONL_CHARS = 1_048_576;
export const BENCHMARK_MAX_JSONL_LINE_CHARS = 64_000;

export const BENCHMARK_MESSAGE_ROLES = ['system', 'user', 'assistant'] as const;
export type BenchmarkMessageRole = (typeof BENCHMARK_MESSAGE_ROLES)[number];

export interface BenchmarkMessage {
  role: BenchmarkMessageRole;
  content: string;
}

export interface BenchmarkCase {
  /** Stable within its suite; referenced by attempts/results in the runner PR. */
  id: string;
  /** Exactly one of `prompt`/`messages` is present — never both, never neither. */
  prompt?: string;
  messages?: BenchmarkMessage[];
  /** Stored but never evaluated by this module or any code that exists yet. Not scored. */
  expected?: string;
  tags?: string[];
}

export interface BenchmarkTarget {
  alias: string;
  variantId: string | null;
}

export interface BenchmarkSuite {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  targets: BenchmarkTarget[];
  cases: BenchmarkCase[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Number of discarded warm-up requests sent once per target before its cases run — the same
   * "one warm-up, not timed" idea Quick Compare already uses per slot, not a per-case repeat.
   */
  warmupCount: number;
  /** Measured repeats per case per target. Must be at least 1 — a suite that measures nothing
   * is not a valid suite. */
  repeatCount: number;
}

function isNonEmptyTrimmedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Attempts a suite's run would take: one run per target, discarded warm-ups plus measured
 * repeats across every case. Exported so validation and any future scheduler agree on the same
 * definition instead of silently drifting apart. */
export function benchmarkAttemptCount(suite: {
  targets: { length: number };
  cases: { length: number };
  warmupCount: number;
  repeatCount: number;
}): number {
  return suite.targets.length * (suite.warmupCount + suite.cases.length * suite.repeatCount);
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value, errors: [] };
}

function fail<T>(...errors: string[]): ValidationResult<T> {
  return { ok: false, errors };
}

export function validateBenchmarkMessage(raw: unknown, where: string): ValidationResult<BenchmarkMessage> {
  if (!isPlainObject(raw)) return fail(`${where}: message must be an object`);
  if (!BENCHMARK_MESSAGE_ROLES.includes(raw.role as BenchmarkMessageRole)) {
    return fail(`${where}: role must be one of ${BENCHMARK_MESSAGE_ROLES.join(', ')}`);
  }
  if (!isNonEmptyTrimmedString(raw.content, BENCHMARK_MAX_TEXT_LENGTH)) {
    return fail(`${where}: content must be a non-empty string of at most ${BENCHMARK_MAX_TEXT_LENGTH} characters`);
  }
  return ok({ role: raw.role as BenchmarkMessageRole, content: (raw.content as string).trim() });
}

function validateTags(raw: unknown, where: string): ValidationResult<string[] | undefined> {
  if (raw === undefined) return ok(undefined);
  if (!Array.isArray(raw)) return fail(`${where}: tags must be an array`);
  if (raw.length > BENCHMARK_MAX_TAGS) return fail(`${where}: at most ${BENCHMARK_MAX_TAGS} tags`);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of raw) {
    if (!isNonEmptyTrimmedString(t, BENCHMARK_MAX_TAG_LENGTH)) {
      return fail(`${where}: each tag must be a non-empty string of at most ${BENCHMARK_MAX_TAG_LENGTH} characters`);
    }
    const trimmed = t.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      tags.push(trimmed);
    }
  }
  return ok(tags);
}

/** Validates one case. `where` is a caller-supplied label (e.g. a line number) for error text. */
export function validateBenchmarkCase(raw: unknown, where: string): ValidationResult<BenchmarkCase> {
  if (!isPlainObject(raw)) return fail(`${where}: case must be an object`);
  if (!isNonEmptyTrimmedString(raw.id, BENCHMARK_MAX_NAME_LENGTH)) {
    return fail(`${where}: id must be a non-empty string`);
  }
  const promptPresent = Object.prototype.hasOwnProperty.call(raw, 'prompt');
  const messagesPresent = Object.prototype.hasOwnProperty.call(raw, 'messages');
  if (promptPresent === messagesPresent) {
    return fail(`${where}: exactly one of prompt/messages must be present`);
  }
  if (promptPresent && !isNonEmptyTrimmedString(raw.prompt, BENCHMARK_MAX_TEXT_LENGTH)) {
    return fail(`${where}: prompt must be a non-empty string of at most ${BENCHMARK_MAX_TEXT_LENGTH} characters`);
  }
  let messages: BenchmarkMessage[] | undefined;
  if (messagesPresent) {
    if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
      return fail(`${where}: messages must be a non-empty array when present`);
    }
    if (raw.messages.length > BENCHMARK_MAX_MESSAGES_PER_CASE) {
      return fail(`${where}: at most ${BENCHMARK_MAX_MESSAGES_PER_CASE} messages per case`);
    }
    messages = [];
    for (let i = 0; i < raw.messages.length; i++) {
      const r = validateBenchmarkMessage(raw.messages[i], `${where}: messages[${i}]`);
      if (!r.ok) return fail(...r.errors);
      messages.push(r.value!);
    }
  }
  if (raw.expected !== undefined && !isNonEmptyTrimmedString(raw.expected, BENCHMARK_MAX_TEXT_LENGTH)) {
    return fail(`${where}: expected must be a non-empty string of at most ${BENCHMARK_MAX_TEXT_LENGTH} characters when present`);
  }
  const tagsResult = validateTags(raw.tags, where);
  if (!tagsResult.ok) return fail(...tagsResult.errors);

  const result: BenchmarkCase = { id: (raw.id as string).trim() };
  if (promptPresent) result.prompt = (raw.prompt as string).trim();
  if (messages) result.messages = messages;
  if (raw.expected !== undefined) result.expected = (raw.expected as string).trim();
  if (tagsResult.value !== undefined) result.tags = tagsResult.value;
  return ok(result);
}

function validateTarget(raw: unknown, where: string): ValidationResult<BenchmarkTarget> {
  if (!isPlainObject(raw)) return fail(`${where}: target must be an object`);
  if (!isNonEmptyTrimmedString(raw.alias, BENCHMARK_MAX_NAME_LENGTH)) {
    return fail(`${where}: alias must be a non-empty string`);
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'variantId')) {
    return fail(`${where}: variantId must be a non-empty string or null`);
  }
  if (raw.variantId !== null && !isNonEmptyTrimmedString(raw.variantId, BENCHMARK_MAX_NAME_LENGTH)) {
    return fail(`${where}: variantId must be a non-empty string or null`);
  }
  const variantId = raw.variantId === null ? null : (raw.variantId as string).trim();
  return ok({ alias: (raw.alias as string).trim(), variantId });
}

export interface ValidateBenchmarkSuiteOptions {
  /**
   * A pre-1.0 release accepted suites with two targets sharing an alias but different
   * `variantId`s. Tightening that rule (see the loop below) must not turn every already-stored
   * suite/run with that shape into an unreadable row — `isStoredBenchmarkSuite` sets this to
   * tolerate the legacy shape on read, while every write path (create/edit/import) keeps the
   * strict default so no new suite can be saved with the now-forbidden shape.
   */
  allowDuplicateAliases?: boolean;
}

/**
 * Validates a complete suite. All-or-nothing: any single invalid field, duplicate id, duplicate
 * target, or attempt-count/size overage rejects the whole suite with a full error list, rather
 * than silently dropping or repairing the offending part.
 */
export function validateBenchmarkSuite(
  raw: unknown,
  options: ValidateBenchmarkSuiteOptions = {},
): ValidationResult<BenchmarkSuite> {
  if (!isPlainObject(raw)) return fail('suite must be an object');
  const errors: string[] = [];

  if (!isNonEmptyTrimmedString(raw.id, BENCHMARK_MAX_NAME_LENGTH)) errors.push('id must be a non-empty string');
  if (!isNonEmptyTrimmedString(raw.name, BENCHMARK_MAX_NAME_LENGTH)) errors.push('name must be a non-empty string');
  if (raw.description !== undefined && !isNonEmptyTrimmedString(raw.description, BENCHMARK_MAX_DESCRIPTION_LENGTH)) {
    errors.push(`description must be a non-empty string of at most ${BENCHMARK_MAX_DESCRIPTION_LENGTH} characters when present`);
  }
  if (!isFiniteInteger(raw.createdAt) || (raw.createdAt as number) < 0
    || !Number.isFinite(new Date(raw.createdAt as number).getTime())) {
    errors.push('createdAt must be a valid Date timestamp');
  }

  const targets: BenchmarkTarget[] = [];
  if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > BENCHMARK_MAX_TARGETS) {
    errors.push(`targets must be an array of 1 to ${BENCHMARK_MAX_TARGETS} entries`);
  } else {
    // Keyed by alias alone, not alias+variant: the sidecar's model pool (and the load step
    // before a run) is keyed by alias, so a second target sharing an alias would silently
    // replace the first target's loaded variant before execution — the runner's alias-only
    // `chatCompletion` transport could then record an earlier target's attempts against
    // whichever variant happened to load last, not the one actually requested for that target.
    const seenAliases = new Set<string>();
    const seenExact = new Set<string>();
    for (let i = 0; i < raw.targets.length; i++) {
      const r = validateTarget(raw.targets[i], `targets[${i}]`);
      if (!r.ok) { errors.push(...r.errors); continue; }
      const exactKey = `${r.value!.alias}\0${r.value!.variantId ?? ''}`;
      if (seenExact.has(exactKey)) {
        errors.push(`targets[${i}]: duplicate target "${r.value!.alias}" / ${r.value!.variantId ?? 'default'}`);
        continue;
      }
      seenExact.add(exactKey);
      if (seenAliases.has(r.value!.alias) && !options.allowDuplicateAliases) {
        errors.push(`targets[${i}]: duplicate target alias "${r.value!.alias}" (targets are keyed by alias, not alias+variant)`);
        continue;
      }
      seenAliases.add(r.value!.alias);
      targets.push(r.value!);
    }
  }

  const cases: BenchmarkCase[] = [];
  if (!Array.isArray(raw.cases) || raw.cases.length < 1 || raw.cases.length > BENCHMARK_MAX_CASES) {
    errors.push(`cases must be an array of 1 to ${BENCHMARK_MAX_CASES} entries`);
  } else {
    const seenIds = new Set<string>();
    for (let i = 0; i < raw.cases.length; i++) {
      const r = validateBenchmarkCase(raw.cases[i], `cases[${i}]`);
      if (!r.ok) { errors.push(...r.errors); continue; }
      if (seenIds.has(r.value!.id)) { errors.push(`cases[${i}]: duplicate case id "${r.value!.id}"`); continue; }
      seenIds.add(r.value!.id);
      cases.push(r.value!);
    }
  }

  if (raw.temperature !== undefined
    && !(typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)
      && raw.temperature >= 0 && raw.temperature <= 2)) {
    errors.push('temperature must be a number between 0 and 2 when present');
  }
  if (raw.maxTokens !== undefined
    && !(isFiniteInteger(raw.maxTokens) && (raw.maxTokens as number) > 0
      && (raw.maxTokens as number) <= BENCHMARK_MAX_TOKENS_LIMIT)) {
    errors.push(`maxTokens must be an integer between 1 and ${BENCHMARK_MAX_TOKENS_LIMIT} when present`);
  }
  if (!isFiniteInteger(raw.warmupCount)
    || (raw.warmupCount as number) < BENCHMARK_MIN_WARMUP_COUNT || (raw.warmupCount as number) > BENCHMARK_MAX_WARMUP_COUNT) {
    errors.push(`warmupCount must be an integer between ${BENCHMARK_MIN_WARMUP_COUNT} and ${BENCHMARK_MAX_WARMUP_COUNT}`);
  }
  if (!isFiniteInteger(raw.repeatCount)
    || (raw.repeatCount as number) < BENCHMARK_MIN_REPEAT_COUNT || (raw.repeatCount as number) > BENCHMARK_MAX_REPEAT_COUNT) {
    errors.push(`repeatCount must be an integer between ${BENCHMARK_MIN_REPEAT_COUNT} and ${BENCHMARK_MAX_REPEAT_COUNT}`);
  }

  if (errors.length) return fail(...errors);

  const suite: BenchmarkSuite = {
    id: (raw.id as string).trim(),
    name: (raw.name as string).trim(),
    createdAt: raw.createdAt as number,
    targets,
    cases,
    warmupCount: raw.warmupCount as number,
    repeatCount: raw.repeatCount as number,
  };
  if (raw.description !== undefined) suite.description = (raw.description as string).trim();
  if (raw.temperature !== undefined) suite.temperature = raw.temperature as number;
  if (raw.maxTokens !== undefined) suite.maxTokens = raw.maxTokens as number;

  const attempts = benchmarkAttemptCount(suite);
  if (attempts > BENCHMARK_MAX_ATTEMPTS) {
    return fail(`suite would take ${attempts} attempts, exceeding the ${BENCHMARK_MAX_ATTEMPTS}-attempt preview limit`);
  }

  return ok(suite);
}

/** Type guard for defense-in-depth checks on data read back from storage. Strict: matches the
 * rules a create/edit write must satisfy. Use `isStoredBenchmarkSuite` instead when checking a
 * row that predates a validation tightening, so an old shape does not become unreadable. */
export function isBenchmarkSuite(value: unknown): value is BenchmarkSuite {
  return validateBenchmarkSuite(value).ok;
}

/** Defense-in-depth shape check for a suite (or a run's embedded suite snapshot) read back from
 * storage, tolerant of the pre-1.0 shape that allowed two targets to share an alias with
 * different `variantId`s. Never use this for a create/edit write — only for reading rows that
 * may already be persisted under the older, looser rule. */
export function isStoredBenchmarkSuite(value: unknown): value is BenchmarkSuite {
  return validateBenchmarkSuite(value, { allowDuplicateAliases: true }).ok;
}

export interface JsonlImportResult {
  ok: boolean;
  cases?: BenchmarkCase[];
  error?: string;
}

/**
 * Parses JSONL benchmark cases: one case object per non-blank line, `prompt` XOR `messages`
 * (matching `BenchmarkCase`). Atomic — any malformed, duplicate-id, or over-limit row rejects
 * the whole import with a line-numbered message; nothing is silently dropped or repaired.
 *
 * A row with no `id` key at all gets one derived from its 1-based line number
 * (`case-line-<n>`); a row with a present-but-blank `id` is rejected as malformed, not treated
 * as absent. Explicit ids are collected first so a generated id can never silently collide with
 * one the file itself supplied — that would reject the import instead, like any other
 * duplicate id.
 */
export function parseBenchmarkCasesJsonl(text: string): JsonlImportResult {
  if (text.length > BENCHMARK_MAX_JSONL_CHARS) {
    return { ok: false, error: `file is larger than ${BENCHMARK_MAX_JSONL_CHARS} characters` };
  }
  const lines = text.split(/\r?\n/);
  const rawRows: Array<{ lineNumber: number; raw: unknown }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const lineNumber = i + 1;
    if (rawRows.length >= BENCHMARK_MAX_CASES) {
      return { ok: false, error: `file has more than ${BENCHMARK_MAX_CASES} cases, exceeding the ${BENCHMARK_MAX_CASES}-case limit` };
    }
    if (line.length > BENCHMARK_MAX_JSONL_LINE_CHARS) {
      return { ok: false, error: `line ${lineNumber}: exceeds ${BENCHMARK_MAX_JSONL_LINE_CHARS} characters` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, error: `line ${lineNumber}: not valid JSON` };
    }
    rawRows.push({ lineNumber, raw: parsed });
  }
  if (rawRows.length === 0) return { ok: false, error: 'no cases found in the file' };

  const explicitIds = new Set<string>();
  for (const { raw } of rawRows) {
    if (isPlainObject(raw) && typeof raw.id === 'string' && raw.id.trim()) {
      explicitIds.add(raw.id.trim());
    }
  }

  const cases: BenchmarkCase[] = [];
  const seenIds = new Set<string>();
  for (const { lineNumber, raw } of rawRows) {
    let row = raw;
    // A present-but-blank id is malformed input, not "missing" — only a genuinely absent `id`
    // key is eligible for a generated id.
    if (isPlainObject(raw) && typeof raw.id === 'string' && !raw.id.trim()) {
      return { ok: false, error: `line ${lineNumber}: id must be a non-empty string when present` };
    }
    if (isPlainObject(raw) && raw.id === undefined) {
      const generatedId = `case-line-${lineNumber}`;
      if (explicitIds.has(generatedId) || seenIds.has(generatedId)) {
        return { ok: false, error: `line ${lineNumber}: generated id "${generatedId}" collides with another case's id` };
      }
      row = { ...raw, id: generatedId };
    }
    const result = validateBenchmarkCase(row, `line ${lineNumber}`);
    if (!result.ok) return { ok: false, error: result.errors.join('; ') };
    if (seenIds.has(result.value!.id)) {
      return { ok: false, error: `line ${lineNumber}: duplicate case id "${result.value!.id}"` };
    }
    seenIds.add(result.value!.id);
    cases.push(result.value!);
  }

  return { ok: true, cases };
}
