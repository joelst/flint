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
  benchmarkAttemptCount,
  isFiniteInteger,
  parseBenchmarkCasesJsonl,
  validateBenchmarkSuite,
  type BenchmarkSuite,
  type BenchmarkTarget,
  type ValidationResult,
} from './benchmark-suite';

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
  temperature?: number;
  maxTokens?: number;
  warmupCount: number;
  repeatCount: number;
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
    // so `try/catch` alone cannot catch this. Validate up front — the same check Save's real
    // validation applies — so a live preview shows nothing rather than "Estimated attempts: NaN".
    if (!isFiniteInteger(draft.warmupCount) || !isFiniteInteger(draft.repeatCount)) return null;
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
  if (draft.temperature !== undefined) raw.temperature = draft.temperature;
  if (draft.maxTokens !== undefined) raw.maxTokens = draft.maxTokens;

  return validateBenchmarkSuite(raw);
}
