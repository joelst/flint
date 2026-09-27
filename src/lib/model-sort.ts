/** How the model catalog list is ordered. */
export type ModelSortMode = 'name' | 'family' | 'updated';

export const MODEL_SORT_MODES: ModelSortMode[] = ['name', 'family', 'updated'];

export function isModelSortMode(value: unknown): value is ModelSortMode {
  return typeof value === 'string' && (MODEL_SORT_MODES as string[]).includes(value);
}

/**
 * The catalog reports `createdAt` in unix *seconds*, and omits it for some models.
 * A missing date sorts as oldest rather than as "now", so unknown models do not
 * displace genuinely recent ones at the top of the list.
 */
export function modelUpdatedAt(model: any): number {
  const raw = model?.createdAt ?? model?.info?.createdAt ?? null;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

const VARIANT_TOKENS = new Set([
  'instruct', 'chat', 'reasoning', 'turbo', 'base', 'tiny', 'small', 'medium',
  'large', 'mini', 'preview', 'it', 'text', 'vision', 'distill',
]);
const SIZE_TOKEN = /^\d+(\.\d+)?[bm]$/i;
const VERSION_TOKEN = /^v\d+(\.\d+)?$/i;
const BUILD_TOKEN = /^\d{3,}$/;

export function deriveModelFamily(alias: string | null | undefined): string {
  const raw = String(alias ?? '').trim().toLowerCase();
  if (!raw) return '';
  const parts = raw.split('-').filter(Boolean);
  const family: string[] = [];
  for (const part of parts) {
    if (
      SIZE_TOKEN.test(part) ||
      VERSION_TOKEN.test(part) ||
      BUILD_TOKEN.test(part) ||
      VARIANT_TOKENS.has(part)
    ) {
      break;
    }
    family.push(part);
  }
  return family.length > 0 ? family.join('-') : raw;
}

export function modelFamilyLabel(model: any): string {
  const catalogFamily = String(model?.family ?? model?.info?.family ?? '').trim();
  if (catalogFamily) return catalogFamily.toLowerCase();
  const alias = String(model?.alias ?? '').trim().toLowerCase();
  const derived = deriveModelFamily(alias);
  return derived && derived !== alias ? derived : '';
}

export function modelMatchesSearch(model: any, term: string): boolean {
  const needle = String(term ?? '').trim().toLowerCase();
  if (!needle) return true;
  const alias = String(model?.alias ?? '').toLowerCase();
  return alias.includes(needle) || modelFamilyLabel(model).includes(needle);
}

/**
 * Order two labels the way a reader expects (`phi-9` before `phi-10`), then break ties
 * on the raw string.
 *
 * `numeric` + `sensitivity: 'base'` deliberately ignore padding and case, so it returns
 * 0 for distinct labels such as `phi-4`/`phi-04`. Returning that directly would leave
 * the order dependent on input sequence, which splits family headings (the list renders
 * a heading whenever the label differs from the previous row) and reshuffles the list on
 * every refresh. The tie-break only ever separates labels that are genuinely different.
 */
function compareLabels(a: string, b: string): number {
  const natural = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  if (natural !== 0) return natural;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two models for the chosen ordering.
 *
 * Every mode falls through to alias so the order is total: without a tie-break the list
 * reshuffles on each refresh whenever two models share a family or a date.
 */
export function compareModels(a: any, b: any, mode: ModelSortMode): number {
  if (mode === 'updated') {
    const diff = modelUpdatedAt(b) - modelUpdatedAt(a); // newest first
    if (diff !== 0) return diff;
  } else if (mode === 'family') {
    const fa = modelFamilyLabel(a);
    const fb = modelFamilyLabel(b);
    if (fa !== fb) {
      // Models with no family belong at the end, not under a blank heading.
      if (!fa) return 1;
      if (!fb) return -1;
      return compareLabels(fa, fb);
    }
  }
  return compareLabels(String(a?.alias ?? ''), String(b?.alias ?? ''));
}

/** Sort a copy, so the caller's array (and any reactive state) is left alone. */
export function sortModels<T>(models: T[], mode: ModelSortMode): T[] {
  return [...models].sort((a, b) => compareModels(a, b, mode));
}
