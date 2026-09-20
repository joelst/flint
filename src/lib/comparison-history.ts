/**
 * Arena Quick Compare identity and storage. Slot keys and the on-disk shape are stable;
 * unread or corrupt bytes are parked before any later save can replace them.
 */

import { preserveBytes, type StorageAdapter } from './conversation-repository';

export const COMPARE_HISTORY_KEY = 'flint-comparisons-v1';
export const COMPARE_HISTORY_BACKUP_KEY = 'flint-comparisons-v1.backup';
export const COMPARE_MAX_SLOTS = 3;
export const COMPARE_HISTORY_MAX = 30;

export type CompareSlot = {
  key: string;
  alias: string;
  variantId: string | null;
  label: string;
  deviceType?: string | null;
  executionProvider?: string | null;
};

export type CompareResult = {
  content: string;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  rating?: 'up' | 'down' | null;
  error?: string;
};

export type SavedComparison = {
  id: string;
  createdAt: number;
  prompt: string;
  slots: CompareSlot[];
  results: Record<string, CompareResult>;
};

/** Identifies a slot for dedup/removal. Same alias with a different variant is a distinct slot. */
export function compareSlotKey(alias: string, variantId: string | null): string {
  return variantId ? `${alias}::${variantId}` : `${alias}::default`;
}

/** Copies the results map and each result so a later in-place edit cannot mutate saved history. */
export function cloneCompareResults(
  results: Record<string, CompareResult>,
): Record<string, CompareResult> {
  return Object.fromEntries(
    Object.entries(results).map(([key, value]) => [key, { ...value }]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isValidCreatedAt(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isFinite(new Date(value).getTime());
}

function isOptionalRating(value: unknown): boolean {
  return value === undefined || value === null || value === 'up' || value === 'down';
}

function isCompareSlot(value: unknown): value is CompareSlot {
  if (!isPlainObject(value)) return false;
  if (typeof value.key !== 'string' || typeof value.alias !== 'string'
    || (value.variantId !== null && typeof value.variantId !== 'string')
    || typeof value.label !== 'string'
    || !isOptionalStringOrNull(value.deviceType)
    || !isOptionalStringOrNull(value.executionProvider)) {
    return false;
  }
  return value.key === compareSlotKey(value.alias, value.variantId);
}

function isCompareResult(value: unknown): value is CompareResult {
  if (!isPlainObject(value)) return false;
  return typeof value.content === 'string'
    && isOptionalFiniteNumber(value.latencyMs)
    && isOptionalFiniteNumber(value.tokensIn)
    && isOptionalFiniteNumber(value.tokensOut)
    && isOptionalRating(value.rating)
    && isOptionalString(value.error);
}

function isSavedComparison(value: unknown): value is SavedComparison {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== 'string' || !isValidCreatedAt(value.createdAt) || typeof value.prompt !== 'string') {
    return false;
  }
  if (!Array.isArray(value.slots) || !value.slots.every(isCompareSlot)) return false;
  if (!isPlainObject(value.results)) return false;
  return Object.values(value.results).every(isCompareResult);
}

/**
 * Parses stored history bytes, distinguishing "nothing saved yet" from "saved bytes exist but
 * are not a comparison history". A single malformed entry invalidates the whole array rather
 * than being silently dropped — a saved run's own bytes are never rewritten once corrupt.
 */
function parseComparisonHistory(raw: string): { history: SavedComparison[] } | { corrupt: true } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { corrupt: true };
  }
  if (!Array.isArray(parsed) || !parsed.every(isSavedComparison)) {
    return { corrupt: true };
  }
  return { history: parsed };
}

export interface LoadHistoryResult {
  history: SavedComparison[];
  /**
   * False only when a later save would destroy bytes we could not park (unreadable storage
   * or a failed backup). Missing key and corrupt-but-backed-up loads stay writable.
   */
  writable: boolean;
  /** True when unreadable/corrupt bytes were parked under `COMPARE_HISTORY_BACKUP_KEY`. */
  backedUp: boolean;
  /** Present when the caller should surface something to the user; null on a clean load. */
  notice: string | null;
}

/**
 * Loads saved comparison history. Never throws.
 *
 * Missing key → empty, writable. Unreadable storage or failed backup → empty, not writable.
 * Corrupt bytes that were parked → empty, writable, original data under the backup key.
 */
export function loadComparisonHistory(storage: StorageAdapter): LoadHistoryResult {
  let raw: string | null;
  try {
    raw = storage.getItem(COMPARE_HISTORY_KEY);
  } catch {
    return {
      history: [],
      writable: false,
      backedUp: false,
      notice:
        'Saved arena runs could not be read on this device, so new runs will not be saved this session.',
    };
  }

  if (raw === null) {
    return { history: [], writable: true, backedUp: false, notice: null };
  }

  const parsed = parseComparisonHistory(raw);
  if ('corrupt' in parsed) {
    const backedUp = preserveBytes(storage, COMPARE_HISTORY_BACKUP_KEY, raw);
    return {
      history: [],
      writable: backedUp,
      backedUp,
      notice: backedUp
        ? 'Saved arena runs could not be read and were not in the expected format. A copy of the original data was kept; new runs will start a fresh history.'
        : 'Saved arena runs could not be read, and a backup copy could not be written, so new runs will not be saved this session.',
    };
  }

  return { history: parsed.history, writable: true, backedUp: false, notice: null };
}

export interface SaveHistoryResult {
  ok: boolean;
  error: string | null;
}

/**
 * Persists comparison history, bounded to `COMPARE_HISTORY_MAX` most recent entries.
 * Returns success/failure explicitly instead of swallowing the error, so a caller can tell the
 * user a save did not actually happen (e.g. quota exhaustion) rather than reporting "saved".
 */
export function saveComparisonHistory(
  storage: StorageAdapter,
  history: SavedComparison[],
): SaveHistoryResult {
  try {
    storage.setItem(COMPARE_HISTORY_KEY, JSON.stringify(history.slice(0, COMPARE_HISTORY_MAX)));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Renders one saved or in-progress run as the existing Markdown export format. */
export function renderComparisonMarkdown(
  prompt: string,
  slots: CompareSlot[],
  results: Record<string, CompareResult>,
): string {
  let md = `# Model Arena\n\n**Date:** ${new Date().toISOString()}\n\n**Prompt:** ${prompt}\n\n`;
  for (const slot of slots) {
    const r = results[slot.key];
    if (!r) continue;
    md += `## ${slot.label}\n`;
    md += `- Alias: \`${slot.alias}\`\n`;
    if (slot.variantId) md += `- Variant: \`${slot.variantId}\`\n`;
    md += `- Latency: ${r.latencyMs ?? '?'} ms\n`;
    md += `- Tokens: in ${r.tokensIn ?? '?'} / out ${r.tokensOut ?? '?'}\n`;
    md += `- Rating: ${r.rating || 'none'}\n\n`;
    md += `${r.content}\n\n---\n\n`;
  }
  return md;
}
