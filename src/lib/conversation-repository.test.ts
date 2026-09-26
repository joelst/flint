import { describe, it, expect } from 'vitest';
import {
  ARCHIVE_KEY,
  ARCHIVE_BACKUP_KEY,
  LEGACY_INDEX_KEY,
  LEGACY_PERSIST_KEY,
  openConversationArchive,
  saveConversationArchive,
  serializeArchive,
  effectiveFloor,
  preserveBytes,
  readLegacyThread,
  canRetireLegacyKeys,
  retireLegacyKeys,
  upsertConversation,
  type StorageAdapter,
} from './conversation-repository';
import {
  CONVERSATION_SCHEMA_VERSION,
  MIN_ROLLBACK_APP_VERSION,
  createEmptyArchive,
  migrateLegacyConversations,
  type StoredConversation,
} from './conversation-store';

const APP = '9.0.0';

class MemoryStorage implements StorageAdapter {
  map = new Map<string, string>();
  failReadsOn: string | null = null;
  failWrites = false;
  writes = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v);
  }
  getItem(key: string): string | null {
    if (this.failReadsOn === key) throw new Error('SecurityError: storage blocked');
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.writes += 1;
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const conv = (over: Partial<StoredConversation> = {}): StoredConversation => ({
  id: 'c1',
  title: 'Hello',
  createdAt: 1,
  updatedAt: 1,
  messages: [{ id: 'm1', role: 'user', content: 'hi' }],
  ...over,
});

const archiveWith = (conversations: StoredConversation[], activeId: string | null = null) =>
  serializeArchive({ ...createEmptyArchive(), conversations, activeId });

describe('opening a clean archive', () => {
  it('treats a device with no keys at all as a first run', () => {
    const storage = new MemoryStorage();
    const r = openConversationArchive({ storage, appVersion: APP, now: 10 });
    expect(r.archive.conversations).toEqual([]);
    expect(r.writable).toBe(true);
    expect(r.migrated).toBe(false);
    expect(r.notice).toBeNull();
    // A first run must not write anything just by being opened.
    expect(storage.writes).toBe(0);
  });

  it('round-trips a stored archive without reporting a problem', () => {
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: archiveWith([conv()], 'c1') });
    const r = openConversationArchive({ storage, appVersion: APP, now: 10 });
    expect(r.writable).toBe(true);
    expect(r.notice).toBeNull();
    expect(r.archive.conversations[0].messages[0].content).toBe('hi');
    expect(r.archive.activeId).toBe('c1');
  });
});

describe('a read we did not fully understand never becomes a write', () => {
  it('blocks writing when storage itself cannot be read', () => {
    const storage = new MemoryStorage();
    storage.failReadsOn = ARCHIVE_KEY;
    const r = openConversationArchive({ storage, appVersion: APP, now: 10 });
    // We cannot tell whether an archive exists, so writing risks clobbering or duplicating it.
    expect(r.writable).toBe(false);
    expect(r.writeBlockReason).toBe('unreadable-storage');
    expect(r.notice).toBeTruthy();
  });

  it('blocks writing on an incompatible archive instead of re-migrating over it', () => {
    // A newer schema on disk. Treating it as absent would rebuild from stale legacy data and
    // destroy the real archive.
    const future = JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION + 1,
      activeId: null,
      conversations: [],
    });
    const storage = new MemoryStorage({
      [ARCHIVE_KEY]: future,
      [LEGACY_INDEX_KEY]: JSON.stringify([{ id: 'old', title: 'Old', createdAt: 1, messageCount: 2 }]),
    });
    const r = openConversationArchive({ storage, appVersion: APP, now: 10 });
    expect(r.writable).toBe(false);
    expect(r.writeBlockReason).toBe('incompatible-archive');
    expect(r.migrated).toBe(false);
    expect(r.backedUp).toBe(true);
    expect(storage.map.get(ARCHIVE_KEY)).toBe(future);
    expect(storage.map.get(ARCHIVE_BACKUP_KEY)).toBe(future);
  });

  it('blocks writing on an unparseable archive rather than starting fresh', () => {
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: '{ not json' });
    const r = openConversationArchive({ storage, appVersion: APP, now: 10 });
    expect(r.writable).toBe(false);
    expect(r.writeBlockReason).toBe('incompatible-archive');
    expect(storage.map.get(ARCHIVE_KEY)).toBe('{ not json');
  });

  it('refuses an archive whose rollback floor is above the running build', () => {
    const raw = JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: '99.0.0',
      activeId: null,
      conversations: [],
    });
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: raw });
    const r = openConversationArchive({ storage, appVersion: MIN_ROLLBACK_APP_VERSION, now: 10 });
    expect(r.writable).toBe(false);
    expect(r.notice).toContain('99.0.0');
  });

  it('backs the original up before allowing a lossy archive to be saved', () => {
    // The stored record holds a part this build cannot model; saving the reduced form without
    // a copy would discard it permanently.
    const raw = JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: MIN_ROLLBACK_APP_VERSION,
      activeId: null,
      conversations: [
        {
          id: 'c1',
          title: 't',
          createdAt: 1,
          updatedAt: 1,
          messages: [{ id: 'm', role: 'user', content: [{ type: 'holo', data: 'x' }] }],
        },
      ],
    });
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: raw });
    const r = openConversationArchive({ storage, appVersion: APP, now: 10 });
    expect(r.writable).toBe(true);
    expect(r.backedUp).toBe(true);
    expect(storage.map.get(ARCHIVE_BACKUP_KEY)).toBe(raw);
    // The notice must not name the storage key. Nothing in the app can show or extract one, so
    // naming it is actionable only from a developer console — the user is pointed at Export.
    expect(r.notice).not.toContain(ARCHIVE_BACKUP_KEY);
    expect(r.notice).toContain('Export');
  });

  it('stops writing when a lossy archive could not be backed up', () => {
    const raw = JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: MIN_ROLLBACK_APP_VERSION,
      activeId: null,
      conversations: [{ id: 'c1', title: 't', createdAt: 1, updatedAt: 1 }],
    });
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: raw });
    storage.failWrites = true;
    const r = openConversationArchive({ storage, appVersion: APP, now: 10 });
    // Without a copy, saving the reduced form is the only remaining act that can lose data.
    expect(r.writable).toBe(false);
    expect(r.writeBlockReason).toBe('backup-failed');
  });
});

describe('legacy migration', () => {
  const legacyIndex = JSON.stringify([
    { id: 'c1', title: 'First', createdAt: 100, messageCount: 4 },
    { id: 'c2', title: 'Second', createdAt: 200, messageCount: 0 },
  ]);
  const legacyPersist = JSON.stringify({
    theme: 'dark',
    chatMessages: [
      { id: 'm1', role: 'user', content: 'the only real thread', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'reply', createdAt: 2 },
    ],
  });

  it('imports titles and recovers the one real thread', () => {
    const storage = new MemoryStorage({
      [LEGACY_INDEX_KEY]: legacyIndex,
      [LEGACY_PERSIST_KEY]: legacyPersist,
    });
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    expect(r.migrated).toBe(true);
    expect(r.archive.conversations).toHaveLength(3);
    // The entry that claimed 4 messages never had them on disk; say so rather than showing an
    // empty thread as if it were intact.
    const first = r.archive.conversations.find((c) => c.id === 'c1');
    expect(first?.messagesUnavailable).toBe(true);
    expect(first?.unavailableMessageCount).toBe(4);
    const recovered = r.archive.conversations.find((c) => c.recovered);
    expect(recovered?.messages).toHaveLength(2);
    expect(r.notice).toBeTruthy();
  });

  it('never writes during the open itself', () => {
    const storage = new MemoryStorage({
      [LEGACY_INDEX_KEY]: legacyIndex,
      [LEGACY_PERSIST_KEY]: legacyPersist,
    });
    openConversationArchive({ storage, appVersion: APP, now: 500 });
    // The candidate archive is built in memory; committing is the caller's separate decision,
    // and the legacy bytes stay put until that commit is durable.
    expect(storage.writes).toBe(0);
    expect(storage.map.get(LEGACY_INDEX_KEY)).toBe(legacyIndex);
    expect(storage.map.get(LEGACY_PERSIST_KEY)).toBe(legacyPersist);
  });

  it('produces the same recovered id when an interrupted migration is retried', () => {
    const make = () =>
      openConversationArchive({
        storage: new MemoryStorage({
          [LEGACY_INDEX_KEY]: legacyIndex,
          [LEGACY_PERSIST_KEY]: legacyPersist,
        }),
        appVersion: APP,
        // A different clock on the retry must not mint a different id.
        now: Math.random() * 1e6,
      });
    const a = make().archive.conversations.find((c) => c.recovered)?.id;
    const b = make().archive.conversations.find((c) => c.recovered)?.id;
    expect(a).toBe(b);
  });

  it('does not migrate when a v2 archive already exists', () => {
    const storage = new MemoryStorage({
      [ARCHIVE_KEY]: archiveWith([conv()], 'c1'),
      [LEGACY_INDEX_KEY]: legacyIndex,
      [LEGACY_PERSIST_KEY]: legacyPersist,
    });
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    expect(r.migrated).toBe(false);
    expect(r.archive.conversations).toHaveLength(1);
  });

  it('reports a damaged legacy index as damage rather than as an empty history', () => {
    const storage = new MemoryStorage({
      [LEGACY_INDEX_KEY]: '{ not json',
      [LEGACY_PERSIST_KEY]: legacyPersist,
    });
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    expect(r.migration?.legacyIndexMalformed).toBe(true);
    expect(r.migration?.legacyLossy).toBe(true);
  });

  it('blocks writing when a legacy key cannot be read', () => {
    const storage = new MemoryStorage({ [LEGACY_INDEX_KEY]: legacyIndex });
    storage.failReadsOn = LEGACY_PERSIST_KEY;
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    // A partial read of the source must never be committed as the whole history.
    expect(r.writable).toBe(false);
    expect(r.migrated).toBe(false);
  });

  it('treats an absent thread differently from a damaged one', () => {
    expect(readLegacyThread(null)).toBeUndefined();
    expect(readLegacyThread(JSON.stringify({ theme: 'dark' }))).toBeUndefined();
    // A damaged blob cannot prove the thread was absent, and it must not be reported as `null`:
    // the migrator reads null as absence, which would turn a total loss into a clean start.
    const damaged = readLegacyThread('{ not json');
    expect(damaged).not.toBeNull();
    expect(damaged).toBe('{ not json');
    expect(readLegacyThread(JSON.stringify({ chatMessages: 'oops' }))).toBe('oops');
  });

  it('never reports a damaged settings blob as an empty first run', () => {
    const storage = new MemoryStorage({ [LEGACY_PERSIST_KEY]: '{ not json' });
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    expect(r.migrated).toBe(true);
    expect(r.migration?.legacyThreadMalformed).toBe(true);
    expect(r.migration?.legacyLossy).toBe(true);
    // The damaged source is the only copy left, so it must not become retirable.
    expect(canRetireLegacyKeys(r.migration!)).toBe(false);
    expect(r.notice).toBeTruthy();
  });

  it('does not claim a migration when only an empty settings blob exists', () => {
    const storage = new MemoryStorage({ [LEGACY_PERSIST_KEY]: JSON.stringify({ theme: 'dark' }) });
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    expect(r.migrated).toBe(false);
    expect(r.notice).toBeNull();
  });
});

describe('committing', () => {
  it('writes a header a future build can gate on', () => {
    const storage = new MemoryStorage();
    saveConversationArchive(storage, { ...createEmptyArchive(), conversations: [conv()] });
    const written = JSON.parse(storage.map.get(ARCHIVE_KEY) as string);
    expect(written.version).toBe(CONVERSATION_SCHEMA_VERSION);
    expect(written.minAppVersion).toBe(MIN_ROLLBACK_APP_VERSION);
  });

  it('leaves the stored archive intact when the write fails', () => {
    const previous = archiveWith([conv()], 'c1');
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: previous });
    storage.failWrites = true;
    const r = saveConversationArchive(storage, createEmptyArchive());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Quota');
    // A failed save must not be a destructive save.
    expect(storage.map.get(ARCHIVE_KEY)).toBe(previous);
  });

  it('refuses to store a value it cannot serialize', () => {
    const previous = archiveWith([conv()], 'c1');
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: previous });
    const cyclic: any = conv();
    cyclic.extra = { self: null as any };
    cyclic.extra.self = cyclic;
    const r = saveConversationArchive(storage, {
      ...createEmptyArchive(),
      conversations: [cyclic],
    });
    expect(r.ok).toBe(false);
    expect(storage.map.get(ARCHIVE_KEY)).toBe(previous);
  });

  it('only confirms a verified save when the bytes read back', () => {
    const storage = new MemoryStorage();
    expect(saveConversationArchive(storage, createEmptyArchive(), { verify: true }).ok).toBe(true);

    const silent = new MemoryStorage();
    // A storage that accepts writes but does not retain them is the case a caller must never
    // mistake for durability before retiring the legacy keys.
    silent.setItem = () => {};
    const r = saveConversationArchive(silent, createEmptyArchive(), { verify: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('read back');
  });

  it('round-trips a committed archive through a fresh open', () => {
    const storage = new MemoryStorage();
    const original = { ...createEmptyArchive(), conversations: [conv()], activeId: 'c1' };
    expect(saveConversationArchive(storage, original).ok).toBe(true);
    const reopened = openConversationArchive({ storage, appVersion: APP, now: 10 });
    expect(reopened.writable).toBe(true);
    expect(reopened.notice).toBeNull();
    expect(reopened.archive.conversations).toEqual(original.conversations);
    expect(reopened.archive.activeId).toBe('c1');
  });
});

describe('retiring the legacy keys', () => {
  it('refuses while the migration reported any loss', () => {
    const lossy = migrateLegacyConversations({
      now: 1,
      // An entry we could not convert at all: the legacy bytes are its only remaining copy.
      legacyIndex: [{ title: 'no id at all', createdAt: 1, messageCount: 4 }],
      legacyMessages: [],
    });
    expect(lossy.legacyLossy).toBe(true);
    expect(canRetireLegacyKeys(lossy)).toBe(false);
  });

  it('allows it for a title-only entry, which never had messages to lose', () => {
    // The pre-v2 index stored a title and a count and nothing else, so importing both captures
    // everything it held. Treating that as loss would keep dead keys around forever.
    const titleOnly = migrateLegacyConversations({
      now: 1,
      legacyIndex: [{ id: 'c1', title: 'First', createdAt: 1, messageCount: 4 }],
      legacyMessages: [],
    });
    expect(titleOnly.titleOnlyConversations).toBe(1);
    expect(titleOnly.legacyLossy).toBe(false);
    expect(canRetireLegacyKeys(titleOnly)).toBe(true);
  });

  it('allows it only for a wholly clean conversion', () => {
    const clean = migrateLegacyConversations({
      now: 1,
      legacyIndex: [{ id: 'c1', title: 'First', createdAt: 1, messageCount: 0 }],
      legacyMessages: [
        { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'yo', createdAt: 2 },
      ],
    });
    expect(canRetireLegacyKeys(clean)).toBe(true);
  });

  it('reports failure rather than claiming the keys are gone', () => {
    const storage = new MemoryStorage({ [LEGACY_INDEX_KEY]: '[]' });
    storage.removeItem = () => {
      throw new Error('SecurityError');
    };
    expect(retireLegacyKeys(storage)).toBe(false);
  });

  it('keeps the settings blob, which holds more than the thread', () => {
    const storage = new MemoryStorage({
      [LEGACY_INDEX_KEY]: '[]',
      [LEGACY_PERSIST_KEY]: JSON.stringify({ theme: 'dark', chatMessages: [] }),
    });
    expect(retireLegacyKeys(storage)).toBe(true);
    expect(storage.map.has(LEGACY_INDEX_KEY)).toBe(false);
    // Deleting it would take the user's unrelated settings with it.
    expect(storage.map.has(LEGACY_PERSIST_KEY)).toBe(true);
  });
});

describe('what the migration notice tells the user', () => {
  const openWith = (index: unknown, thread: unknown) =>
    openConversationArchive({
      storage: new MemoryStorage({
        [LEGACY_INDEX_KEY]: JSON.stringify(index),
        [LEGACY_PERSIST_KEY]: JSON.stringify({ chatMessages: thread }),
      }),
      appVersion: APP,
      now: 500,
    });

  it('names how many entries could not be converted', () => {
    const r = openWith([{ title: 'no id' }, { title: 'also no id' }], []);
    expect(r.migration?.droppedLegacyConversations).toBe(2);
    expect(r.notice).toContain('2 unreadable entries');
  });

  it('reads correctly for a single dropped entry and message', () => {
    const r = openWith([{ title: 'no id' }], [{ role: 'user', content: { a: 1 } }]);
    expect(r.notice).toContain('1 unreadable entry');
    expect(r.notice).toContain('1 unreadable message');
  });

  it('uses singular wording for one title-only conversation', () => {
    const r = openWith([{ id: 'c1', title: 'First', createdAt: 1, messageCount: 3 }], []);
    expect(r.notice).toContain('1 earlier conversation kept its title');
  });

  it('says nothing when the conversion cost nothing', () => {
    // Two clean entries with no thread: everything the legacy keys held was carried over.
    const r = openWith(
      [
        { id: 'c1', title: 'First', createdAt: 1, messageCount: 0 },
        { id: 'c2', title: 'Second', createdAt: 2, messageCount: 0 },
      ],
      []
    );
    expect(r.migrated).toBe(true);
    expect(r.notice).toBeNull();
  });
});

describe('preserveBytes', () => {
  it('does not accumulate copies of identical bytes', () => {
    const storage = new MemoryStorage();
    expect(preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'abc')).toBe(true);
    expect(preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'abc')).toBe(true);
    expect([...storage.map.keys()]).toEqual([ARCHIVE_BACKUP_KEY]);
  });

  it('keeps both when different bytes are already parked', () => {
    const storage = new MemoryStorage({ [ARCHIVE_BACKUP_KEY]: 'first' });
    expect(preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'second')).toBe(true);
    expect(storage.map.get(ARCHIVE_BACKUP_KEY)).toBe('first');
    expect([...storage.map.values()]).toContain('second');
  });

  it('addresses spillover slots by content, not by the clock', () => {
    // Two payloads preserved in the same millisecond would collide on a timestamped key and
    // the second would overwrite the first, destroying the only copy of the earlier one.
    const storage = new MemoryStorage({ [ARCHIVE_BACKUP_KEY]: 'first' });
    expect(preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'second')).toBe(true);
    expect(preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'third')).toBe(true);
    const values = [...storage.map.values()];
    expect(values).toContain('first');
    expect(values).toContain('second');
    expect(values).toContain('third');
  });

  it('recognizes bytes already parked in a spillover slot', () => {
    // Otherwise an archive we cannot fully parse is re-backed-up on every launch until quota
    // runs out, and then blocks writing despite an exact copy already existing.
    const storage = new MemoryStorage({ [ARCHIVE_BACKUP_KEY]: 'first' });
    preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'second');
    const afterFirst = storage.map.size;
    for (let i = 0; i < 5; i += 1) {
      expect(preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'second')).toBe(true);
    }
    expect(storage.map.size).toBe(afterFirst);
  });

  it('reports failure so the caller can stop writing', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    expect(preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'abc')).toBe(false);
  });

  it('gives up rather than probing forever when no slot is ever free', () => {
    // The probe runs on the open path, so an adapter that reports every candidate as occupied
    // would hang the UI instead of failing. Bounded, it fails closed: the caller sees "not
    // preserved" and blocks the write rather than overwriting bytes that were never copied.
    let reads = 0;
    const storage: StorageAdapter = {
      getItem: (key) => {
        reads += 1;
        // Anything but an exact match, so every slot looks occupied by different bytes.
        return `occupied:${key}`;
      },
      setItem: () => {
        throw new Error('must not write when no slot was found');
      },
      removeItem: () => {},
    };
    expect(preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'payload')).toBe(false);
    // Terminated, and cheaply: one read for the base key plus the bounded probe.
    expect(reads).toBeLessThanOrEqual(64);
  });

  it('refuses to claim a backup that did not actually persist', () => {
    // A storage that accepts writes without retaining them would otherwise report a backup we
    // do not have, authorizing the original bytes to be overwritten.
    const storage = new MemoryStorage();
    storage.setItem = () => {};
    expect(preserveBytes(storage, ARCHIVE_BACKUP_KEY, 'abc')).toBe(false);
  });
});

describe('upsertConversation', () => {
  it('replaces in place without mutating the original archive', () => {
    const archive = { ...createEmptyArchive(), conversations: [conv(), conv({ id: 'c2' })] };
    const next = upsertConversation(archive, conv({ id: 'c2', title: 'Renamed' }));
    expect(next.conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(next.conversations[1].title).toBe('Renamed');
    expect(archive.conversations[1].title).toBe('Hello');
  });

  it('appends an unknown id rather than dropping the save', () => {
    const archive = { ...createEmptyArchive(), conversations: [conv()] };
    const next = upsertConversation(archive, conv({ id: 'new' }));
    expect(next.conversations).toHaveLength(2);
  });
});

describe('the rollback floor survives a save', () => {
  it('never lowers a floor the stored archive already declared', () => {
    // An archive requiring a future build, opened by a build new enough to read it, must not
    // become writable by every older build simply because we saved it once.
    const raw = JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: '9.5.0',
      activeId: null,
      conversations: [conv()],
    });
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: raw });
    // A build new enough to satisfy the stored floor, so the open is clean and writable.
    const opened = openConversationArchive({ storage, appVersion: '9.9.0', now: 10 });
    expect(opened.writable).toBe(true);

    expect(saveConversationArchive(storage, opened.archive).ok).toBe(true);
    const written = JSON.parse(storage.map.get(ARCHIVE_KEY) as string);
    expect(written.minAppVersion).toBe('9.5.0');
  });

  it('raises an absent or unusable floor to the one this build implements', () => {
    expect(effectiveFloor({ ...createEmptyArchive(), minAppVersion: '' as string })).toBe(
      MIN_ROLLBACK_APP_VERSION
    );
    expect(effectiveFloor({ ...createEmptyArchive(), minAppVersion: 'nightly' })).toBe(
      MIN_ROLLBACK_APP_VERSION
    );
    expect(effectiveFloor({ ...createEmptyArchive(), minAppVersion: '0.1.0' })).toBe(
      MIN_ROLLBACK_APP_VERSION
    );
  });
});

describe('a save cannot be the thing that loses data', () => {
  it('rejects a candidate whose records would be dropped on the next read', () => {
    // An empty id serializes happily and is discarded entirely on reopen, so a "successful"
    // save would silently destroy the conversation.
    const previous = archiveWith([conv()], 'c1');
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: previous });
    const r = saveConversationArchive(storage, {
      ...createEmptyArchive(),
      conversations: [conv({ id: '' })],
    });
    expect(r.ok).toBe(false);
    expect(storage.map.get(ARCHIVE_KEY)).toBe(previous);
  });

  it('rejects a candidate carrying an unusable message', () => {
    const previous = archiveWith([conv()], 'c1');
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: previous });
    const r = saveConversationArchive(storage, {
      ...createEmptyArchive(),
      conversations: [conv({ messages: [{ id: 'm', role: 'user', content: { a: 1 } } as any] })],
    });
    expect(r.ok).toBe(false);
    expect(storage.map.get(ARCHIVE_KEY)).toBe(previous);
  });

  it('accepts a candidate carrying a role this build does not know', () => {
    // An unrecognized role round-trips exactly, so it is not a loss and must not block the
    // save — otherwise one message from a newer build freezes the archive permanently.
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: archiveWith([conv()], 'c1') });
    const r = saveConversationArchive(storage, {
      ...createEmptyArchive(),
      conversations: [conv({ messages: [{ id: 'm', role: 'wizard', content: 'x' } as any] })],
    });
    expect(r.ok).toBe(true);
    expect(storage.map.get(ARCHIVE_KEY)).toContain('wizard');
  });

  it('rejects an unusable messages container that would reopen empty', () => {
    // `droppedConversations` and `droppedMessages` are both zero here: the whole thread simply
    // becomes `[]` on the next read, so counting dropped records cannot catch it.
    const previous = archiveWith([conv()], 'c1');
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: previous });
    const r = saveConversationArchive(storage, {
      ...createEmptyArchive(),
      conversations: [conv({ messages: { turns: [{ id: 'm', role: 'user', content: 'hi' }] } as any })],
    });
    expect(r.ok).toBe(false);
    expect(storage.map.get(ARCHIVE_KEY)).toBe(previous);
    expect(storage.writes).toBe(0);
  });

  it('rejects a malformed known content part that would be dropped on reopen', () => {
    // The message survives, so `droppedMessages` stays zero while the text is lost.
    const previous = archiveWith([conv()], 'c1');
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: previous });
    const r = saveConversationArchive(storage, {
      ...createEmptyArchive(),
      conversations: [
        conv({ messages: [{ id: 'm', role: 'user', content: [{ type: 'text', text: 123 }] } as any] }),
      ],
    });
    expect(r.ok).toBe(false);
    expect(storage.map.get(ARCHIVE_KEY)).toBe(previous);
    expect(storage.writes).toBe(0);
  });

  it('does not let a valid opaque part excuse damage beside it', () => {
    const previous = archiveWith([conv()], 'c1');
    const storage = new MemoryStorage({ [ARCHIVE_KEY]: previous });
    const r = saveConversationArchive(storage, {
      ...createEmptyArchive(),
      conversations: [
        conv({
          messages: [
            {
              id: 'm',
              role: 'user',
              content: [{ type: 'holo', d: 1 }, { type: 'text', text: 123 }],
            } as any,
          ],
        }),
      ],
    });
    expect(r.ok).toBe(false);
    expect(storage.map.get(ARCHIVE_KEY)).toBe(previous);
  });

  it('still saves data we deliberately preserved but cannot model', () => {
    // Opaque parts are reported as lossy on every read by design. Treating that as a reason to
    // refuse would make an archive containing one permanently unsaveable.
    const storage = new MemoryStorage();
    const withOpaque = {
      ...createEmptyArchive(),
      conversations: [
        conv({ messages: [{ id: 'm', role: 'user', content: [{ type: 'holo', d: 1 }] } as any] }),
      ],
    };
    const opened = openConversationArchive({
      storage: new MemoryStorage({ [ARCHIVE_KEY]: serializeArchive(withOpaque) }),
      appVersion: APP,
      now: 1,
    });
    expect(saveConversationArchive(storage, opened.archive).ok).toBe(true);
  });
});

describe('the user is told when the source was damaged', () => {
  it('warns when the conversation list itself was unreadable', () => {
    const storage = new MemoryStorage({ [LEGACY_INDEX_KEY]: '{ not json' });
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    // The resulting archive is well-formed and empty, which is exactly why silence is unsafe.
    expect(r.archive.conversations).toEqual([]);
    expect(r.migration?.legacyLossy).toBe(true);
    expect(r.notice).toBeTruthy();
    expect(r.notice).toContain('damaged');
  });

  it('warns when the thread was present but unusable', () => {
    const storage = new MemoryStorage({
      [LEGACY_PERSIST_KEY]: JSON.stringify({ chatMessages: 'damaged thread' }),
    });
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    expect(r.migration?.legacyLossy).toBe(true);
    expect(r.notice).toBeTruthy();
  });

  it('says the old data was kept whenever anything was lost', () => {
    const storage = new MemoryStorage({ [LEGACY_INDEX_KEY]: '{ not json' });
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    expect(r.notice).toContain('left in place');
  });

  it('never reports loss for a conversion that lost nothing', () => {
    const storage = new MemoryStorage({
      [LEGACY_INDEX_KEY]: JSON.stringify([
        { id: 'c1', title: 'First', createdAt: 1, messageCount: 0 },
      ]),
    });
    const r = openConversationArchive({ storage, appVersion: APP, now: 500 });
    expect(r.migration?.legacyLossy).toBe(false);
    expect(r.notice).toBeNull();
  });
});
