import { describe, it, expect } from 'vitest';
import {
  EXPORT_FORMAT,
  isPreservedKey,
  collectPreservedPayloads,
  collectStoredArchive,
  buildExportDocument,
  exportFileName,
  isRecoveryCopyKey,
  hasRecoveryCopies,
  isWithinAppData,
  classifyDestination,
  emptyCollection,
  serializeExportDocument,
  isComplete,
  type EnumerableStorage,
  type DestinationProbe,
} from './conversation-export';
import {
  ARCHIVE_KEY,
  ARCHIVE_BACKUP_KEY,
  LEGACY_INDEX_KEY,
  LEGACY_PERSIST_KEY,
} from './conversation-repository';

function fakeStorage(
  entries: Record<string, string>,
  options: { failOn?: string[]; failEnumeration?: boolean } = {},
): EnumerableStorage {
  const keys = Object.keys(entries);
  const failOn = new Set(options.failOn ?? []);
  return {
    get length() {
      if (options.failEnumeration) throw new Error('denied');
      return keys.length;
    },
    key(index: number) {
      return keys[index] ?? null;
    },
    getItem(key: string) {
      if (failOn.has(key)) throw new Error('denied');
      return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null;
    },
    setItem() {},
    removeItem() {},
  };
}

describe('isPreservedKey', () => {
  it('matches each preserved family exactly and by dot extension', () => {
    expect(isPreservedKey(ARCHIVE_BACKUP_KEY)).toBe(true);
    expect(isPreservedKey(`${ARCHIVE_BACKUP_KEY}.9f2a`)).toBe(true);
    expect(isPreservedKey(`${ARCHIVE_BACKUP_KEY}.9f2a-3`)).toBe(true);
    expect(isPreservedKey(LEGACY_INDEX_KEY)).toBe(true);
    expect(isPreservedKey(LEGACY_PERSIST_KEY)).toBe(true);
  });

  it('matches the corrupt settings family, which can hold a pre-v2 thread', () => {
    expect(isPreservedKey(`${LEGACY_PERSIST_KEY}.corrupt`)).toBe(true);
    expect(isPreservedKey(`${LEGACY_PERSIST_KEY}.corrupt.1717430000000`)).toBe(true);
  });

  it('excludes the live archive, which is collected separately', () => {
    expect(isPreservedKey(ARCHIVE_KEY)).toBe(false);
  });

  it('excludes unrelated application keys', () => {
    expect(isPreservedKey('flint-theme')).toBe(false);
    expect(isPreservedKey(`${ARCHIVE_BACKUP_KEY}x`)).toBe(false);
  });
});

describe('collectPreservedPayloads', () => {
  it('collects every preserved key and no others', () => {
    const result = collectPreservedPayloads(
      fakeStorage({
        [ARCHIVE_KEY]: 'live',
        [ARCHIVE_BACKUP_KEY]: 'parked',
        [`${ARCHIVE_BACKUP_KEY}.abc`]: 'parked-2',
        [`${LEGACY_PERSIST_KEY}.corrupt`]: 'settings',
        'flint-theme': 'dark',
      }),
    );
    expect(result.payloads.map((p) => p.key).sort()).toEqual(
      [ARCHIVE_BACKUP_KEY, `${ARCHIVE_BACKUP_KEY}.abc`, `${LEGACY_PERSIST_KEY}.corrupt`].sort(),
    );
    expect(isComplete(result)).toBe(true);
  });

  it('keeps an empty stored value, which is a value and not an absence', () => {
    const result = collectPreservedPayloads(fakeStorage({ [ARCHIVE_BACKUP_KEY]: '' }));
    expect(result.payloads).toEqual([{ key: ARCHIVE_BACKUP_KEY, raw: '' }]);
  });

  it('reports an unreadable key instead of dropping it silently', () => {
    const result = collectPreservedPayloads(
      fakeStorage(
        { [ARCHIVE_BACKUP_KEY]: 'parked', [`${ARCHIVE_BACKUP_KEY}.abc`]: 'parked-2' },
        { failOn: [ARCHIVE_BACKUP_KEY] },
      ),
    );
    expect(result.payloads).toEqual([{ key: `${ARCHIVE_BACKUP_KEY}.abc`, raw: 'parked-2' }]);
    expect(result.failedKeys).toEqual([ARCHIVE_BACKUP_KEY]);
    expect(isComplete(result)).toBe(false);
  });

  it('reports a failed enumeration rather than an empty storage', () => {
    const result = collectPreservedPayloads(
      fakeStorage({ [ARCHIVE_BACKUP_KEY]: 'parked' }, { failEnumeration: true }),
    );
    expect(result.payloads).toEqual([]);
    expect(result.enumerationFailed).toBe(true);
    expect(isComplete(result)).toBe(false);
  });

  it('still exports the keys seen before enumeration failed partway', () => {
    // Those bytes may be the only surviving copy of a conversation. Discarding them because a
    // later index threw would lose data the export could have rescued.
    let calls = 0;
    const storage: any = {
      length: 3,
      key: (i: number) => {
        calls += 1;
        if (calls > 1) throw new Error('enumeration failed');
        return i === 0 ? ARCHIVE_BACKUP_KEY : null;
      },
      getItem: (k: string) => (k === ARCHIVE_BACKUP_KEY ? 'parked' : null),
      setItem: () => {},
      removeItem: () => {},
    };
    const result = collectPreservedPayloads(storage);
    expect(result.payloads).toEqual([{ key: ARCHIVE_BACKUP_KEY, raw: 'parked' }]);
    expect(result.enumerationFailed).toBe(true);
    expect(isComplete(result)).toBe(false);
  });

  it('does not report a payload for a key that is unset', () => {
    const result = collectPreservedPayloads(fakeStorage({}));
    expect(result.payloads).toEqual([]);
    expect(isComplete(result)).toBe(true);
  });
});

describe('collectStoredArchive', () => {
  it('returns the stored bytes verbatim without parsing them', () => {
    const result = collectStoredArchive(fakeStorage({ [ARCHIVE_KEY]: '{not json' }));
    expect(result).toEqual({ raw: '{not json', ok: true });
  });

  it('distinguishes an unset key from an unreadable one', () => {
    expect(collectStoredArchive(fakeStorage({}))).toEqual({ raw: null, ok: true });
    expect(
      collectStoredArchive(fakeStorage({ [ARCHIVE_KEY]: 'x' }, { failOn: [ARCHIVE_KEY] })),
    ).toEqual({ raw: null, ok: false });
  });
});

describe('buildExportDocument', () => {
  const exportedAt = new Date('2026-05-04T14:12:33Z');

  const session = (archive: any) => ({ archive, liveThread: null, captured: true });

  it('carries the stored bytes even when the session archive is empty', () => {
    const doc = buildExportDocument({
      session: session({ version: 2, conversations: [], activeId: null } as any),
      storedArchive: { raw: '{damaged', ok: true },
      preserved: emptyCollection(false),
      appVersion: '0.6.0',
      exportedAt,
    });
    expect(doc.storedArchive).toBe('{damaged');
    expect(doc.flintExport).toBe(EXPORT_FORMAT);
    expect(doc.appVersion).toBe('0.6.0');
    expect(doc.exportedAt).toBe('2026-05-04T14:12:33.000Z');
    expect(doc.complete).toBe(true);
  });

  it('is incomplete when the live archive could not be read', () => {
    const doc = buildExportDocument({
      session: session(null),
      storedArchive: { raw: null, ok: false },
      preserved: emptyCollection(false),
      appVersion: '0.6.0',
      exportedAt,
    });
    expect(doc.complete).toBe(false);
    expect(doc.incomplete.archiveUnreadable).toBe(true);
  });

  it('is incomplete when a preserved key could not be read', () => {
    const doc = buildExportDocument({
      session: session(null),
      storedArchive: { raw: null, ok: true },
      preserved: { ...emptyCollection(true), failedKeys: [ARCHIVE_BACKUP_KEY] },
      appVersion: '0.6.0',
      exportedAt,
    });
    expect(doc.complete).toBe(false);
    expect(doc.incomplete.failedKeys).toEqual([ARCHIVE_BACKUP_KEY]);
    expect(doc.incomplete.enumerationFailed).toBe(true);
  });

  it('round-trips damaged bytes through JSON without altering them', () => {
    const damaged = '{"a":"\u0007 \\ \ud800 "';
    const doc = buildExportDocument({
      session: session(null),
      storedArchive: { raw: damaged, ok: true },
      preserved: {
        ...emptyCollection(false),
        payloads: [{ key: ARCHIVE_BACKUP_KEY, raw: damaged }],
      },
      appVersion: '0.6.0',
      exportedAt,
    });
    const reread = JSON.parse(serializeExportDocument(doc));
    expect(reread.storedArchive).toBe(damaged);
    expect(reread.preserved[0].raw).toBe(damaged);
  });
});

describe('exportFileName', () => {
  it('uses zero-padded local time so names sort chronologically', () => {
    const at = new Date(2026, 4, 4, 9, 5, 3);
    expect(exportFileName(at)).toBe('flint-conversations-2026-05-04-090503.json');
  });

  it('pads a single-digit month and day', () => {
    const at = new Date(2026, 0, 2, 23, 59, 59);
    expect(exportFileName(at)).toBe('flint-conversations-2026-01-02-235959.json');
  });
});

describe('enumeration instability', () => {
  it('reports a short key list as unstable rather than a complete one', () => {
    const storage = {
      length: 3,
      key: (i: number) => (i === 0 ? ARCHIVE_BACKUP_KEY : null),
      getItem: () => 'parked',
      setItem() {},
      removeItem() {},
    };
    const result = collectPreservedPayloads(storage);
    expect(result.enumerationUnstable).toBe(true);
    expect(isComplete(result)).toBe(false);
  });

  it('reports a repeated key as unstable', () => {
    const storage = {
      length: 2,
      key: () => ARCHIVE_BACKUP_KEY,
      getItem: () => 'parked',
      setItem() {},
      removeItem() {},
    };
    expect(collectPreservedPayloads(storage).enumerationUnstable).toBe(true);
  });

  it('reports a changed key count as unstable', () => {
    let reads = 0;
    const storage = {
      get length() {
        reads += 1;
        return reads === 1 ? 1 : 2;
      },
      key: () => ARCHIVE_BACKUP_KEY,
      getItem: () => 'parked',
      setItem() {},
      removeItem() {},
    };
    expect(collectPreservedPayloads(storage).enumerationUnstable).toBe(true);
  });

  it('distinguishes a key that vanished after enumeration from one never present', () => {
    const storage = {
      length: 1,
      key: () => ARCHIVE_BACKUP_KEY,
      getItem: () => null,
      setItem() {},
      removeItem() {},
    };
    const result = collectPreservedPayloads(storage);
    expect(result.vanishedKeys).toEqual([ARCHIVE_BACKUP_KEY]);
    expect(result.payloads).toEqual([]);
    expect(isComplete(result)).toBe(false);
  });
});

describe('isRecoveryCopyKey', () => {
  it('treats the live legacy keys as ordinary data, not damage', () => {
    expect(isRecoveryCopyKey(LEGACY_PERSIST_KEY)).toBe(false);
    expect(isRecoveryCopyKey(LEGACY_INDEX_KEY)).toBe(false);
  });

  it('treats parked slots as recovery copies', () => {
    expect(isRecoveryCopyKey(ARCHIVE_BACKUP_KEY)).toBe(true);
    expect(isRecoveryCopyKey(`${ARCHIVE_BACKUP_KEY}.abc`)).toBe(true);
    expect(isRecoveryCopyKey(`${LEGACY_PERSIST_KEY}.corrupt`)).toBe(true);
    expect(isRecoveryCopyKey(`${LEGACY_INDEX_KEY}.corrupt`)).toBe(true);
  });
});

describe('hasRecoveryCopies', () => {
  it('is true for a copy left by an earlier launch', () => {
    expect(hasRecoveryCopies(fakeStorage({ [ARCHIVE_BACKUP_KEY]: 'x' }))).toBe('present');
  });

  it('is false for an ordinary install', () => {
    expect(hasRecoveryCopies(fakeStorage({ [ARCHIVE_KEY]: 'x', [LEGACY_PERSIST_KEY]: 'y' }))).toBe(
      'absent',
    );
  });

  it('reports unknown when storage cannot be enumerated', () => {
    expect(
      hasRecoveryCopies(fakeStorage({ [ARCHIVE_BACKUP_KEY]: 'x' }, { failEnumeration: true })),
    ).toBe('unknown');
  });

  it('reports unknown when the listing shrinks under the walk', () => {
    // Another writer removes a key mid-scan, so an index below the reported length yields no
    // name. `key()` answers null rather than throwing, and the entries after the removed one
    // were never examined — so this cannot be reported as "no recovery copies exist".
    const entries: Record<string, string> = { a: '1', b: '2', [ARCHIVE_BACKUP_KEY]: 'x' };
    const keys = Object.keys(entries);
    let reads = 0;
    const shrinking: EnumerableStorage = {
      get length() {
        return keys.length;
      },
      key(index: number) {
        reads += 1;
        if (reads > 1) return null;
        return keys[index] ?? null;
      },
      getItem: (key: string) => entries[key] ?? null,
      setItem() {},
      removeItem() {},
    };
    expect(hasRecoveryCopies(shrinking)).toBe('unknown');
  });

  it('reports unknown when the listing churns without changing its length', () => {
    // The hard case: one key removed and another added, so `length` never moves and `key()`
    // never answers null. The indices still shift, so a single walk can step over the recovery
    // copy entirely and see nothing unusual. Only comparing the key set across two listings
    // catches it.
    // Each walk sees a same-sized set, and neither happens to include the recovery copy the
    // shifting indices stepped over. Nothing within a single walk looks wrong: no null, no
    // duplicate, no length change. The sets simply disagree, which is the only available
    // evidence that the walk cannot be trusted to have seen everything.
    const listings = [
      ['a', 'b', 'c'],
      ['a', 'b', 'd'],
    ];
    let walk = -1;
    const current = () => listings[Math.min(Math.max(walk, 0), listings.length - 1)];
    const churning: EnumerableStorage = {
      get length() {
        // Deliberately not tied to the length read: `listKeys` checks the length twice per walk,
        // so advancing here would make the fake depend on that detail rather than on the churn
        // it is meant to model.
        return current().length;
      },
      key(i: number) {
        // A walk always starts at index 0, so that is where the next listing takes effect.
        if (i === 0) walk += 1;
        return current()[i] ?? null;
      },
      getItem: () => null,
      setItem() {},
      removeItem() {},
    };
    expect(hasRecoveryCopies(churning)).toBe('unknown');
  });

  it('reports present from an unstable listing, since a listed key really existed', () => {
    // Churn can hide a key but cannot invent one, so seeing the copy is conclusive even though
    // the enumeration is not trustworthy enough to prove absence.
    const entries = ['a', ARCHIVE_BACKUP_KEY];
    let reads = 0;
    const unstable: EnumerableStorage = {
      get length() {
        return entries.length;
      },
      key(index: number) {
        reads += 1;
        // Duplicate name, which `listKeys` treats as proof the set shifted mid-walk.
        if (reads > entries.length) return 'a';
        return entries[index] ?? null;
      },
      getItem: () => null,
      setItem() {},
      removeItem() {},
    };
    expect(hasRecoveryCopies(unstable)).toBe('present');
  });
});

describe('buildExportDocument session status', () => {
  const exportedAt = new Date('2026-05-04T14:12:33Z');

  it('carries a thread that belongs to no conversation', () => {
    const doc = buildExportDocument({
      session: { archive: null, liveThread: { loadedFor: null, messages: [{ id: 'a' }] }, captured: true },
      storedArchive: { raw: null, ok: true },
      preserved: emptyCollection(false),
      appVersion: '0.6.0',
      exportedAt,
    });
    expect(doc.liveThread).toEqual({ loadedFor: null, messages: [{ id: 'a' }] });
    expect(doc.complete).toBe(true);
  });

  it('is incomplete when the thread could not be attributed', () => {
    const doc = buildExportDocument({
      session: { archive: null, liveThread: { loadedFor: 'c1', messages: [] }, captured: false },
      storedArchive: { raw: null, ok: true },
      preserved: emptyCollection(false),
      appVersion: '0.6.0',
      exportedAt,
    });
    expect(doc.complete).toBe(false);
    expect(doc.incomplete.sessionCaptureFailed).toBe(true);
  });
});

describe('isWithinAppData', () => {
  it('rejects a destination inside the application directory', () => {
    expect(isWithinAppData('/Users/a/Library/Application Support/Flint/x.json', [
      '/Users/a/Library/Application Support/Flint',
    ])).toBe(true);
  });

  it('accepts a sibling whose name merely starts the same', () => {
    expect(isWithinAppData('/Users/a/flint-backups/x.json', ['/Users/a/flint'])).toBe(false);
  });

  it('ignores separator style and case, as Windows and macOS both do', () => {
    expect(isWithinAppData('C:\\Users\\A\\AppData\\Roaming\\Flint\\x.json', [
      'c:/users/a/appdata/roaming/flint',
    ])).toBe(true);
  });

  it('tolerates a trailing separator on the directory', () => {
    expect(isWithinAppData('/data/flint/x.json', ['/data/flint/'])).toBe(true);
  });

  it('claims nothing when no application directory is known', () => {
    expect(isWithinAppData('/data/flint/x.json', [])).toBe(false);
    expect(isWithinAppData('/data/flint/x.json', [''])).toBe(false);
  });
});

describe('same-count key churn', () => {
  it('detects a removal paired with an addition, which leaves the count unchanged', () => {
    // The positional walk steps over backupA: after `theme` is read at index 0 the set shifts
    // down, so index 1 yields backupB and index 2 the newly added key. Nothing looks wrong —
    // three keys, all distinct, all readable — yet backupA was never visited.
    const before = ['flint-theme', `${ARCHIVE_BACKUP_KEY}.a`, `${ARCHIVE_BACKUP_KEY}.b`];
    const after = [`${ARCHIVE_BACKUP_KEY}.a`, `${ARCHIVE_BACKUP_KEY}.b`, 'flint-new'];
    let walked = 0;
    const storage = {
      length: 3,
      key(i: number) {
        // The mutation lands after the first read, exactly as a concurrent writer would.
        const list = walked++ === 0 ? before : after;
        return list[i] ?? null;
      },
      getItem: (k: string) => (k === 'flint-theme' ? 'dark' : 'parked'),
      setItem() {},
      removeItem() {},
    };
    const result = collectPreservedPayloads(storage);
    expect(result.enumerationUnstable).toBe(true);
    expect(isComplete(result)).toBe(false);
  });

  it('stays complete when the key set is identical across both listings', () => {
    const keys = [ARCHIVE_BACKUP_KEY, 'flint-theme'];
    const storage = {
      length: 2,
      key: (i: number) => keys[i] ?? null,
      getItem: () => 'parked',
      setItem() {},
      removeItem() {},
    };
    expect(isComplete(collectPreservedPayloads(storage))).toBe(true);
  });

  it('is unstable when the second listing cannot be taken', () => {
    // The first listing reads `length` twice — once to walk, once to confirm the count held.
    let reads = 0;
    const storage = {
      get length() {
        if (++reads > 2) throw new Error('denied');
        return 1;
      },
      key: () => ARCHIVE_BACKUP_KEY,
      getItem: () => 'parked',
      setItem() {},
      removeItem() {},
    };
    const result = collectPreservedPayloads(storage);
    expect(result.enumerationFailed).toBe(false);
    expect(result.enumerationUnstable).toBe(true);
    // The payload it did manage to read is still carried out.
    expect(result.payloads).toEqual([{ key: ARCHIVE_BACKUP_KEY, raw: 'parked' }]);
  });

  it('reports a failed first listing as failed, not merely unstable', () => {
    const result = collectPreservedPayloads(
      fakeStorage({ [ARCHIVE_BACKUP_KEY]: 'x' }, { failEnumeration: true }),
    );
    expect(result.enumerationFailed).toBe(true);
    expect(isComplete(result)).toBe(false);
  });
});

describe('classifyDestination', () => {
  // A filesystem where names and locations disagree, as they do in reality.
  //   /root/appdata   the protected directory
  //   /link/appdata   a link to it
  //   /link/inner     a link to a directory *inside* it
  //   /var            a link to /private/var, as on macOS
  const ids: Record<string, { dev: number; ino: number }> = {
    '/': { dev: 1, ino: 0 },
    '/root': { dev: 1, ino: 1 },
    '/root/home': { dev: 1, ino: 2 },
    '/root/home/docs': { dev: 1, ino: 3 },
    '/root/appdata': { dev: 1, ino: 4 },
    '/root/appdata/sub': { dev: 1, ino: 5 },
    '/private': { dev: 1, ino: 6 },
    '/private/var': { dev: 1, ino: 7 },
    '/private/var/tmp': { dev: 1, ino: 8 },
    '/link': { dev: 1, ino: 9 },
  };
  // What each link points at. `stat` resolves these; `lstat` does not, and reports the link's
  // own identity instead — which is how the walk notices the spelling is not the location.
  const links: Record<string, string> = {
    '/link/appdata': '/root/appdata',
    '/link/inner': '/root/appdata/sub',
    // `/var` is the link; `/var/tmp` is an ordinary directory reached through it, so the walk
    // has to climb a level before the disagreement appears.
    '/var': '/private/var',
  };
  const linkIds: Record<string, { dev: number; ino: number }> = {
    '/link/appdata': { dev: 1, ino: 100 },
    '/link/inner': { dev: 1, ino: 101 },
    '/var': { dev: 1, ino: 102 },
  };
  // Rewrites a path through any link on its way down, so the fixture behaves like a filesystem
  // rather than a lookup table of special cases.
  const resolve = (path: string): string => {
    for (const [link, target] of Object.entries(links)) {
      if (path === link) return target;
      if (path.startsWith(`${link}/`)) return resolve(target + path.slice(link.length));
    }
    return path;
  };
  const probe: DestinationProbe = {
    // Resolves each leading component, as the kernel does: `/var/tmp` is found through the
    // `/var` link even though `/var/tmp` is not a link itself.
    stat: async (path: string) => {
      const id = ids[resolve(path)];
      if (!id) throw new Error(`no such directory: ${path}`);
      return id;
    },
    lstat: async (path: string) => {
      if (linkIds[path]) return linkIds[path];
      const id = ids[resolve(path)];
      if (!id) throw new Error(`no such directory: ${path}`);
      return id;
    },
    dirname: async (path: string) => {
      const cut = path.lastIndexOf('/');
      return cut <= 0 ? '/' : path.slice(0, cut);
    },
  };
  const classify = (file: string, roots: string[], p: DestinationProbe = probe) =>
    classifyDestination(file, roots, p);

  it('accepts a destination outside the application directory', async () => {
    expect(await classify('/root/home/docs/x.json', ['/root/appdata'])).toBe('outside');
  });

  it('refuses a destination named inside the application directory', async () => {
    expect(await classify('/root/appdata/sub/x.json', ['/root/appdata'])).toBe('inside');
  });

  it('refuses a destination reached by another name for the same directory', async () => {
    // The prefix test cannot see this: the paths share no prefix at all.
    expect(await classify('/link/appdata/x.json', ['/root/appdata'])).toBe('inside');
  });

  it('will not claim safety for a link pointing inside the application directory', async () => {
    // The link is not itself the protected root, so comparing roots alone would answer
    // "outside". `lstat` disagreeing with `stat` stops that.
    expect(await classify('/link/inner/x.json', ['/root/appdata'])).toBe('unverified');
  });

  it('will not claim safety where an ancestor name lies, as /var does on macOS', async () => {
    // `/var/tmp` is a real directory and agrees with itself, so the walk has to climb to `/var`
    // before it finds the link. Trimming the string from there gives `/`, never seeing
    // `/private` — which is exactly why reaching `/` is not allowed to mean "outside" here.
    expect(await classify('/var/tmp/x.json', ['/private'])).toBe('unverified');
  });

  it('will not claim safety when no application directory could be resolved', async () => {
    expect(await classify('/root/home/docs/x.json', [])).toBe('unverified');
  });

  it('will not claim safety when a root cannot be stat-ed', async () => {
    expect(await classify('/root/home/docs/x.json', ['/root/missing'])).toBe('unverified');
  });

  it('will not claim safety when the platform reports no inode identity', async () => {
    const anonymous: DestinationProbe = {
      ...probe,
      stat: async () => ({ dev: null, ino: null }),
    };
    expect(await classify('/root/home/docs/x.json', ['/root/appdata'], anonymous)).toBe(
      'unverified',
    );
  });

  it('will not claim safety when an ancestor reports no identity', async () => {
    // Unknown is not evidence of non-containment: walking past it could reach the root and
    // answer "outside" for a chain that was never actually examined.
    const partial: DestinationProbe = {
      ...probe,
      stat: async (path: string) =>
        path === '/root/home' ? { dev: null, ino: null } : probe.stat(path),
    };
    expect(await classify('/root/home/docs/x.json', ['/root/appdata'], partial)).toBe(
      'unverified',
    );
  });

  it('will not claim safety when link identity is unavailable', async () => {
    const partial: DestinationProbe = {
      ...probe,
      lstat: async () => ({ dev: null, ino: null }),
    };
    expect(await classify('/root/home/docs/x.json', ['/root/appdata'], partial)).toBe(
      'unverified',
    );
  });

  it('will not claim safety when an ancestor cannot be read', async () => {
    expect(await classify('/root/elsewhere/deep/x.json', ['/root/appdata'])).toBe('unverified');
  });

  it('will not claim safety when the parent lookup fails', async () => {
    const broken: DestinationProbe = {
      ...probe,
      dirname: async () => {
        throw new Error('denied');
      },
    };
    expect(await classify('/root/home/docs/x.json', ['/root/appdata'], broken)).toBe('unverified');
  });

  it('gives up rather than spinning when ancestry never reaches a fixed point', async () => {
    let n = 0;
    const endless: DestinationProbe = {
      stat: async (path: string) =>
        path === '/root/appdata' ? { dev: 1, ino: 4 } : { dev: 2, ino: (n += 1) },
      lstat: async (path: string) =>
        path === '/root/appdata' ? { dev: 1, ino: 4 } : { dev: 2, ino: n },
      dirname: async (path: string) => `${path}/up`,
    };
    expect(await classify('/root/home/x.json', ['/root/appdata'], endless)).toBe('unverified');
  });
});
