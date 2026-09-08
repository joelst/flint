/**
 * Pure helpers for reading Flint's persisted UI state.
 *
 * These are deliberately free of `localStorage` access so the hydration decision — "is this
 * blob usable, and may autosave overwrite it?" — can be tested directly. The component owns
 * the storage I/O and the field-by-field assignment.
 */

export interface PersistParseResult {
  /** Parsed settings object, or null when there is nothing usable to restore. */
  data: Record<string, any> | null;
  /**
   * True when a stored value existed but could not be used. The caller must preserve the raw
   * bytes before allowing autosave to replace them.
   */
  corrupt: boolean;
}

/**
 * Parse a persisted-settings blob.
 *
 * Anything that is not a plain object is treated as corrupt — `null`, arrays and bare strings
 * are all valid JSON but would either throw on field access or silently restore nothing.
 */
export function parsePersistedState(raw: string | null | undefined): PersistParseResult {
  if (raw === null || raw === undefined || raw === '') {
    return { data: null, corrupt: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { data: null, corrupt: true };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: null, corrupt: true };
  }

  return { data: parsed as Record<string, any>, corrupt: false };
}

/** Read the persisted theme without restoring anything else (used before first paint). */export function readPersistedTheme(raw: string | null | undefined): 'light' | 'dark' | null {
  const { data } = parsePersistedState(raw);
  const theme = data?.theme;
  return theme === 'light' || theme === 'dark' ? theme : null;
}

/**
 * Decide whether autosave may be enabled after hydration.
 *
 * Autosave must stay off when a corrupt blob could not be backed up, otherwise the first
 * default-state write destroys the only copy of the user's data.
 */
export function mayEnableAutosave(result: PersistParseResult, backupSucceeded: boolean): boolean {
  if (!result.corrupt) return true;
  return backupSucceeded;
}

export interface ConversationsParseResult {
  /** Usable conversation index, or null when there is nothing to restore. */
  data: any[] | null;
  /** True when a stored value existed but was not a usable array. */
  corrupt: boolean;
}

/**
 * Parse the persisted conversation index.
 *
 * A non-array root is corrupt rather than empty: the app calls `.filter`/`.find` on this and
 * would otherwise silently replace the user's conversation titles with a fresh list.
 */
export function parsePersistedConversations(
  raw: string | null | undefined
): ConversationsParseResult {
  if (raw === null || raw === undefined || raw === '') {
    return { data: null, corrupt: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { data: null, corrupt: true };
  }

  if (!Array.isArray(parsed)) {
    return { data: null, corrupt: true };
  }

  // Drop entries that could not be rendered or selected, but keep the rest.
  const usable = parsed.filter(
    (c) => c && typeof c === 'object' && typeof (c as any).id === 'string' && (c as any).id
  );
  return { data: usable, corrupt: usable.length !== parsed.length };
}
