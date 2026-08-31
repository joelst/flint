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

function familyOf(model: any): string {
  return String(model?.family ?? model?.info?.family ?? '').toLowerCase();
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
    const fa = familyOf(a);
    const fb = familyOf(b);
    if (fa !== fb) {
      // Models with no family belong at the end, not under a blank heading.
      if (!fa) return 1;
      if (!fb) return -1;
      return fa.localeCompare(fb);
    }
  }
  return String(a?.alias ?? '').localeCompare(String(b?.alias ?? ''));
}

/** Sort a copy, so the caller's array (and any reactive state) is left alone. */
export function sortModels<T>(models: T[], mode: ModelSortMode): T[] {
  return [...models].sort((a, b) => compareModels(a, b, mode));
}
