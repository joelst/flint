/**
 * Suite create/edit form <-> `BenchmarkSuite` normalization.
 *
 * The create/edit UI works with a plain-strings draft shape (a JSONL textarea for cases,
 * optional numeric fields as they arrive from form inputs) rather than a `BenchmarkSuite`
 * directly. This module is the only place that turns one into the other, so the UI never
 * hand-rolls its own suite-shape assumptions and always goes through the real
 * `parseBenchmarkCasesJsonl`/`validateBenchmarkSuite` — the exact same functions a JSONL-file
 * import or a hand-authored suite would go through.
 */

import {
  BENCHMARK_MAX_CASES,
  BENCHMARK_MAX_JSONL_CHARS,
  BENCHMARK_MAX_JSONL_LINE_CHARS,
  BENCHMARK_MAX_NAME_LENGTH,
  BENCHMARK_MAX_REPEAT_COUNT,
  BENCHMARK_MAX_WARMUP_COUNT,
  BENCHMARK_MIN_REPEAT_COUNT,
  BENCHMARK_MIN_WARMUP_COUNT,
  benchmarkAttemptCount,
  isFiniteInteger,
  parseBenchmarkCasesJsonl,
  validateBenchmarkCase,
  validateBenchmarkSuite,
  type BenchmarkCase,
  type BenchmarkSuite,
  type BenchmarkTarget,
  type ValidationResult,
} from './benchmark-suite';

/** True when this draft is a pending edit of a stored suite (create-new drafts have no `id`). */
export function draftEditsSuite(
  draft: Pick<SuiteDraft, 'id'> | null | undefined,
  suiteId: string,
): boolean {
  return typeof draft?.id === 'string' && draft.id === suiteId;
}

export interface SuiteDraft {
  /** Present when editing an existing suite; absent when creating a new one. */
  id?: string;
  /** Preserved across edits; a new suite gets `Date.now()` at build time if omitted. */
  createdAt?: number;
  name: string;
  description?: string;
  targets: BenchmarkTarget[];
  /** One JSON case object per non-blank line — the same shape `parseBenchmarkCasesJsonl` (and
   * a JSONL file import) already accepts. */
  casesJsonl: string;
  /**
   * Empty number inputs arrive as null or ''. Those mean "runtime default", not a numeric
   * value — `optionalDraftNumber` drops them before validation.
   */
  temperature?: number | string | null;
  maxTokens?: number | string | null;
  warmupCount: number;
  repeatCount: number;
}

/** A prompt the form can edit, or a messages-array case preserved verbatim so Save does not
 * flatten it into a single prompt. */
export type SuiteCaseRow =
  | { kind: 'prompt'; id: string; prompt: string; expected: string; tagsJson: string }
  | { kind: 'messages'; id: string; messageCount: number; jsonlLine: string };

/**
 * Number inputs clear to null or '' while the field is empty. Those mean "runtime default".
 * A non-numeric entry is returned as NaN so `validateBenchmarkSuite` rejects it instead of
 * the form inventing a second error string.
 */
export function optionalDraftNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    return Number(value);
  }
  if (typeof value === 'number') return value;
  return undefined;
}

/**
 * `File.size` is bytes while the suite limit is JavaScript string length. UTF-8 needs at most
 * three bytes per UTF-16 code unit, so only a file above this bound is guaranteed not to fit.
 */
export function jsonlImportCanFitCharacterLimit(
  byteLength: number,
  characterLimit: number = BENCHMARK_MAX_JSONL_CHARS,
): boolean {
  return byteLength <= characterLimit * 3;
}

function caseToRow(entry: BenchmarkCase): SuiteCaseRow {
  if (entry.messages) {
    return {
      kind: 'messages',
      id: entry.id,
      messageCount: entry.messages.length,
      jsonlLine: JSON.stringify(entry),
    };
  }
  return {
    kind: 'prompt',
    id: entry.id,
    prompt: entry.prompt ?? '',
    expected: entry.expected ?? '',
    tagsJson: entry.tags ? JSON.stringify(entry.tags) : '',
  };
}

/** Blank text is an empty form, not a parse error — a new suite has no cases yet. */
export function caseRowsFromJsonl(text: string): { ok: true; rows: SuiteCaseRow[] } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, rows: [] };
  const parsed = parseBenchmarkCasesJsonl(text);
  if (!parsed.ok || !parsed.cases) return { ok: false, error: parsed.error ?? 'cases are invalid' };
  return { ok: true, rows: parsed.cases.map(caseToRow) };
}

export function jsonlFromCaseRows(rows: readonly SuiteCaseRow[]): string {
  return rows.map((row) => {
    if (row.kind === 'messages') return row.jsonlLine;
    const raw: Record<string, unknown> = { id: row.id, prompt: row.prompt };
    if (row.expected.trim()) raw.expected = row.expected;
    if (row.tagsJson.trim()) {
      try {
        const parsedTags = JSON.parse(row.tagsJson);
        raw.tags = parsedTags;
      } catch {
        // Keep the generated JSONL valid while preserving a value the suite validator rejects.
        raw.tags = row.tagsJson;
      }
    }
    return JSON.stringify(raw);
  }).join('\n');
}

export function tagsJsonError(raw: string): string | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'Tags must be valid JSON.';
  }
  const result = validateBenchmarkCase({ id: 'preview', prompt: 'preview', tags: parsed }, 'case');
  if (result.ok) return null;
  return result.errors[0]?.replace(/^case: /, '') ?? 'Tags are invalid.';
}

export function newPromptCaseRow(existingIds: readonly string[]): SuiteCaseRow {
  const taken = new Set(existingIds.map((id) => id.trim()));
  let n = existingIds.length + 1;
  let id = `c${n}`;
  while (taken.has(id)) {
    n += 1;
    id = `c${n}`;
  }
  return { kind: 'prompt', id, prompt: '', expected: '', tagsJson: '' };
}

/** "copy" suffix, shortened so the result still fits the suite name limit. */
export function copiedSuiteName(name: string): string {
  const suffix = ' copy';
  const base = name.trim();
  const combined = base ? `${base}${suffix}` : 'copy';
  if (combined.length <= BENCHMARK_MAX_NAME_LENGTH) return combined;
  return base.slice(0, BENCHMARK_MAX_NAME_LENGTH - suffix.length) + suffix;
}

/** A new draft: no id and no createdAt, so Save inserts a suite with no run history. */
export function duplicateSuiteDraft(suite: BenchmarkSuite): SuiteDraft {
  const draft = draftFromSuite(suite);
  delete draft.id;
  delete draft.createdAt;
  draft.name = copiedSuiteName(suite.name);
  const seenAliases = new Set<string>();
  draft.targets = draft.targets.filter((target) => {
    const alias = target.alias.trim();
    if (seenAliases.has(alias)) return false;
    seenAliases.add(alias);
    return true;
  });
  return draft;
}

/** Variant ids that are already on disk — Start loads, it does not download. */
export function cachedVariantIds(
  variants: readonly { id: string; cached: boolean }[] | undefined,
): string[] {
  return (variants ?? []).filter((v) => v.cached).map((v) => v.id);
}

export type VariantChoice = { id: string; available: boolean };

/** Cached builds plus the currently stored id, even if it is no longer downloaded.
 * Opening Edit must not silently rewrite a stored explicit variant. */
export type AliasChoice = { alias: string; available: boolean };

/** Cached/loaded aliases plus the currently stored alias, even if it is no longer in the picker. */
export function aliasChoicesForTarget(
  availableAliases: readonly string[],
  currentAlias: string,
): AliasChoice[] {
  const choices: AliasChoice[] = [];
  if (currentAlias && !availableAliases.includes(currentAlias)) {
    choices.push({ alias: currentAlias, available: false });
  }
  for (const alias of availableAliases) {
    choices.push({ alias, available: true });
  }
  return choices;
}

export function variantChoicesForTarget(
  cachedIds: readonly string[],
  currentId: string | null,
): VariantChoice[] {
  const choices: VariantChoice[] = [];
  if (currentId && !cachedIds.includes(currentId)) {
    choices.push({ id: currentId, available: false });
  }
  for (const id of cachedIds) {
    choices.push({ id, available: true });
  }
  return choices;
}

/** Live preview of attempt count. Shares the JSONL size/case caps with the parser so a huge
 * paste cannot split-allocate on every reactive tick; Save still does the real parse. */
export function estimateDraftAttempts(
  draft: Pick<SuiteDraft, 'targets' | 'casesJsonl' | 'warmupCount' | 'repeatCount'>,
): number | null {
  const text = draft.casesJsonl;
  if (text.length > BENCHMARK_MAX_JSONL_CHARS) return null;
  let caseCount = 0;
  let lineLen = 0;
  let sawContent = false;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : 10;
    if (c === 10) {
      if (lineLen > BENCHMARK_MAX_JSONL_LINE_CHARS) return null;
      if (sawContent) {
        caseCount++;
        if (caseCount > BENCHMARK_MAX_CASES) return null;
      }
      lineLen = 0;
      sawContent = false;
    } else if (c !== 13) {
      lineLen++;
      if (c !== 32 && c !== 9) sawContent = true;
    }
  }
  try {
    // `warmupCount`/`repeatCount` are typed as `number` but Svelte's bind:value on a number
    // input yields `undefined`/a partial string coercion while the field is empty or mid-edit;
    // arithmetic with a non-finite/non-integer value returns NaN silently rather than throwing,
    // so `try/catch` alone cannot catch this. Validate up front — the same bounds check Save's
    // real validation (`validateBenchmarkSuite`) applies — so a live preview shows nothing
    // rather than a misleading zero/negative "Estimated attempts" for an out-of-range value
    // (e.g. warmup -1 or repeat 0) that Save would reject outright.
    if (!isFiniteInteger(draft.warmupCount)
      || draft.warmupCount < BENCHMARK_MIN_WARMUP_COUNT || draft.warmupCount > BENCHMARK_MAX_WARMUP_COUNT) {
      return null;
    }
    if (!isFiniteInteger(draft.repeatCount)
      || draft.repeatCount < BENCHMARK_MIN_REPEAT_COUNT || draft.repeatCount > BENCHMARK_MAX_REPEAT_COUNT) {
      return null;
    }
    return benchmarkAttemptCount({
      targets: draft.targets,
      cases: { length: caseCount },
      warmupCount: draft.warmupCount,
      repeatCount: draft.repeatCount,
    });
  } catch {
    return null;
  }
}

/**
 * Rebind a draft target to a new alias. A variant id is only meaningful on the model it was
 * chosen from — keeping `model-a`'s `v1` after switching to `model-b` would load the wrong
 * build or fail. Preserve the id only when the new alias actually exposes it.
 */

export function applyTargetAlias(
  target: BenchmarkTarget,
  alias: string,
  variantIdsOnNewAlias: readonly string[],
): BenchmarkTarget {
  if (target.alias === alias) return { ...target, alias };
  const keep = target.variantId != null && variantIdsOnNewAlias.includes(target.variantId);
  return { alias, variantId: keep ? target.variantId : null };
}

function generateSuiteId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `suite_${crypto.randomUUID()}`;
  }
  return `suite_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/** Builds an edit draft from a stored suite (round-trips its cases back into JSONL text). */
export function draftFromSuite(suite: BenchmarkSuite): SuiteDraft {
  const draft: SuiteDraft = {
    id: suite.id,
    createdAt: suite.createdAt,
    name: suite.name,
    targets: suite.targets.map((t) => ({ ...t })),
    casesJsonl: suite.cases.map((c) => JSON.stringify(c)).join('\n'),
    warmupCount: suite.warmupCount,
    repeatCount: suite.repeatCount,
  };
  if (suite.description !== undefined) draft.description = suite.description;
  if (suite.temperature !== undefined) draft.temperature = suite.temperature;
  if (suite.maxTokens !== undefined) draft.maxTokens = suite.maxTokens;
  return draft;
}

/**
 * Parses `draft.casesJsonl` and validates the assembled suite. Returns the same
 * `ValidationResult` shape `validateBenchmarkSuite` does, so the form can show the identical
 * error text a JSONL-file import or an API-level suite would produce — no separate,
 * possibly-drifting draft-only error strings.
 */
export function buildSuiteFromDraft(draft: SuiteDraft, now: number = Date.now()): ValidationResult<BenchmarkSuite> {
  const jsonl = parseBenchmarkCasesJsonl(draft.casesJsonl);
  if (!jsonl.ok) return { ok: false, errors: [jsonl.error ?? 'cases are invalid'] };

  const raw: Record<string, unknown> = {
    id: draft.id ?? generateSuiteId(),
    name: draft.name,
    createdAt: draft.createdAt ?? now,
    targets: draft.targets,
    cases: jsonl.cases,
    warmupCount: draft.warmupCount,
    repeatCount: draft.repeatCount,
  };
  if (draft.description !== undefined && draft.description.trim()) raw.description = draft.description;
  const temperature = optionalDraftNumber(draft.temperature);
  const maxTokens = optionalDraftNumber(draft.maxTokens);
  if (temperature !== undefined) raw.temperature = temperature;
  if (maxTokens !== undefined) raw.maxTokens = maxTokens;

  return validateBenchmarkSuite(raw);
}
