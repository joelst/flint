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

/**
 * Rebind a draft target to a new alias. A variant id is only meaningful on the model it was
 * chosen from — keeping `model-a`'s `v1` after switching to `model-b` would load the wrong
 * build or fail. Preserve the id only when the new alias actually exposes it.
 */
/** Variant ids that are already on disk — Start loads, it does not download. */
export function cachedVariantIds(
  variants: readonly { id: string; cached: boolean }[] | undefined,
): string[] {
  return (variants ?? []).filter((v) => v.cached).map((v) => v.id);
}

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
