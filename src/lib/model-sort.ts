/**
 * Model list sorting and grouping helpers.
 *
 * The Foundry Local catalog reports `family` as null for every model today, so a
 * family grouping has to be derived from the alias. Derivation is only ever used
 * as a *sort/group key* and as an *additional* search target — never as the sole
 * filter dimension, so a bad derivation can never hide a model from the list.
 */

export type ModelSortKey = 'family' | 'name' | 'newest';

export const MODEL_SORT_OPTIONS: Array<{ value: ModelSortKey; label: string }> = [
  { value: 'family', label: 'Model family' },
  { value: 'name', label: 'Model name' },
  // The catalog exposes `createdAt`, not a modification date. Label it honestly.
  { value: 'newest', label: 'Newest first' },
];

export function isModelSortKey(value: unknown): value is ModelSortKey {
  return value === 'family' || value === 'name' || value === 'newest';
}

/** Tokens that mark the start of a size/variant suffix rather than the family name. */
const VARIANT_TOKENS = new Set([
  'instruct', 'chat', 'reasoning', 'turbo', 'base', 'tiny', 'small', 'medium',
  'large', 'mini', 'preview', 'it', 'text', 'vision', 'distill',
]);

/** Matches parameter-count tokens such as `7b`, `0.5b`, `600m`. */
const SIZE_TOKEN = /^\d+(\.\d+)?[bm]$/i;
/** Matches version tokens such as `v2`, `v0.2`, `v3`. */
const VERSION_TOKEN = /^v\d+(\.\d+)?$/i;
/** Matches bare date-ish/build tokens such as `2512`. */
const BUILD_TOKEN = /^\d{3,}$/;

/**
 * Derive a family label from a model alias by stripping trailing size/variant tokens.
 * `qwen2.5-coder-7b` -> `qwen2.5-coder`, `whisper-large-v3-turbo` -> `whisper`.
 */
export function deriveModelFamily(alias: string | null | undefined): string {
  const raw = String(alias ?? '').trim().toLowerCase();
  if (!raw) return '';
  const parts = raw.split('-').filter(Boolean);
  const kept: string[] = [];
  for (const part of parts) {
    if (SIZE_TOKEN.test(part) || VERSION_TOKEN.test(part) || BUILD_TOKEN.test(part)) break;
    if (VARIANT_TOKENS.has(part)) break;
    kept.push(part);
  }
  // Never return empty: an alias that is entirely variant tokens keeps its full name.
  return kept.length ? kept.join('-') : raw;
}

/** Family label shown in the UI, falling back to the catalog value when present. */
export function modelFamilyLabel(model: any): string {
  const catalogFamily = typeof model?.family === 'string' ? model.family.trim() : '';
  if (catalogFamily) return catalogFamily.toLowerCase();
  return deriveModelFamily(model?.alias);
}

function compareAlias(a: any, b: any): number {
  return String(a?.alias ?? '').localeCompare(String(b?.alias ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Catalog publish time (unix seconds). Foundry nests model metadata inconsistently,
 * so probe the same locations as `formatModelUpdated` in the Models view and coerce,
 * otherwise every model scores 0 and "Newest" silently degrades to alphabetical.
 */
function createdAtOf(model: any): number {
  const raw =
    model?.createdAt ??
    model?.createdAtUnix ??
    model?.info?.createdAt ??
    model?.info?.createdAtUnix ??
    model?.info?.info?.createdAt ??
    model?.info?.info?.createdAtUnix ??
    null;
  const unix = Number(raw);
  if (!Number.isFinite(unix) || unix <= 0) return 0;
  // Foundry reports seconds; tolerate millisecond values just in case.
  return unix > 1e12 ? unix : unix * 1000;
}

/**
 * Returns a new sorted array; the input is not mutated.
 * All comparators fall back to alias order so the result is stable and deterministic.
 */
export function sortModels<T>(models: readonly T[], key: ModelSortKey): T[] {
  const list = [...(models ?? [])];
  if (key === 'name') {
    return list.sort(compareAlias);
  }
  if (key === 'newest') {
    return list.sort((a, b) => {
      const diff = createdAtOf(b) - createdAtOf(a);
      return diff !== 0 ? diff : compareAlias(a, b);
    });
  }
  return list.sort((a, b) => {
    const famDiff = modelFamilyLabel(a).localeCompare(modelFamilyLabel(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    return famDiff !== 0 ? famDiff : compareAlias(a, b);
  });
}

/**
 * Search predicate. Deliberately additive: a model matches if the query hits the
 * alias OR the derived family, so a mis-derived family can never hide a model.
 */
export function modelMatchesSearch(model: any, term: string): boolean {
  const needle = String(term ?? '').trim().toLowerCase();
  if (!needle) return true;
  const alias = String(model?.alias ?? '').toLowerCase();
  if (alias.includes(needle)) return true;
  return modelFamilyLabel(model).includes(needle);
}
