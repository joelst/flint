/**
 * Durable storage for the conversation archive.
 *
 * `conversation-store.ts` decides *what is safe to keep*; this module decides *when it is safe
 * to write*. The two are split because the rules that prevent data loss here are ordering
 * rules — back up before overwriting, verify before discarding a source, refuse rather than
 * guess — and they are only testable if the storage they act on can be substituted.
 *
 * The guiding rule: **a read that we did not fully understand must never become a write.**
 * Flint's pre-v2 loss happened because a reduced in-memory view was saved back over the
 * authoritative bytes. Every branch below either preserves the original bytes first or blocks
 * writing entirely.
 */

import {
  CONVERSATION_SCHEMA_VERSION,
  MIN_ROLLBACK_APP_VERSION,
  SKIP_APP_VERSION_GATE,
  compareVersions,
  createEmptyArchive,
  deriveRecoveredId,
  hashString,
  isUsableVersion,
  migrateLegacyConversations,
  parseConversationArchive,
  type ConversationArchive,
  type LegacyMigrationResult,
  type StoredConversation,
} from './conversation-store';

/** The v2 archive. Distinct from every pre-v2 key so a downgrade cannot reinterpret it. */
export const ARCHIVE_KEY = 'flint-conversations-v2';
/** Where unreadable or lossily-parsed archive bytes are parked before anything overwrites them. */
export const ARCHIVE_BACKUP_KEY = 'flint-conversations-v2.backup';
/** Pre-v2 sidebar index: titles and counts only, never messages. */
export const LEGACY_INDEX_KEY = 'flint-chats-v1';
/** Pre-v2 settings blob; its `chatMessages` field held the single global thread. */
export const LEGACY_PERSIST_KEY = 'flint-chat-persist';

/**
 * Minimal storage surface, so the repository can be driven by a map in tests.
 *
 * Every method may throw: `localStorage` throws on quota exhaustion, and access itself throws
 * outright when site data is blocked. Callers must treat each one as fallible.
 */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Why writing is disabled. `null` means writes are allowed. */
export type WriteBlockReason =
  | 'unreadable-storage'
  | 'incompatible-archive'
  | 'backup-failed'
  | null;

export interface OpenOptions {
  storage: StorageAdapter;
  /** Running application version, for the rollback gate. Required — see `parseConversationArchive`. */
  appVersion: string;
  now: number;
}

export interface OpenResult {
  archive: ConversationArchive;
  /**
   * False when this session must not write. The in-memory archive is still usable so the app
   * stays interactive; it simply becomes read-only rather than overwriting what we could not
   * read.
   */
  writable: boolean;
  writeBlockReason: WriteBlockReason;
  /** A message to show the user, or null when the open was completely clean. */
  notice: string | null;
  /** True when this open converted pre-v2 data. */
  migrated: boolean;
  /** Present when `migrated`, for reporting exactly what the conversion cost. */
  migration: LegacyMigrationResult | null;
  /** True when the stored bytes were preserved under `ARCHIVE_BACKUP_KEY`. */
  backedUp: boolean;
}

export interface SaveResult {
  ok: boolean;
  error: string | null;
}

/**
 * Park bytes we could not fully understand so they can be recovered by hand.
 *
 * Returns false only when nothing could be preserved. The caller must then stop writing to the
 * live key: overwriting it would destroy the only copy of data we already know we failed to
 * read correctly.
 */
/**
 * How many content-addressed backup slots to probe before giving up.
 *
 * Each extra slot past the first means another payload that hashes identically, so a legitimate
 * run of even a few is already implausible. The bound exists for the implausible case — a
 * storage adapter that never reports a free key — where the alternative is an infinite loop on
 * the open path.
 */
const MAX_BACKUP_SLOT_PROBES = 32;

export function preserveBytes(storage: StorageAdapter, backupKey: string, raw: string): boolean {
  try {
    const existing = storage.getItem(backupKey);
    // Re-parking identical bytes is a no-op, not a second copy: an open that repeats after a
    // failed write must not grow the backup set on every attempt.
    if (existing === raw) return true;

    let target = backupKey;
    if (existing !== null) {
      // Different bytes are already parked. Keep both rather than choosing which loss to
      // accept — but address the slot by content, not by the clock. A timestamp collides when
      // two payloads are preserved in the same millisecond, and the second would overwrite the
      // first: destroying the only copy of data, which is precisely what this function exists
      // to prevent.
      const base = `${backupKey}.${hashString(raw)}`;
      let slot: string | null = null;
      for (let attempt = 0; attempt < MAX_BACKUP_SLOT_PROBES; attempt += 1) {
        const candidate = attempt === 0 ? base : `${base}-${attempt}`;
        const parked = storage.getItem(candidate);
        // These bytes are already preserved under their content address; nothing to do. Without
        // this check an archive we cannot fully parse would be re-backed-up on every launch
        // until quota ran out, and then block writing despite an exact copy already existing.
        if (parked === raw) return true;
        if (parked === null) {
          slot = candidate;
          break;
        }
        // Occupied by different bytes (a hash collision). Never overwrite; step aside.
      }
      // Bounded so a storage adapter that reports every key as occupied cannot spin here. This
      // runs on the open path, so an unbounded probe would hang the UI rather than fail. Giving
      // up reports "not preserved", which blocks the write — the safe direction, since the
      // whole point of this function is to refuse to overwrite bytes we have not copied.
      if (slot === null) return false;
      target = slot;
    }

    storage.setItem(target, raw);
    // A write that reports success but does not retain is indistinguishable from a real backup
    // unless we look. Claiming a backup we do not have would authorize overwriting the original.
    return storage.getItem(target) === raw;
  } catch {
    return false;
  }
}

function readKey(storage: StorageAdapter, key: string): { ok: boolean; value: string | null } {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

function parseJson(raw: string | null): unknown {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Serialize an archive with the header a future build needs to gate on.
 *
 * The floor is the *greater* of what the archive already declares and what this build
 * implements. Stamping our own floor unconditionally would let an old build quietly relax a
 * newer archive's requirement simply by saving it once, which defeats the gate entirely.
 */
export function effectiveFloor(archive: ConversationArchive): string {
  const declared = (archive as { minAppVersion?: unknown }).minAppVersion;
  if (typeof declared !== 'string' || !isUsableVersion(declared)) return MIN_ROLLBACK_APP_VERSION;
  return compareVersions(declared, MIN_ROLLBACK_APP_VERSION) > 0 ? declared : MIN_ROLLBACK_APP_VERSION;
}

export function serializeArchive(archive: ConversationArchive): string {
  return JSON.stringify({
    ...archive,
    version: CONVERSATION_SCHEMA_VERSION,
    minAppVersion: effectiveFloor(archive),
  });
}

/**
 * Read the pre-v2 thread out of the settings blob.
 *
 * Returns `undefined` when the key is absent and the raw value when it is present but
 * unusable, so migration can tell "there was never a thread" from "the thread is damaged".
 * Collapsing those two would report a total loss as a clean empty start.
 */
export function readLegacyThread(raw: string | null): unknown {
  if (raw === null) return undefined;
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // The blob itself is damaged, so we cannot prove a thread was absent. Return the raw bytes,
    // which the migrator classifies as damage; `undefined` is reserved for a key that was never
    // stored, and reporting a total loss as a clean empty start would let the damaged source be
    // retired.
    return raw;
  }
  // Distinguishes a key that was never written from one holding an unusable value: only the
  // former is absence. A stored `null` is passed through as-is so the migrator can report it.
  const messages = (parsed as Record<string, unknown>).chatMessages;
  return messages === undefined ? undefined : messages;
}

function describeMigration(result: LegacyMigrationResult): string | null {
  const parts: string[] = [];
  if (result.titleOnlyConversations > 0) {
    // These were never recoverable: the pre-v2 layout stored their titles but not their turns.
    parts.push(
      `${result.titleOnlyConversations} earlier conversation${result.titleOnlyConversations === 1 ? '' : 's'} ` +
        `kept ${result.titleOnlyConversations === 1 ? 'its title' : 'their titles'}, but ` +
        `${result.titleOnlyConversations === 1 ? 'its messages were' : 'their messages were'} never saved by the old version`,
    );
  }
  if (result.recoveredThread) {
    parts.push('the most recent thread was recovered into its own conversation');
  }
  if (result.droppedLegacyConversations > 0 || result.droppedLegacyMessages > 0) {
    parts.push(
      `${result.droppedLegacyConversations} unreadable entr${result.droppedLegacyConversations === 1 ? 'y' : 'ies'} and ` +
        `${result.droppedLegacyMessages} unreadable message${result.droppedLegacyMessages === 1 ? '' : 's'} could not be converted`,
    );
  }
  // Damage to the source itself is the most serious case and the easiest to miss: the archive
  // that results can be perfectly well-formed and completely empty.
  if (result.legacyIndexMalformed) {
    parts.push('the saved conversation list was damaged and could not be read');
  }
  if (result.legacyThreadMalformed) {
    parts.push('the saved message thread was damaged and could not be read');
  }
  if (result.droppedLegacyParts > 0) {
    parts.push(
      `${result.droppedLegacyParts} attachment${result.droppedLegacyParts === 1 ? '' : 's'} or content part${result.droppedLegacyParts === 1 ? '' : 's'} could not be converted`,
    );
  }
  if (result.repairedLegacyEntries > 0 || result.repairedLegacyMessages > 0) {
    parts.push('some entries were incomplete and had missing details filled in');
  }
  if (parts.length === 0) return null;
  const summary = `Conversations were upgraded to the new format: ${parts.join('; ')}.`;
  // `legacyLossy` is the storage layer's own retirement gate, so if it is set the user must be
  // told the old data is being kept — otherwise a silent partial conversion looks complete.
  return result.legacyLossy
    ? `${summary} The previous data has been left in place so nothing is lost.`
    : summary;
}

/**
 * Open the archive, migrating pre-v2 data if that is what is on disk.
 *
 * Ordering matters and follows the contract documented on `migrateLegacyConversations`:
 * both legacy payloads are read and retained before anything is written, the whole candidate
 * archive is built before it is committed, existing-but-unreadable v2 bytes block writing
 * instead of being treated as absent, and the legacy keys are never deleted here.
 */
export function openConversationArchive(options: OpenOptions): OpenResult {
  const { storage, appVersion, now } = options;

  const base: OpenResult = {
    archive: createEmptyArchive(),
    writable: true,
    writeBlockReason: null,
    notice: null,
    migrated: false,
    migration: null,
    backedUp: false,
  };

  const stored = readKey(storage, ARCHIVE_KEY);
  if (!stored.ok) {
    // Storage is unreadable, so we cannot know whether an archive exists. Writing would risk
    // creating a second one or clobbering the first.
    return {
      ...base,
      writable: false,
      writeBlockReason: 'unreadable-storage',
      notice:
        'Saved conversations could not be read on this device, so this session will not be saved. ' +
        'Existing conversations are left untouched.',
    };
  }

  if (stored.value !== null) {
    const parsed = parseConversationArchive(stored.value, appVersion);

    if (parsed.incompatible || parsed.archive === null) {
      // Never re-migrate over this: the bytes exist, so treating them as absent would replace a
      // real archive with one rebuilt from stale legacy data.
      const backedUp = preserveBytes(storage, ARCHIVE_BACKUP_KEY, stored.value);
      return {
        ...base,
        writable: false,
        writeBlockReason: 'incompatible-archive',
        backedUp,
        notice:
          `${parsed.reason ?? 'Saved conversations could not be read.'} ` +
          (backedUp
            ? `This session will not be saved, and the existing data was copied to "${ARCHIVE_BACKUP_KEY}".`
            : 'This session will not be saved, and the existing data was left untouched.'),
      };
    }

    if (parsed.lossy) {
      // We understood enough to continue, but saving the reduced form would discard the rest.
      const backedUp = preserveBytes(storage, ARCHIVE_BACKUP_KEY, stored.value);
      return {
        ...base,
        archive: parsed.archive,
        writable: backedUp,
        writeBlockReason: backedUp ? null : 'backup-failed',
        backedUp,
        notice: backedUp
          ? `Some saved conversation data could not be read by this version. The original was copied to "${ARCHIVE_BACKUP_KEY}" before any changes are saved.`
          : 'Some saved conversation data could not be read and a backup could not be written, so this session will not be saved.',
      };
    }

    return { ...base, archive: parsed.archive };
  }

  // No v2 archive. Read *both* legacy payloads before deciding anything, so a partial read can
  // never look like an empty history.
  const legacyIndexRead = readKey(storage, LEGACY_INDEX_KEY);
  const legacyPersistRead = readKey(storage, LEGACY_PERSIST_KEY);
  if (!legacyIndexRead.ok || !legacyPersistRead.ok) {
    return {
      ...base,
      writable: false,
      writeBlockReason: 'unreadable-storage',
      notice:
        'Earlier conversations could not be read on this device. Nothing was changed, and this ' +
        'session will not be saved.',
    };
  }

  const legacyIndexRaw = legacyIndexRead.value;
  const legacyThread = readLegacyThread(legacyPersistRead.value);
  if (legacyIndexRaw === null && legacyThread === undefined) {
    // Genuinely a first run: no v2 archive and no pre-v2 keys at all.
    return { ...base };
  }

  const legacyIndex = parseJson(legacyIndexRaw);
  const migration = migrateLegacyConversations({
    now,
    // A malformed index must reach the migrator as a malformed value, not as an empty list, so
    // it is reported as damage rather than as "there was nothing here".
    legacyIndex: legacyIndexRaw !== null && legacyIndex === null ? legacyIndexRaw : legacyIndex,
    legacyMessages: legacyThread,
    recoveredId: deriveRecoveredId(legacyThread),
  });

  return {
    ...base,
    archive: migration.archive,
    migrated: true,
    migration,
    notice: describeMigration(migration),
  };
}

/**
 * Commit an archive.
 *
 * `localStorage.setItem` replaces a key's value atomically and leaves the old value intact when
 * it throws, so a failed save cannot half-write. The read-back exists for a different reason:
 * it is the only evidence that a commit actually became durable, which is what a caller needs
 * before it may retire the legacy keys.
 */
export function saveConversationArchive(
  storage: StorageAdapter,
  archive: ConversationArchive,
  options: { verify?: boolean } = {},
): SaveResult {
  let serialized: string;
  try {
    serialized = serializeArchive(archive);
  } catch (e: any) {
    // A value that cannot be serialized (a cycle, a BigInt) must not reach storage, and the
    // previously stored archive must stay exactly as it is.
    return { ok: false, error: `Conversations could not be prepared for saving: ${e?.message || e}` };
  }

  // Byte-level success is not correctness. Parse the candidate before it can replace anything:
  // a conversation with an empty id, for example, serializes happily and is then dropped
  // entirely on the next open, so the "successful" save would have destroyed it.
  const validated = parseConversationArchive(serialized, SKIP_APP_VERSION_GATE);
  if (validated.archive === null) {
    return {
      ok: false,
      error: `Conversations could not be saved: ${validated.reason ?? 'the data did not pass validation.'}`,
    };
  }
  // Anything the next read would drop or rebuild means this save does not round-trip: the
  // stored bytes would no longer be the data we were asked to store. `unrecognizedParts` is the
  // sole exception — opaque parts are deliberately-preserved data and are reported on every
  // read by design, so treating them as damage would make such an archive unsaveable forever.
  // They are also not a licence for unrelated damage in the same candidate, which is why this
  // checks the other counters independently rather than falling back to `lossy`.
  if (
    validated.droppedConversations > 0 ||
    validated.droppedMessages > 0 ||
    validated.droppedParts > 0 ||
    validated.repaired
  ) {
    return {
      ok: false,
      error:
        'Conversations could not be saved: the data would not have been stored exactly as it ' +
        'is. The previously saved conversations were left unchanged.',
    };
  }

  try {
    storage.setItem(ARCHIVE_KEY, serialized);
  } catch (e: any) {
    return { ok: false, error: `Conversations could not be saved: ${e?.message || e}` };
  }

  if (options.verify) {
    const readBack = readKey(storage, ARCHIVE_KEY);
    if (!readBack.ok || readBack.value !== serialized) {
      return {
        ok: false,
        error: 'Conversations were written but could not be read back, so the save is not confirmed.',
      };
    }
  }

  return { ok: true, error: null };
}

/**
 * Retire the pre-v2 keys.
 *
 * Deliberately separate from `saveConversationArchive` and never called automatically: the
 * legacy bytes are the only remaining copy of anything the migration could not represent.
 * Retiring them is safe only once a migrated archive is confirmed durable **and** the migration
 * reported no loss at all — which is exactly what `legacyLossy` answers.
 */
export function canRetireLegacyKeys(migration: LegacyMigrationResult): boolean {
  return !migration.legacyLossy;
}

export function retireLegacyKeys(storage: StorageAdapter): boolean {
  try {
    storage.removeItem(LEGACY_INDEX_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace one conversation in an archive without rebuilding the rest.
 *
 * Returns a new archive; the caller's copy is never mutated. An id that is not present is
 * appended rather than dropped, because losing a save is the failure this whole module exists
 * to prevent.
 */
export function upsertConversation(
  archive: ConversationArchive,
  conversation: StoredConversation,
): ConversationArchive {
  const index = archive.conversations.findIndex((c) => c.id === conversation.id);
  const conversations =
    index === -1
      ? [...archive.conversations, conversation]
      : archive.conversations.map((c, i) => (i === index ? conversation : c));
  return { ...archive, conversations };
}
