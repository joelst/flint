/**
 * Getting conversation data out of the browser storage it lives in.
 *
 * Flint keeps conversations in `localStorage`, and when it cannot read them it parks the bytes
 * under another `localStorage` key. Nothing in the app can show or extract such a key, so the
 * message naming one is only actionable to someone willing to open a developer console — and the
 * user's likely next move (reinstall, clear application data) destroys the parked copy along with
 * the original.
 *
 * This module turns everything recoverable into a single document a user can put somewhere the
 * app does not control.
 */

import {
  ARCHIVE_KEY,
  ARCHIVE_BACKUP_KEY,
  LEGACY_INDEX_KEY,
  LEGACY_PERSIST_KEY,
  type StorageAdapter,
} from './conversation-repository';
import type { ConversationArchive } from './conversation-store';

/**
 * Storage that can be enumerated.
 *
 * Widened separately from `StorageAdapter` rather than added to it: the repository's callers and
 * their fakes only ever address keys they already know, and requiring enumeration of them would
 * be a cost paid for nothing. `localStorage` satisfies both.
 */
export interface EnumerableStorage extends StorageAdapter {
  readonly length: number;
  key(index: number): string | null;
}

/** The current document format. Present so a reader can refuse a shape it does not know. */
export const EXPORT_FORMAT = 1;

/**
 * Key families whose members may hold conversation data we could not read.
 *
 * Each entry matches the key exactly and any key extending it with a dot, which is how every
 * preservation path in the app names its slots:
 *
 * - `preserveBytes()` parks archives under `ARCHIVE_BACKUP_KEY`, then content-addressed
 *   `ARCHIVE_BACKUP_KEY.<hash>` and `…-<n>` slots on collision.
 * - `restoreChat()` parks unreadable settings under `flint-chat-persist.corrupt` and
 *   `.corrupt.<timestamp>`. Those blobs matter here because the pre-v2 build stored the whole
 *   chat thread inside the settings value, so a corrupt settings blob can hold the only
 *   surviving copy of a conversation — and once it is parked, autosave is free to replace the
 *   live key with defaults.
 *
 * `ARCHIVE_KEY` is deliberately absent: it is collected separately and unconditionally, because
 * it is the live archive rather than a copy of one.
 */
export const PRESERVED_KEY_ROOTS = [ARCHIVE_BACKUP_KEY, LEGACY_INDEX_KEY, LEGACY_PERSIST_KEY];

export function isPreservedKey(key: string): boolean {
  return PRESERVED_KEY_ROOTS.some((root) => key === root || key.startsWith(`${root}.`));
}

/**
 * True for a key that exists only because something could not be read.
 *
 * Narrower than `isPreservedKey`: the two legacy keys are exported, but their bare form is
 * ordinary live data — `flint-chat-persist` is where settings are kept in every healthy install,
 * so treating its presence as damage would warn every user forever. Only the dotted slots are
 * evidence of a failed read.
 */
export function isRecoveryCopyKey(key: string): boolean {
  if (key === ARCHIVE_BACKUP_KEY || key.startsWith(`${ARCHIVE_BACKUP_KEY}.`)) return true;
  return key.startsWith(`${LEGACY_INDEX_KEY}.`) || key.startsWith(`${LEGACY_PERSIST_KEY}.`);
}

export interface StoredPayload {
  key: string;
  /** The stored bytes, never parsed. */
  raw: string;
}

export interface CollectionResult {
  payloads: StoredPayload[];
  /** Keys that were found but could not be read. */
  failedKeys: string[];
  /** Keys that enumeration reported and that were gone by the time they were read. */
  vanishedKeys: string[];
  /** True when the key list itself could not be obtained, so unknown keys may exist. */
  enumerationFailed: boolean;
  /**
   * True when the key set changed while it was being listed.
   *
   * `key(index)` is a positional lookup, not a snapshot: if another writer removes a key
   * mid-enumeration every later index shifts down by one, so a key that was present throughout
   * is never visited and never reported. An unstable enumeration therefore cannot be trusted to
   * have seen everything, even though nothing about it looks wrong.
   */
  enumerationUnstable: boolean;
}

/**
 * True when the collection detected no failure.
 *
 * Best-effort, not a proof of atomicity: it means nothing went wrong that this code could see.
 * Two listings are compared, so a key set that changed across the collection window is reported —
 * but a writer that removed and restored a key within that window leaves no trace. `complete`
 * therefore licenses no destructive decision on its own; it only distinguishes an export with a
 * known gap from one without.
 *
 * The distinction still matters, because the inverse is reliable: a partial collection is never
 * presented as a complete backup. The whole purpose of the export is to let someone discard the
 * original, and doing that on the strength of a file that silently omitted the only copy of a
 * conversation is worse than not exporting at all.
 */
export function isComplete(result: CollectionResult): boolean {
  return (
    !result.enumerationFailed &&
    !result.enumerationUnstable &&
    result.failedKeys.length === 0 &&
    result.vanishedKeys.length === 0
  );
}

function readRaw(storage: StorageAdapter, key: string): { ok: boolean; value: string | null } {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * Every preserved payload the storage holds.
 *
 * The key list is snapshotted before anything is read, because reading is fallible and an
 * exception partway through enumeration would otherwise lose the keys not yet visited. Each read
 * is isolated for the same reason: one unreadable key must cost that key, not the export.
 *
 * Instability is detected rather than retried. A retry loop would have to decide when the store
 * had settled, and there is no such moment to observe; reporting that the listing may be short is
 * both achievable and the thing the user actually needs to know.
 *
 * Detection compares the whole key set before and after, not just its size. `key(i)` is a
 * positional lookup: removing one key shifts every later index down by one, so a single removal
 * paired with a single addition leaves the count unchanged, every visited key distinct, and every
 * collected payload readable — while a key present throughout was stepped over and never seen.
 * Only comparing the sets catches that.
 *
 * An empty string is a value, not an absence — only `null` means the key is unset.
 */
export function collectPreservedPayloads(storage: EnumerableStorage): CollectionResult {
  const first = listKeys(storage);
  // Nothing was seen at all, so there is no partial inventory to salvage.
  if (first.failed && first.keys.size === 0) return emptyCollection(true);

  const names = [...first.keys].filter(isPreservedKey);
  const payloads: StoredPayload[] = [];
  const failedKeys: string[] = [];
  const vanishedKeys: string[] = [];
  for (const name of names) {
    const read = readRaw(storage, name);
    if (!read.ok) {
      failedKeys.push(name);
      continue;
    }
    // Enumeration saw this key, so `null` is not "never present" — it was removed between being
    // listed and being read, and its bytes are now in neither the store nor the export.
    if (read.value === null) {
      vanishedKeys.push(name);
      continue;
    }
    payloads.push({ key: name, raw: read.value });
  }

  // Re-listed after collecting rather than before, so the comparison spans the reads too.
  const second = listKeys(storage);
  const enumerationUnstable =
    first.unstable || second.failed || second.unstable || !sameKeys(first.keys, second.keys);

  return {
    payloads,
    failedKeys,
    vanishedKeys,
    enumerationFailed: first.failed,
    enumerationUnstable,
  };
}

/**
 * List the keys, keeping whatever was seen before a failure.
 *
 * A partial inventory is still worth reading: the keys already discovered may include the only
 * copy of a conversation, and discarding them because a later index threw would lose data the
 * export could have rescued. The failure is reported alongside them, not instead of them.
 */
function listKeys(storage: EnumerableStorage): {
  keys: Set<string>;
  unstable: boolean;
  failed: boolean;
} {
  const keys = new Set<string>();
  let unstable = false;
  try {
    const count = storage.length;
    for (let i = 0; i < count; i += 1) {
      const name = storage.key(i);
      if (typeof name !== 'string') {
        // A shorter list than `length` promised means the store shrank underneath us, so the
        // indices after this point no longer refer to the keys they did when counting started.
        unstable = true;
        continue;
      }
      // The same key at two indices can only mean the set shifted mid-walk.
      if (keys.has(name)) unstable = true;
      keys.add(name);
    }
    if (storage.length !== count) unstable = true;
  } catch {
    return { keys, unstable, failed: true };
  }
  return { keys, unstable, failed: false };
}

function sameKeys(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/** An empty collection, for when storage could not be reached at all. */
export function emptyCollection(enumerationFailed: boolean): CollectionResult {
  return {
    payloads: [],
    failedKeys: [],
    vanishedKeys: [],
    enumerationFailed,
    enumerationUnstable: false,
  };
}

/** Whether recovery copies remain in storage. `'unknown'` when it could not be enumerated. */
export type RecoveryCopyStatus = 'present' | 'absent' | 'unknown';

/** Whether any recovery copy is still in storage, whichever launch created it. */
export function hasRecoveryCopies(storage: EnumerableStorage): RecoveryCopyStatus {
  try {
    const count = storage.length;
    for (let i = 0; i < count; i += 1) {
      const name = storage.key(i);
      if (typeof name === 'string') {
        if (isRecoveryCopyKey(name)) return 'present';
        continue;
      }
      // An index below the reported length that yields no name means the listing moved under
      // the walk — another writer removed a key — so the indices after it refer to entries this
      // pass never saw. `key()` returns null rather than throwing for that, so without this the
      // walk would finish and report `absent`, retiring the at-risk warning on the strength of a
      // scan that had skipped part of storage.
      return 'unknown';
    }
  } catch {
    // Not the same as finding none. A healthy archive read leaves the session writable, so
    // nothing else would raise this, and claiming "absent" would quietly retire the warning.
    return 'unknown';
  }
  return 'absent';
}

export interface StoredArchiveResult {
  /** The stored bytes, or null when the key is unset. */
  raw: string | null;
  /** False when the key could not be read at all, which is not the same as being unset. */
  ok: boolean;
}

/**
 * The live archive's bytes, read directly rather than through the parsed form.
 *
 * This is the entry that makes the export trustworthy. `openConversationArchive()` substitutes a
 * *fresh empty archive* when the stored one cannot be parsed, and returns a *reduced* archive
 * when it is only partly readable — so a document built from the in-memory archive alone would,
 * in exactly the situation that motivates exporting, hand the user an empty file and call it
 * their backup. Reading the key here is independent of whether parsing or preservation
 * succeeded, so the original bytes are in the file even when neither did.
 */
export function collectStoredArchive(storage: StorageAdapter): StoredArchiveResult {
  const read = readRaw(storage, ARCHIVE_KEY);
  return { raw: read.value, ok: read.ok };
}

export interface ExportDocument {
  flintExport: number;
  exportedAt: string;
  appVersion: string;
  /**
   * False when anything known to exist could not be read. A reader — human or otherwise — must
   * treat the document as a partial rescue rather than a full copy.
   */
  complete: boolean;
  /** What could not be read, so the gap is nameable rather than merely implied. */
  incomplete: {
    archiveUnreadable: boolean;
    failedKeys: string[];
    vanishedKeys: string[];
    enumerationFailed: boolean;
    enumerationUnstable: boolean;
    sessionCaptureFailed: boolean;
  };
  /** The parsed archive as this session sees it, including any unsaved messages. */
  session: ConversationArchive | null;
  /**
   * Messages on screen that belong to no conversation, or whose attribution failed.
   *
   * Not a hypothetical: opening an incompatible archive leaves the session with no conversation
   * at all, and nothing stops the user chatting anyway. Those turns exist only in memory, so if
   * the export did not carry them here they would exist nowhere.
   */
  liveThread: { loadedFor: string | null; messages: unknown[] } | null;
  /** The bytes stored under the live key, verbatim. */
  storedArchive: string | null;
  /** Bytes parked by earlier recovery attempts, verbatim. */
  preserved: StoredPayload[];
}

export interface SessionSnapshot {
  archive: ConversationArchive | null;
  /** Present when the thread has no owning conversation, or could not be folded into one. */
  liveThread: { loadedFor: string | null; messages: unknown[] } | null;
  /** False when the thread could not be attributed, so the archive may be behind the screen. */
  captured: boolean;
}

export interface BuildExportOptions {
  session: SessionSnapshot;
  storedArchive: StoredArchiveResult;
  preserved: CollectionResult;
  appVersion: string;
  exportedAt: Date;
}

/**
 * Assemble the document.
 *
 * Preserved bytes are carried as strings and never re-parsed. They are bytes we already know we
 * failed to understand: parsing them here would either throw, or succeed against a lenient reader
 * and normalize away the very damage someone recovering by hand needs to see. Holding them as
 * JSON strings is lossless — escaping survives the round trip, including control characters and
 * unpaired surrogates — while re-parsing is not.
 */
export function buildExportDocument(options: BuildExportOptions): ExportDocument {
  const { session, storedArchive, preserved, appVersion, exportedAt } = options;
  const archiveUnreadable = !storedArchive.ok;
  const sessionCaptureFailed = !session.captured;
  return {
    flintExport: EXPORT_FORMAT,
    exportedAt: exportedAt.toISOString(),
    appVersion,
    complete: isComplete(preserved) && !archiveUnreadable && !sessionCaptureFailed,
    incomplete: {
      archiveUnreadable,
      failedKeys: [...preserved.failedKeys],
      vanishedKeys: [...preserved.vanishedKeys],
      enumerationFailed: preserved.enumerationFailed,
      enumerationUnstable: preserved.enumerationUnstable,
      sessionCaptureFailed,
    },
    session: session.archive,
    liveThread: session.liveThread,
    storedArchive: storedArchive.raw,
    preserved: preserved.payloads,
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * A filename that sorts chronologically, resolved to the second.
 *
 * Two exports started within the same second therefore suggest the same name. That is a
 * deliberately harmless collision: the suggestion is only the dialog's starting point, and the
 * write refuses to replace an existing file, so accepting it twice is declined rather than
 * overwriting the first copy.
 *
 * Local time, because the name is read by a person looking for the copy they made this morning,
 * not by a machine reconciling zones.
 */
export function exportFileName(exportedAt: Date): string {
  const stamp =
    `${exportedAt.getFullYear()}-${pad(exportedAt.getMonth() + 1)}-${pad(exportedAt.getDate())}` +
    `-${pad(exportedAt.getHours())}${pad(exportedAt.getMinutes())}${pad(exportedAt.getSeconds())}`;
  return `flint-conversations-${stamp}.json`;
}

/** Serialize for writing. Indented because a recovery file is read by people. */
export function serializeExportDocument(doc: ExportDocument): string {
  return JSON.stringify(doc, null, 2);
}

function normalizePath(path: string): string {
  const forward = path.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows and macOS both mount case-insensitively by default, and the platforms this build
  // supports are exactly those two. Comparing case-sensitively would let `AppData` slip past a
  // check written against `appdata`.
  return forward.toLowerCase();
}

/**
 * True when a chosen destination is spelled inside the application's own data.
 *
 * A prefix test, and only the first half of the check: it catches the ordinary case cheaply but
 * compares names, not locations, so a relocated application directory reached through a symlink
 * or a Windows junction has a different prefix and slips past. `classifyDestination` follows this
 * with a filesystem identity comparison.
 */
export function isWithinAppData(target: string, appDirs: string[]): boolean {
  const normalizedTarget = normalizePath(target);
  return appDirs.some((dir) => {
    if (!dir) return false;
    const normalizedDir = normalizePath(dir);
    if (!normalizedDir) return false;
    // The separator is required so `/home/u/flint-data` is not judged to be inside `/home/u/flint`.
    return (
      normalizedTarget === normalizedDir || normalizedTarget.startsWith(`${normalizedDir}/`)
    );
  });
}

/** A directory's identity on disk, independent of the name used to reach it. */
export interface DirIdentity {
  dev: number | null;
  ino: number | null;
}

export interface DestinationProbe {
  /** Follows links, so two names for one directory report the same identity. */
  stat(path: string): Promise<DirIdentity>;
  /** Does *not* follow links, so a link and its target report different identities. */
  lstat(path: string): Promise<DirIdentity>;
  /** Lexical parent. Only trusted once the chain is known to be link-free. */
  dirname(path: string): Promise<string>;
}

export type DestinationVerdict = 'inside' | 'outside' | 'unverified';

/**
 * How many ancestors to walk before giving up.
 *
 * Deep enough for any real path; bounded so a `dirname` that never reaches a fixed point cannot
 * spin. Exhausting it yields `unverified`, not `outside` — the safe direction.
 */
const MAX_ANCESTOR_WALK = 64;

function sameIdentity(a: DirIdentity, b: DirIdentity): boolean {
  // Null on platforms that do not report inode numbers, and two unknowns are not a match.
  if (a.dev === null || a.ino === null || b.dev === null || b.ino === null) return false;
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Decide whether a destination is safely outside the application's own data.
 *
 * Answers with three values on purpose. Writing the export inside application data satisfies
 * nothing — the file is destroyed by the same reinstall or "clear application data" it exists to
 * survive — so `inside` is refused. But an unverifiable destination must not be reported as an
 * ordinary success either: the whole point is to let someone discard the original afterwards, and
 * that decision cannot rest on a check that silently did not run. Anything that cannot be
 * established answers `unverified`, which the caller reports rather than hides.
 *
 * Ancestry is walked lexically, which is only sound when no name along the way is a link. A path
 * spelled `/var/tmp` on macOS lives in `/private/var`, and a junction can point straight into the
 * application directory, so trimming the string can walk a chain the file is not actually in. The
 * walk therefore proves the chain is link-free as it goes: `stat` follows links and `lstat` does
 * not, so a name that is a link reports two different identities. Any disagreement, and the
 * lexical parent is not the real one — which is not evidence of anything, so it answers
 * `unverified` rather than guessing in either direction.
 *
 * `outside` therefore means: every ancestor was readable, none was a link, and none was an
 * application root. What it still cannot see is aliasing that leaves no link behind — a bind
 * mount or a hard-linked directory exposing the application directory under a second path. Those
 * are not detectable with `stat` alone, and they are the reason `outside` is a statement about
 * what was checked rather than a guarantee.
 *
 * `dev`/`ino` are unavailable on some platforms (notably Windows), where this yields `unverified`
 * rather than a guess.
 *
 * The target itself is not stat'd: it does not exist yet. Its parent does, and stripping the
 * final segment is the one lexical step that is always safe, since the file has no link of
 * its own.
 */
export async function classifyDestination(
  target: string,
  appDirs: string[],
  probe: DestinationProbe,
): Promise<DestinationVerdict> {
  if (appDirs.length && isWithinAppData(target, appDirs)) return 'inside';
  if (!appDirs.length) return 'unverified';

  const rootIds: DirIdentity[] = [];
  for (const dir of appDirs) {
    try {
      const id = await probe.stat(dir);
      if (id.dev === null || id.ino === null) return 'unverified';
      rootIds.push(id);
    } catch {
      // A root that does not exist cannot contain anything, but one that fails for another
      // reason might — and the two are not distinguishable here.
      return 'unverified';
    }
  }

  let current: string;
  try {
    current = await probe.dirname(target);
  } catch {
    return 'unverified';
  }

  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth += 1) {
    let id: DirIdentity;
    let linkId: DirIdentity;
    try {
      id = await probe.stat(current);
      linkId = await probe.lstat(current);
    } catch {
      // Above the deepest existing ancestor, or unreadable. Either way the remainder of the
      // chain cannot be compared.
      return 'unverified';
    }
    // An ancestor of unknown identity is not evidence of anything. Treating it as a non-match
    // and walking on would let the loop reach the filesystem root and answer `outside` for a
    // chain it never actually examined.
    if (id.dev === null || id.ino === null) return 'unverified';
    // Checked before the root comparison can conclude anything, but after `inside` would have:
    // a name that resolves *to* an application root is inside it whether or not it is a link.
    if (rootIds.some((root) => sameIdentity(root, id))) return 'inside';
    if (linkId.dev === null || linkId.ino === null) return 'unverified';
    // The two disagree only when this name is a link, and then everything above it in the
    // spelling belongs to a chain the file is not in.
    if (!sameIdentity(id, linkId)) return 'unverified';

    let parent: string;
    try {
      parent = await probe.dirname(current);
    } catch {
      return 'unverified';
    }
    // The filesystem root is its own parent, and no link was crossed getting here.
    if (parent === current) return 'outside';
    current = parent;
  }
  return 'unverified';
}
