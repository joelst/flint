import { describe, it, expect } from 'vitest';
import {
  CONVERSATION_SCHEMA_VERSION,
  normalizeContentDetailed,
  normalizeMessageDetailed,
  deriveRecoveredId,
  SKIP_APP_VERSION_GATE,
  OPAQUE_PART_TYPE,
  isOpaquePart,
  supportedParts,
  isUsableVersion,
  MIN_ROLLBACK_APP_VERSION,
  compareVersions,
  normalizeContent,
  contentToText,
  normalizeMessage,
  normalizeConversation,
  parseConversationArchive,
  deriveConversationTitle,
  createEmptyArchive,
  migrateLegacyConversations,
} from './conversation-store';

const textMsg = (role: string, text: string) => ({ role, content: text });

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.4.0', '0.5.0')).toBe(-1);
  });

  it('sorts a pre-release below its release', () => {
    expect(compareVersions('0.6.0-rc.1', '0.6.0')).toBe(-1);
    expect(compareVersions('0.6.0', '0.6.0-rc.1')).toBe(1);
  });

  it('orders pre-release identifiers instead of treating every pre-release as equal', () => {
    // Collapsing these to one "has pre-release" bit lets an rc.1 build write over an archive
    // that requires rc.2, which defeats the rollback gate entirely.
    expect(compareVersions('0.6.0-rc.1', '0.6.0-rc.2')).toBe(-1);
    expect(compareVersions('0.6.0-rc.2', '0.6.0-rc.1')).toBe(1);
    expect(compareVersions('0.6.0-rc.10', '0.6.0-rc.2')).toBe(1);
    expect(compareVersions('0.6.0-rc.1', '0.6.0-rc.1')).toBe(0);
    // SemVer: fewer identifiers rank lower when the shared ones match.
    expect(compareVersions('0.6.0-rc', '0.6.0-rc.1')).toBe(-1);
    // SemVer: numeric identifiers rank below alphanumeric ones.
    expect(compareVersions('0.6.0-1', '0.6.0-alpha')).toBe(-1);
  });

  it('treats missing components as zero', () => {
    expect(compareVersions('0.5', '0.5.0')).toBe(0);
    expect(compareVersions('', '0.0.0')).toBe(0);
  });
});

describe('normalizeContent', () => {
  it('keeps a plain string as-is', () => {
    expect(normalizeContent('hello')).toBe('hello');
    expect(normalizeContent('')).toBe('');
  });

  it('preserves multipart content rather than collapsing it', () => {
    const parts = [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ];
    expect(normalizeContent(parts)).toEqual(parts);
  });

  it('keeps a single text part as an array, not a bare string', () => {
    expect(normalizeContent([{ type: 'text', text: 'hi' }])).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('drops unrecoverable parts but keeps unrecognized ones verbatim', () => {
    const result = normalizeContentDetailed([
      { type: 'text', text: 'keep' },
      { type: 'image_url', image_url: {} },
      null,
      { type: 'video', src: 'x' },
    ]);
    // The video part is data we cannot render but must not destroy — it is wrapped as opaque
    // so no renderer or inference builder can mistake it for a supported part.
    expect(result.content).toEqual([
      { type: 'text', text: 'keep' },
      { type: OPAQUE_PART_TYPE, original: { type: 'video', src: 'x' } },
    ]);
    expect(result.droppedParts).toBe(2);
    expect(result.unrecognizedParts).toBe(1);
  });

  it('preserves an empty array rather than deleting the message', () => {
    // `content: ''` survives, so `content: []` must too.
    expect(normalizeContent([])).toEqual([]);
  });

  it('keeps extra properties on a part', () => {
    const parts = [{ type: 'image_url', image_url: { url: 'x', detail: 'high' }, name: 'a.png' }];
    expect(normalizeContent(parts)).toEqual(parts);
  });

  it('rejects content that is neither a string nor an array', () => {
    expect(normalizeContent({ text: 'hi' })).toBeNull();
    expect(normalizeContent(null)).toBeNull();
    expect(normalizeContent(42)).toBeNull();
  });
});

describe('contentToText', () => {
  it('flattens parts and never stringifies the array', () => {
    const text = contentToText([
      { type: 'text', text: 'a' },
      { type: 'image_url', image_url: { url: 'x' } },
      { type: 'text', text: 'b' },
    ]);
    expect(text).toBe('a\nb');
    expect(text).not.toContain('object');
  });

  it('returns empty text for an image-only turn', () => {
    expect(contentToText([{ type: 'image_url', image_url: { url: 'x' } }])).toBe('');
  });
});

describe('normalizeMessage', () => {
  it('assigns a fallback id when none is stored', () => {
    expect(normalizeMessage(textMsg('user', 'hi'), 'c-m0')).toEqual({
      id: 'c-m0',
      role: 'user',
      content: 'hi',
    });
  });

  it('keeps a stored id and timestamp', () => {
    const m = normalizeMessage({ role: 'assistant', content: 'ok', id: 'a1', createdAt: 5 }, 'x');
    expect(m).toEqual({ id: 'a1', role: 'assistant', content: 'ok', createdAt: 5 });
  });

  it('rejects an unknown role', () => {
    expect(normalizeMessage({ role: 'tool', content: 'x' }, 'x')).toBeNull();
  });

  it('rejects a message whose content cannot be stored', () => {
    expect(normalizeMessage({ role: 'user', content: { a: 1 } }, 'x')).toBeNull();
  });

  it('drops a non-finite timestamp rather than storing NaN', () => {
    const m = normalizeMessage({ role: 'user', content: 'x', createdAt: Number.NaN }, 'x');
    expect(m).not.toHaveProperty('createdAt');
  });
});

describe('normalizeConversation', () => {
  it('requires an id', () => {
    expect(normalizeConversation({ title: 'x' }).conversation).toBeNull();
    expect(normalizeConversation({ id: '', title: 'x' }).conversation).toBeNull();
  });

  it('counts dropped messages instead of failing the conversation', () => {
    const result = normalizeConversation({
      id: 'c1',
      title: 't',
      createdAt: 1,
      messages: [textMsg('user', 'keep'), { role: 'nope', content: 'x' }],
    });
    expect(result.conversation?.messages).toHaveLength(1);
    expect(result.droppedMessages).toBe(1);
  });

  it('defaults updatedAt to createdAt', () => {
    expect(normalizeConversation({ id: 'c', createdAt: 7 }).conversation?.updatedAt).toBe(7);
  });

  it('keeps conversation settings but ignores a non-object', () => {
    expect(normalizeConversation({ id: 'c', settings: { model: 'a' } }).conversation?.settings).toEqual({ model: 'a' });
    expect(normalizeConversation({ id: 'c', settings: [1] }).conversation).not.toHaveProperty('settings');
  });

  it('preserves the recovered and messagesUnavailable labels', () => {
    const c = normalizeConversation({ id: 'c', recovered: true, messagesUnavailable: true }).conversation;
    expect(c?.recovered).toBe(true);
    expect(c?.messagesUnavailable).toBe(true);
  });
});

describe('parseConversationArchive', () => {
  const archive = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: MIN_ROLLBACK_APP_VERSION,
      activeId: 'c1',
      conversations: [{ id: 'c1', title: 'One', createdAt: 1, messages: [textMsg('user', 'hi')] }],
      ...over,
    });

  it('returns nothing for absent storage without claiming corruption', () => {
    for (const raw of [null, undefined, '']) {
      const r = parseConversationArchive(raw, SKIP_APP_VERSION_GATE);
      expect(r.archive).toBeNull();
      expect(r.corrupt).toBe(false);
      expect(r.incompatible).toBe(false);
    }
  });

  it('round-trips a valid archive', () => {
    const r = parseConversationArchive(archive(), SKIP_APP_VERSION_GATE);
    expect(r.corrupt).toBe(false);
    expect(r.archive?.activeId).toBe('c1');
    expect(r.archive?.conversations[0].messages[0].content).toBe('hi');
  });

  it('flags unparseable and non-object roots as corrupt', () => {
    expect(parseConversationArchive('{oops', SKIP_APP_VERSION_GATE).corrupt).toBe(true);
    expect(parseConversationArchive('null', SKIP_APP_VERSION_GATE).corrupt).toBe(true);
    expect(parseConversationArchive('[]', SKIP_APP_VERSION_GATE).corrupt).toBe(true);
  });

  it('treats a missing or non-numeric version as corrupt', () => {
    expect(parseConversationArchive(JSON.stringify({ conversations: [] }), SKIP_APP_VERSION_GATE).corrupt).toBe(true);
    expect(parseConversationArchive(archive({ version: 'two' }), SKIP_APP_VERSION_GATE).corrupt).toBe(true);
  });

  it('refuses a newer archive without calling it corrupt', () => {
    const r = parseConversationArchive(archive({ version: CONVERSATION_SCHEMA_VERSION + 1 }), SKIP_APP_VERSION_GATE);
    expect(r.incompatible).toBe(true);
    expect(r.corrupt).toBe(false);
    expect(r.archive).toBeNull();
  });

  it('treats a missing conversations array as corrupt', () => {
    expect(parseConversationArchive(archive({ conversations: undefined }), SKIP_APP_VERSION_GATE).corrupt).toBe(true);
  });

  it('drops unusable conversations and reports a partial restore', () => {
    const r = parseConversationArchive(
      archive({ conversations: [{ id: 'c1' }, { title: 'no id' }] }),
      SKIP_APP_VERSION_GATE
    );
    expect(r.archive?.conversations).toHaveLength(1);
    expect(r.droppedConversations).toBe(1);
    expect(r.corrupt).toBe(true);
  });

  it('clears an activeId that no longer resolves', () => {
    expect(parseConversationArchive(archive({ activeId: 'gone' }), SKIP_APP_VERSION_GATE).archive?.activeId).toBeNull();
  });
});

describe('deriveConversationTitle', () => {
  it('uses the first user turn and collapses whitespace', () => {
    expect(
      deriveConversationTitle([
        { id: 'a', role: 'assistant', content: 'hello there' },
        { id: 'b', role: 'user', content: '  explain\n  quantum  ' },
      ])
    ).toBe('explain quantum');
  });

  it('truncates long titles with an ellipsis', () => {
    const title = deriveConversationTitle([{ id: 'a', role: 'user', content: 'x'.repeat(80) }]);
    expect(title).toHaveLength(51);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back when the first user turn is an image only', () => {
    expect(
      deriveConversationTitle([
        { id: 'a', role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
      ])
    ).toBe('New chat');
  });
});

describe('migrateLegacyConversations', () => {
  const legacyIndex = [
    { id: 'c1', title: 'First', createdAt: 100, messageCount: 4 },
    { id: 'c2', title: 'Second', createdAt: 200, messageCount: 0 },
  ];
  const legacyMessages = [textMsg('user', 'the real thread'), textMsg('assistant', 'reply')];

  it('imports the orphan global thread as its own labeled conversation', () => {
    const r = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 999 });
    const recovered = r.archive.conversations.filter((c) => c.recovered);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].messages).toHaveLength(2);
    expect(recovered[0].title).toContain('Recovered chat');
    expect(r.recoveredThread).toBe(true);
  });

  it('never attaches the global thread to the first sidebar entry', () => {
    const r = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 999 });
    const first = r.archive.conversations.find((c) => c.id === 'c1');
    expect(first?.messages).toHaveLength(0);
    expect(first?.recovered).toBeUndefined();
  });

  it('marks legacy entries that claimed turns which were never stored', () => {
    const r = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 999 });
    expect(r.archive.conversations.find((c) => c.id === 'c1')?.messagesUnavailable).toBe(true);
    expect(r.archive.conversations.find((c) => c.id === 'c2')?.messagesUnavailable).toBeUndefined();
    expect(r.titleOnlyConversations).toBe(1);
  });

  it('preserves legacy titles and creation times', () => {
    const r = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 999 });
    const c2 = r.archive.conversations.find((c) => c.id === 'c2');
    expect(c2?.title).toBe('Second');
    expect(c2?.createdAt).toBe(200);
  });

  it('is idempotent for the same legacy input', () => {
    const a = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 999 });
    const b = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 999 });
    expect(b.archive).toEqual(a.archive);
  });

  it('creates no recovered conversation when there was no global thread', () => {
    const r = migrateLegacyConversations({ legacyIndex, legacyMessages: [], now: 999 });
    expect(r.recoveredThread).toBe(false);
    expect(r.archive.conversations.some((c) => c.recovered)).toBe(false);
    expect(r.archive.activeId).toBe('c1');
  });

  it('handles a first run with nothing stored at all', () => {
    const r = migrateLegacyConversations({ legacyIndex: null, legacyMessages: null, now: 1 });
    expect(r.archive.conversations).toHaveLength(0);
    expect(r.archive.activeId).toBeNull();
    expect(r.archive.version).toBe(CONVERSATION_SCHEMA_VERSION);
  });

  it('recovers a thread even when the legacy index is unusable', () => {
    const r = migrateLegacyConversations({ legacyIndex: 'garbage', legacyMessages, now: 5 });
    expect(r.archive.conversations).toHaveLength(1);
    expect(r.archive.conversations[0].recovered).toBe(true);
    expect(r.archive.activeId).toBe(r.archive.conversations[0].id);
  });

  it('preserves multipart turns through migration', () => {
    const parts = [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ];
    const r = migrateLegacyConversations({
      legacyIndex: [],
      legacyMessages: [{ role: 'user', content: parts }],
      now: 5,
    });
    expect(r.archive.conversations[0].messages[0].content).toEqual(parts);
  });

  it('produces an archive that parses back cleanly', () => {
    const r = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 999 });
    const round = parseConversationArchive(JSON.stringify(r.archive), SKIP_APP_VERSION_GATE);
    expect(round.corrupt).toBe(false);
    expect(round.archive?.conversations).toHaveLength(3);
  });
});

describe('createEmptyArchive', () => {
  it('stamps the current schema and rollback floor', () => {
    const a = createEmptyArchive();
    expect(a.version).toBe(CONVERSATION_SCHEMA_VERSION);
    expect(a.minAppVersion).toBe(MIN_ROLLBACK_APP_VERSION);
    expect(a.activeId).toBeNull();
  });
});

describe('message metadata preservation', () => {
  // These flags drive real behavior: isError keeps a turn out of the next request, pinned
  // exempts it from condensation, condensed hides it, isSummary marks the generated summary.
  it('round-trips every flag the app depends on', () => {
    const raw = {
      id: 'm1',
      role: 'assistant',
      content: 'summary text',
      isError: true,
      pinned: true,
      condensed: true,
      isSummary: true,
    };
    const message = normalizeMessage(raw, 'fallback');
    expect(message).toMatchObject({
      isError: true,
      pinned: true,
      condensed: true,
      isSummary: true,
    });

    const archive = createEmptyArchive();
    archive.conversations.push({
      id: 'c1', title: 't', createdAt: 1, updatedAt: 1, messages: [message!],
    });
    const round = parseConversationArchive(JSON.stringify(archive), SKIP_APP_VERSION_GATE);
    expect(round.archive?.conversations[0].messages[0]).toMatchObject({
      isError: true, pinned: true, condensed: true, isSummary: true,
    });
  });

  it('omits flags that are absent or falsy rather than storing them', () => {
    const m = normalizeMessage({ role: 'user', content: 'x', pinned: false }, 'i');
    expect(m).not.toHaveProperty('pinned');
    expect(m).not.toHaveProperty('isError');
  });

  it('carries unknown message fields through an older build untouched', () => {
    const m = normalizeMessage(
      { id: 'm', role: 'assistant', content: 'x', toolCalls: [{ name: 'f' }], futureFlag: 7 },
      'i'
    );
    expect(m?.extra).toEqual({ toolCalls: [{ name: 'f' }], futureFlag: 7 });
    const round = normalizeMessage(JSON.parse(JSON.stringify(m)), 'i');
    expect(round?.extra).toEqual({ toolCalls: [{ name: 'f' }], futureFlag: 7 });
  });

  it('carries unknown conversation fields through untouched', () => {
    const c = normalizeConversation({ id: 'c', folderId: 'work', starred: true }).conversation;
    expect(c?.extra).toEqual({ folderId: 'work', starred: true });
  });
});

describe('lossy-parse reporting', () => {
  const wrap = (conversations: unknown[]) =>
    JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: MIN_ROLLBACK_APP_VERSION,
      activeId: null,
      conversations,
    });

  it('reports a fully-specified archive as not lossy', () => {
    const r = parseConversationArchive(
      wrap([{ id: 'c', title: 't', createdAt: 1, updatedAt: 1, messages: [] }]),
      SKIP_APP_VERSION_GATE
    );
    expect(r.lossy).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('treats an omitted required field as a repair rather than a default', () => {
    // Silently defaulting a missing `updatedAt` hides that the stored record was incomplete.
    const missingUpdatedAt = parseConversationArchive(
      wrap([{ id: 'c', title: 't', createdAt: 1, messages: [] }]),
      SKIP_APP_VERSION_GATE
    );
    expect(missingUpdatedAt.lossy).toBe(true);

    const missingFloor = parseConversationArchive(
      JSON.stringify({
        version: CONVERSATION_SCHEMA_VERSION,
        activeId: null,
        conversations: [{ id: 'c', title: 't', createdAt: 1, updatedAt: 1, messages: [] }],
      }),
      SKIP_APP_VERSION_GATE
    );
    expect(missingFloor.lossy).toBe(true);
  });

  it('assumes the strictest known floor when the stored one is unreadable', () => {
    // A garbage floor must not read as "no floor" and authorize a destructive downgrade.
    const r = parseConversationArchive(
      JSON.stringify({
        version: CONVERSATION_SCHEMA_VERSION,
        minAppVersion: 'not-a-version',
        activeId: null,
        conversations: [],
      }),
      '0.5.0'
    );
    expect(r.incompatible).toBe(true);
    expect(r.reason).toContain(MIN_ROLLBACK_APP_VERSION);
  });

  it('refuses to guess when the running version is unusable', () => {
    const r = parseConversationArchive(wrap([]), 'nightly');
    expect(r.incompatible).toBe(true);
    expect(r.archive).toBeNull();
  });

  it('flags a repaired record as lossy even when nothing was dropped', () => {
    // A non-array `messages` is damage, not an empty conversation.
    const r = parseConversationArchive(wrap([{ id: 'c', messages: 'oops' }]), SKIP_APP_VERSION_GATE);
    expect(r.lossy).toBe(true);
    expect(r.droppedMessages).toBe(0);
    expect(r.reason).toBeTruthy();
  });

  it('flags unrecognized content parts as lossy without dropping them', () => {
    const r = parseConversationArchive(
      wrap([{ id: 'c', messages: [{ role: 'user', content: [{ type: 'audio', src: 'x' }] }] }]),
      SKIP_APP_VERSION_GATE
    );
    expect(r.unrecognizedParts).toBe(1);
    expect(r.lossy).toBe(true);
    expect(r.archive?.conversations[0].messages[0].content).toEqual([
      { type: OPAQUE_PART_TYPE, original: { type: 'audio', src: 'x' } },
    ]);
  });

  it('deduplicates conversation ids instead of accepting an ambiguous list', () => {
    const r = parseConversationArchive(wrap([{ id: 'dup' }, { id: 'dup' }]), SKIP_APP_VERSION_GATE);
    const ids = r.archive!.conversations.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(r.lossy).toBe(true);
  });

  it('deduplicates message ids within a conversation', () => {
    const r = parseConversationArchive(
      wrap([{ id: 'c', messages: [
        { id: 'm', role: 'user', content: 'a' },
        { id: 'm', role: 'assistant', content: 'b' },
      ] }]),
      SKIP_APP_VERSION_GATE
    );
    const ids = r.archive!.conversations[0].messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('resolves an id collision even when the obvious substitute is also taken', () => {
    // A single-suffix rename reintroduces the ambiguity it was meant to remove.
    const r = parseConversationArchive(
      wrap([{ id: 'dup' }, { id: 'dup-dup1' }, { id: 'dup' }]),
      SKIP_APP_VERSION_GATE
    );
    const ids = r.archive!.conversations.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('rollback and schema gating', () => {
  const at = (version: number, minAppVersion = MIN_ROLLBACK_APP_VERSION) =>
    JSON.stringify({ version, minAppVersion, activeId: null, conversations: [] });

  it('names a floor no older than the first build that implements v2', () => {
    // 0.5.0 shipped before this schema existed, so it must not be the declared floor.
    expect(compareVersions(MIN_ROLLBACK_APP_VERSION, '0.5.0')).toBe(1);
  });

  it('refuses an older schema instead of stamping it as current', () => {
    const r = parseConversationArchive(at(1), SKIP_APP_VERSION_GATE);
    expect(r.incompatible).toBe(true);
    expect(r.archive).toBeNull();
    expect(r.reason).toMatch(/migration/i);
  });

  it('refuses a negative or fractional version', () => {
    expect(parseConversationArchive(at(-1), SKIP_APP_VERSION_GATE).incompatible).toBe(true);
    expect(parseConversationArchive(at(1.5), SKIP_APP_VERSION_GATE).incompatible).toBe(true);
  });

  it('refuses to read an archive whose floor is above the running build', () => {
    const r = parseConversationArchive(at(CONVERSATION_SCHEMA_VERSION, '9.0.0'), '0.6.0');
    expect(r.incompatible).toBe(true);
    expect(r.reason).toContain('9.0.0');
  });

  it('reads it when the running build satisfies the floor', () => {
    const r = parseConversationArchive(at(CONVERSATION_SCHEMA_VERSION, '0.6.0'), '0.6.0');
    expect(r.incompatible).toBe(false);
    expect(r.archive).not.toBeNull();
  });

  it('skips the gate only via the explicitly-named opt-out', () => {
    const r = parseConversationArchive(at(CONVERSATION_SCHEMA_VERSION, '9.0.0'), SKIP_APP_VERSION_GATE);
    expect(r.archive).not.toBeNull();
  });

  it('recognises usable version strings only', () => {
    expect(isUsableVersion('0.6.0')).toBe(true);
    expect(isUsableVersion('1.2.3-beta.1')).toBe(true);
    expect(isUsableVersion('')).toBe(false);
    expect(isUsableVersion('nightly')).toBe(false);
    expect(isUsableVersion(undefined)).toBe(false);
  });

  it('explains every rejection', () => {
    expect(parseConversationArchive('{nope', SKIP_APP_VERSION_GATE).reason).toBeTruthy();
    expect(parseConversationArchive('[]', SKIP_APP_VERSION_GATE).reason).toBeTruthy();
    expect(parseConversationArchive(at(CONVERSATION_SCHEMA_VERSION + 1), SKIP_APP_VERSION_GATE).reason).toContain('newer');
  });
});

describe('migration idempotency and honesty', () => {
  const legacyIndex = [{ id: 'c1', title: 'First', createdAt: 100, messageCount: 4 }];
  const legacyMessages = [textMsg('user', 'thread'), textMsg('assistant', 'reply')];

  it('derives the recovered id from content, so a retry does not duplicate the thread', () => {
    const a = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 1 });
    const b = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 999999 });
    const idA = a.archive.conversations.find((c) => c.recovered)!.id;
    const idB = b.archive.conversations.find((c) => c.recovered)!.id;
    expect(idA).toBe(idB);
  });

  it('gives different legacy threads different recovered ids', () => {
    const other = [textMsg('user', 'a completely different chat')];
    expect(deriveRecoveredId(legacyMessages)).not.toBe(deriveRecoveredId(other));
  });

  it('never shadows a legacy conversation that already claims the recovered id', () => {
    const collidingId = deriveRecoveredId(legacyMessages);
    const r = migrateLegacyConversations({
      legacyIndex: [{ id: collidingId, title: 'Existing', createdAt: 1, messageCount: 0 }],
      legacyMessages,
      now: 1,
    });
    const ids = r.archive.conversations.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.archive.conversations.find((c) => c.id === collidingId)?.recovered).toBeUndefined();
  });

  it('keeps the exact count of turns it could not recover', () => {
    const r = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 1 });
    expect(r.archive.conversations.find((c) => c.id === 'c1')?.unavailableMessageCount).toBe(4);
  });

  it('distinguishes an empty legacy thread from one whose turns were all unreadable', () => {
    const empty = migrateLegacyConversations({ legacyIndex, legacyMessages: [], now: 1 });
    expect(empty.legacyThreadPresent).toBe(false);
    expect(empty.droppedLegacyMessages).toBe(0);

    const unreadable = migrateLegacyConversations({
      legacyIndex,
      legacyMessages: [{ role: 'tool', content: 'x' }, 'junk'],
      now: 1,
    });
    expect(unreadable.legacyThreadPresent).toBe(true);
    expect(unreadable.droppedLegacyMessages).toBe(2);
    expect(unreadable.recoveredThread).toBe(false);
  });

  it('reports legacy index entries it could not import', () => {
    const r = migrateLegacyConversations({
      legacyIndex: [{ id: 'c1', title: 'ok' }, { title: 'no id' }, null, { id: 'c1' }],
      legacyMessages: [],
      now: 1,
    });
    expect(r.droppedLegacyConversations).toBe(3);
    expect(r.importedConversations).toBe(1);
  });

  it('excludes the recovered thread from the imported count', () => {
    const r = migrateLegacyConversations({ legacyIndex, legacyMessages, now: 1 });
    expect(r.importedConversations).toBe(1);
    expect(r.archive.conversations).toHaveLength(2);
  });

  it('preserves message flags through migration', () => {
    const r = migrateLegacyConversations({
      legacyIndex: [],
      legacyMessages: [{ role: 'assistant', content: 'sum', isSummary: true, pinned: true }],
      now: 1,
    });
    expect(r.archive.conversations[0].messages[0]).toMatchObject({ isSummary: true, pinned: true });
  });
});

describe('legacy migration loss reporting', () => {
  it('distinguishes an absent thread from a malformed one', () => {
    const absent = migrateLegacyConversations({ now: 1_000, legacyIndex: [], legacyMessages: [] });
    expect(absent.legacyThreadPresent).toBe(false);
    expect(absent.legacyThreadMalformed).toBe(false);

    // A non-array payload means the thread existed and was damaged; reporting it as absent
    // would tell the user nothing was lost when in fact everything was.
    const damaged = migrateLegacyConversations({
      now: 1_000, legacyIndex: [],
      legacyMessages: 'corrupt' as unknown as unknown[],
    });
    expect(damaged.legacyThreadPresent).toBe(true);
    expect(damaged.legacyThreadMalformed).toBe(true);
  });

  it('reports a malformed index separately from an empty one', () => {
    const r = migrateLegacyConversations({
      now: 1_000,
      legacyIndex: { c1: {} } as unknown as unknown[],
      legacyMessages: [],
    });
    expect(r.legacyIndexMalformed).toBe(true);
    expect(r.importedConversations).toBe(0);
  });

  it('counts parts lost inside a legacy turn that was otherwise recovered', () => {
    const r = migrateLegacyConversations({
      now: 1_000, legacyIndex: [],
      legacyMessages: [
        { role: 'user', content: [{ type: 'text', text: 'kept' }, null, 42] },
      ] as unknown[],
    });
    expect(r.droppedLegacyParts).toBe(2);
    expect(r.archive.conversations[0].messages).toHaveLength(1);
  });

  it('keeps recovered legacy message ids unique', () => {
    const r = migrateLegacyConversations({
      now: 1_000, legacyIndex: [],
      legacyMessages: [
        { id: 'same', role: 'user', content: 'a' },
        { id: 'same', role: 'assistant', content: 'b' },
      ] as unknown[],
    });
    const ids = r.archive.conversations[0].messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('unreported repair hardening', () => {
  const wrapOne = (conversation: unknown) =>
    JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: MIN_ROLLBACK_APP_VERSION,
      activeId: null,
      conversations: [conversation],
    });
  const lossyOf = (conversation: unknown) =>
    parseConversationArchive(wrapOne(conversation), SKIP_APP_VERSION_GATE).lossy;

  it('flags a substituted message id even when the original was absent', () => {
    // The substitute is positional, so it shifts if a sibling is dropped; the caller can no
    // longer address the original turn either way.
    const r = normalizeMessageDetailed({ role: 'user', content: 'hi' }, 'fallback');
    expect(r.message?.id).toBe('fallback');
    expect(r.repaired).toBe(true);
  });

  it('flags an unusable message flag rather than dropping it silently', () => {
    // `pinned` is a known key so it cannot fall through to `extra`; `isError` and `pinned`
    // change what gets sent to the model, so losing one is behavioral corruption.
    const r = normalizeMessageDetailed({ id: 'm', role: 'user', content: 'hi', pinned: 'true' }, 'f');
    expect(r.message?.pinned).toBeUndefined();
    expect(r.repaired).toBe(true);

    const clean = normalizeMessageDetailed({ id: 'm', role: 'user', content: 'hi', pinned: false }, 'f');
    expect(clean.repaired).toBe(false);
  });

  it('flags a missing messages array as damage, not an empty conversation', () => {
    expect(lossyOf({ id: 'c', title: 't', createdAt: 1, updatedAt: 1 })).toBe(true);
  });

  it('flags an unusable conversation boolean', () => {
    expect(
      lossyOf({ id: 'c', title: 't', createdAt: 1, updatedAt: 1, messages: [], recovered: 'yes' })
    ).toBe(true);
    expect(
      lossyOf({ id: 'c', title: 't', createdAt: 1, updatedAt: 1, messages: [], recovered: false })
    ).toBe(false);
  });

  it('never honours a stored floor below the one this build guarantees', () => {
    // A floor of 0.1.0 would authorize a build that cannot read v2 at all.
    const r = parseConversationArchive(
      JSON.stringify({
        version: CONVERSATION_SCHEMA_VERSION,
        minAppVersion: '0.1.0',
        activeId: null,
        conversations: [],
      }),
      '0.5.0'
    );
    expect(r.incompatible).toBe(true);
    expect(r.reason).toContain(MIN_ROLLBACK_APP_VERSION);
  });
});

describe('legacy repair reporting', () => {
  it('reports repaired legacy index entries instead of guessing quietly', () => {
    const r = migrateLegacyConversations({
      now: 5_000,
      legacyIndex: [{ id: 'c1', createdAt: 'nope', messageCount: 'lots' }] as unknown[],
      legacyMessages: [],
    });
    expect(r.repairedLegacyEntries).toBe(1);
    expect(r.legacyLossy).toBe(true);
    // A bad count must not quietly become 0 and suppress the unavailable-turns notice.
    expect(r.archive.conversations[0].messagesUnavailable).toBeUndefined();
  });

  it('reports repaired and unrecognized legacy turns', () => {
    const r = migrateLegacyConversations({
      now: 5_000,
      legacyIndex: [],
      legacyMessages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'audio', src: 'x' }] },
      ] as unknown[],
    });
    // No id on the legacy turn, plus a part this build cannot model.
    expect(r.repairedLegacyMessages).toBe(1);
    expect(r.unrecognizedLegacyParts).toBe(1);
    expect(r.legacyLossy).toBe(true);
  });

  it('reports a wholly clean legacy payload as not lossy', () => {
    const r = migrateLegacyConversations({
      now: 5_000,
      legacyIndex: [{ id: 'c1', title: 'First', createdAt: 100, messageCount: 0 }],
      legacyMessages: [
        { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'yo', createdAt: 2 },
      ] as unknown[],
    });
    expect(r.legacyLossy).toBe(false);
  });
});

describe('header and legacy identity repairs are reported', () => {
  const withHeader = (extra: Record<string, unknown>) =>
    JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: MIN_ROLLBACK_APP_VERSION,
      activeId: null,
      conversations: [],
      ...extra,
    });

  it('reports a raised floor as lossy even when the running build satisfies it', () => {
    // The floor gets rewritten on the next save, so the read was not clean. A build new enough
    // to pass the gate would otherwise never learn the stored header was wrong.
    const r = parseConversationArchive(withHeader({ minAppVersion: '0.1.0' }), '9.0.0');
    expect(r.incompatible).toBe(false);
    expect(r.lossy).toBe(true);
  });

  it('reports an absent activeId as a repair', () => {
    const missing = JSON.stringify({
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: MIN_ROLLBACK_APP_VERSION,
      conversations: [],
    });
    expect(parseConversationArchive(missing, SKIP_APP_VERSION_GATE).lossy).toBe(true);
    // An explicit null is a real "nothing selected" and must stay clean.
    expect(parseConversationArchive(withHeader({}), SKIP_APP_VERSION_GATE).lossy).toBe(false);
  });

  it('counts a renamed duplicate legacy message id as a repair', () => {
    const r = migrateLegacyConversations({
      now: 5_000,
      legacyIndex: [],
      legacyMessages: [
        { id: 'same', role: 'user', content: 'a', createdAt: 1 },
        { id: 'same', role: 'assistant', content: 'b', createdAt: 2 },
      ] as unknown[],
    });
    const ids = r.archive.conversations[0].messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
    expect(r.repairedLegacyMessages).toBe(1);
    expect(r.legacyLossy).toBe(true);
  });

  it('rejects a legacy message count that is not a non-negative integer', () => {
    for (const messageCount of [undefined, -3, 2.5]) {
      const r = migrateLegacyConversations({
        now: 5_000,
        legacyIndex: [{ id: 'c1', title: 'First', createdAt: 100, messageCount }] as unknown[],
        legacyMessages: [],
      });
      expect(r.repairedLegacyEntries).toBe(1);
      // A substituted zero must never be presented as verified evidence of lost turns.
      expect(r.archive.conversations[0].messagesUnavailable).toBeUndefined();
      expect(r.archive.conversations[0].unavailableMessageCount).toBeUndefined();
    }
  });
});
