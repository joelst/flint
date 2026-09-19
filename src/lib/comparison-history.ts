/**
 * Model Arena "Quick Compare" — types, identity, storage, and export.
 *
 * Extracted from `+page.svelte` as a pure, testable module. This is intentionally a
 * behavior-preserving extraction: the on-disk shape (`flint-comparisons-v1`), slot identity,
 * and Markdown export format are unchanged. The one real change is that storage failures are no
 * longer swallowed — reading unreadable/corrupt bytes blocks further writes until the caller
 * preserves them, matching the rule already established for the conversation archive in
 * `conversation-repository.ts`: **a read we did not fully understand must never become a
 * write.**
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

function isCompareSlot(value: unknown): value is CompareSlot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.key === 'string' && typeof v.alias === 'string'
    && (v.variantId === null || typeof v.variantId === 'string')
    && typeof v.label === 'string';
}

function isCompareResult(value: unknown): value is CompareResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.content === 'string';
}

function isSavedComparison(value: unknown): value is SavedComparison {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.createdAt !== 'number' || typeof v.prompt !== 'string') {
    return false;
  }
  if (!Array.isArray(v.slots) || !v.slots.every(isCompareSlot)) return false;
  if (!v.results || typeof v.results !== 'object') return false;
  return Object.values(v.results as Record<string, unknown>).every(isCompareResult);
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
  /** False when a subsequent save must not be attempted without first resolving `notice`. */
  writable: boolean;
  /** True when unreadable/corrupt bytes were parked under `COMPARE_HISTORY_BACKUP_KEY`. */
  backedUp: boolean;
  /** Present when the caller should surface something to the user; null on a clean load. */
  notice: string | null;
}

/**
 * Loads saved comparison history. Never throws: storage access failures and malformed bytes
 * both come back as an empty, non-writable result with a `notice` rather than an exception, so
 * a damaged key cannot crash the Arena tab and cannot be silently replaced by an empty array.
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
