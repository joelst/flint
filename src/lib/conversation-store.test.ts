import { describe, it, expect } from 'vitest';
import { applyConversationTitle } from './conversation-title';

/** Mirrors the schema's own known-key list; kept local so the test states its assumption. */
const KNOWN_CONVERSATION_KEYS_FOR_TEST = new Set([
  'id', 'title', 'createdAt', 'updatedAt', 'messages', 'settings', 'titlePinned',
  'recovered', 'messagesUnavailable', 'unavailableMessageCount', 'extra',
]);
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
  meetsArchiveFloor,
  normalizeContent,
  contentToText,
  normalizeMessage,
  normalizeConversation,
  parseConversationArchive,
  deriveConversationTitle,
  KNOWN_MESSAGE_ROLES,
  isKnownRole,
  isPromptRole,
  readConversationSettings,
  mergeConversationSettings,
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

  it('rejects a message with no usable role', () => {
    // An unrecognized-but-present role is kept (see "message roles" below); only a role that
    // is not a usable string at all makes the message unstorable.
    expect(normalizeMessage({ role: '', content: 'x' }, 'x')).toBeNull();
    expect(normalizeMessage({ content: 'x' }, 'x')).toBeNull();
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
      messages: [textMsg('user', 'keep'), { role: 'user', content: { a: 1 } }],
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
    // `undefined`, not `null`, is what the reader produces for a key that was never written.
    const r = migrateLegacyConversations({ legacyIndex: null, legacyMessages: undefined, now: 1 });
    expect(r.archive.conversations).toHaveLength(0);
    expect(r.archive.activeId).toBeNull();
    expect(r.archive.version).toBe(CONVERSATION_SCHEMA_VERSION);
    expect(r.legacyThreadMalformed).toBe(false);
    expect(r.legacyLossy).toBe(false);
  });

  it('reports a stored null thread as damage rather than as absence', () => {
    // `{"chatMessages": null}` is a value that was written, not a key that is missing. Reading
    // it as absence would report a clean empty start and clear the retirement gate, deleting
    // the very source that could not be read.
    const r = migrateLegacyConversations({ legacyIndex: null, legacyMessages: null, now: 1 });
    expect(r.legacyThreadMalformed).toBe(true);
    expect(r.legacyThreadPresent).toBe(true);
    expect(r.legacyLossy).toBe(true);
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
      legacyMessages: [{ role: 'user', content: { a: 1 } }, 'junk'],
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

describe('message roles', () => {
  it('recognizes the roles this build understands', () => {
    expect([...KNOWN_MESSAGE_ROLES]).toEqual(['system', 'user', 'assistant', 'tool']);
    for (const role of KNOWN_MESSAGE_ROLES) expect(isKnownRole(role)).toBe(true);
  });

  it('does not treat an unknown or malformed role as known', () => {
    for (const role of ['function', 'developer', '', ' user ', null, 7, undefined]) {
      expect(isKnownRole(role)).toBe(false);
    }
  });

  it('only allows system/user/assistant into a prompt', () => {
    expect(isPromptRole('system')).toBe(true);
    expect(isPromptRole('user')).toBe(true);
    expect(isPromptRole('assistant')).toBe(true);
    // A faithful tool turn needs a tool_call_id this schema does not model, so replaying it
    // would send a structurally invalid request.
    expect(isPromptRole('tool')).toBe(false);
    expect(isPromptRole('function')).toBe(false);
  });

  it('keeps a tool message instead of dropping it', () => {
    const r = normalizeMessageDetailed({ id: 'm1', role: 'tool', content: '{"ok":true}' }, 'fb');
    expect(r.message).toEqual({ id: 'm1', role: 'tool', content: '{"ok":true}' });
    expect(r.repaired).toBe(false);
  });

  it('preserves a role from a newer build verbatim and without flagging a repair', () => {
    // Flagging this as a repair would make any archive containing such a message permanently
    // unsaveable, which is the same trap unrecognized parts avoid.
    const r = normalizeMessageDetailed({ id: 'm1', role: 'developer', content: 'hi' }, 'fb');
    expect(r.message?.role).toBe('developer');
    expect(r.repaired).toBe(false);
  });

  it('round-trips an unknown role through a full archive', () => {
    const archive = {
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion: MIN_ROLLBACK_APP_VERSION,
      activeId: 'c1',
      conversations: [{
        id: 'c1', title: 'T', createdAt: 1, updatedAt: 2,
        messages: [{ id: 'm1', role: 'developer', content: 'hi' }],
      }],
    };
    const parsed = parseConversationArchive(JSON.stringify(archive), SKIP_APP_VERSION_GATE);
    expect(parsed.archive?.conversations[0].messages[0].role).toBe('developer');
    expect(parsed.droppedMessages).toBe(0);
    expect(parsed.repaired).toBe(false);
  });

  it('still drops a message whose role is not a usable string', () => {
    for (const role of [undefined, null, '', '   ', 5, {}, ['user']]) {
      expect(normalizeMessageDetailed({ id: 'm', role, content: 'x' }, 'fb').message).toBeNull();
    }
  });

  it('derives a title only from the user role, ignoring lookalikes', () => {
    expect(deriveConversationTitle([
      { id: 'a', role: 'tool', content: 'tool output' },
      { id: 'b', role: 'user', content: 'the real question' },
    ])).toBe('the real question');
  });
});

describe('readConversationSettings', () => {
  it('reads every known key', () => {
    const r = readConversationSettings({
      modelAlias: 'qwen3-0.6b',
      systemPrompt: 'Be brief',
      contextTurns: 6,
      showFullHistory: true,
    });
    expect(r.settings).toEqual({
      modelAlias: 'qwen3-0.6b', systemPrompt: 'Be brief', contextTurns: 6, showFullHistory: true,
    });
    expect(r.passthrough).toEqual({});
    expect(r.invalidKeys).toEqual([]);
  });

  it('preserves keys this build does not interpret', () => {
    const r = readConversationSettings({ modelAlias: 'a', reasoningEffort: 'high', tools: [1] });
    expect(r.settings).toEqual({ modelAlias: 'a' });
    expect(r.passthrough).toEqual({ reasoningEffort: 'high', tools: [1] });
  });

  it('ignores rather than coerces a known key of the wrong type', () => {
    // Coercion here would silently change model behaviour; "3" turns as a string is not 3.
    const r = readConversationSettings({ contextTurns: '3', showFullHistory: 'yes', modelAlias: 9 });
    expect(r.settings).toEqual({});
    expect(r.invalidKeys.sort()).toEqual(['contextTurns', 'modelAlias', 'showFullHistory']);
  });

  it('rejects a contextTurns the app would refuse to apply', () => {
    // The app restores `contextTurns` only when it is `> 0` and the picker offers whole turns,
    // so accepting 0, a negative, or a fraction here would put a value in the archive that is
    // reported as a setting and then never used.
    for (const contextTurns of [NaN, Infinity, -Infinity, 0, -1, -0.5, 2.5, 12.0001]) {
      expect(readConversationSettings({ contextTurns }).invalidKeys).toEqual(['contextTurns']);
    }
  });

  it('accepts the whole-number turn counts the app offers', () => {
    for (const contextTurns of [1, 4, 8, 12, 20, 30, 100]) {
      const r = readConversationSettings({ contextTurns });
      expect(r.settings.contextTurns).toBe(contextTurns);
      expect(r.invalidKeys).toEqual([]);
    }
  });

  it('keeps a rejected contextTurns in the stored bag', () => {
    // `readConversationSettings` is a typed view, not a rewrite: refusing to present a value
    // must not delete it, or a downgrade would lose a setting this build merely disagreed with.
    const { conversation } = normalizeConversation({
      id: 'c1',
      title: 't',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      settings: { contextTurns: 0, modelAlias: 'phi' },
    });
    expect(conversation?.settings).toEqual({ contextTurns: 0, modelAlias: 'phi' });
  });

  it('accepts a false showFullHistory as a real value', () => {
    // `false` is a stored choice, not an absence; treating it as absent would re-apply a
    // default of `true` on every read.
    expect(readConversationSettings({ showFullHistory: false }).settings).toEqual({ showFullHistory: false });
  });

  it('returns empty results for a missing or non-object bag', () => {
    for (const raw of [undefined, null, 'x', 7, ['a'], true]) {
      const r = readConversationSettings(raw);
      expect(r).toEqual({ settings: {}, passthrough: {}, invalidKeys: [] });
    }
  });
});

describe('mergeConversationSettings', () => {
  it('creates a bag from nothing', () => {
    expect(mergeConversationSettings(undefined, { modelAlias: 'a' })).toEqual({ modelAlias: 'a' });
  });

  it('preserves unknown keys through a patch', () => {
    const merged = mergeConversationSettings(
      { reasoningEffort: 'high', modelAlias: 'old' },
      { modelAlias: 'new' },
    );
    expect(merged).toEqual({ reasoningEffort: 'high', modelAlias: 'new' });
  });

  it('leaves known keys the patch omits alone', () => {
    const merged = mergeConversationSettings({ modelAlias: 'a', contextTurns: 4 }, { contextTurns: 9 });
    expect(merged).toEqual({ modelAlias: 'a', contextTurns: 9 });
  });

  it('an explicit undefined clears a key', () => {
    const merged = mergeConversationSettings({ modelAlias: 'a', contextTurns: 4 }, { modelAlias: undefined });
    expect(merged).toEqual({ contextTurns: 4 });
  });

  it('returns undefined rather than storing an empty bag', () => {
    expect(mergeConversationSettings(undefined, {})).toBeUndefined();
    expect(mergeConversationSettings({ modelAlias: 'a' }, { modelAlias: undefined })).toBeUndefined();
  });

  it('does not mutate the prior bag', () => {
    const prior = { modelAlias: 'a' };
    mergeConversationSettings(prior, { modelAlias: 'b' });
    expect(prior).toEqual({ modelAlias: 'a' });
  });

  it('ignores a non-object prior rather than throwing', () => {
    expect(mergeConversationSettings(['x'] as any, { modelAlias: 'a' })).toEqual({ modelAlias: 'a' });
  });

  it('writes a false value rather than treating it as a clear', () => {
    expect(mergeConversationSettings(undefined, { showFullHistory: false })).toEqual({ showFullHistory: false });
  });

  it('round-trips through the reader', () => {
    const bag = mergeConversationSettings({ custom: 1 }, { modelAlias: 'm', contextTurns: 3 });
    const read = readConversationSettings(bag);
    expect(read.settings).toEqual({ modelAlias: 'm', contextTurns: 3 });
    expect(read.passthrough).toEqual({ custom: 1 });
  });
});

describe('titlePinned', () => {
  it('survives a normalize round-trip', () => {
    const c = normalizeConversation({
      id: 'c1', title: 'Mine', createdAt: 1, updatedAt: 2, messages: [], titlePinned: true,
    });
    expect(c.conversation?.titlePinned).toBe(true);
    expect(c.repaired).toBe(false);
  });

  it('is absent rather than false when not set', () => {
    const c = normalizeConversation({ id: 'c1', title: 'T', createdAt: 1, updatedAt: 2, messages: [] });
    expect(c.conversation?.titlePinned).toBeUndefined();
    expect(c.repaired).toBe(false);
  });

  it('flags a repair when the stored value is not a boolean', () => {
    const c = normalizeConversation({
      id: 'c1', title: 'T', createdAt: 1, updatedAt: 2, messages: [], titlePinned: 'yes',
    });
    expect(c.repaired).toBe(true);
  });

  it('does not leak into extra', () => {
    const c = normalizeConversation({
      id: 'c1', title: 'T', createdAt: 1, updatedAt: 2, messages: [], titlePinned: true,
    });
    expect(c.conversation?.extra).toBeUndefined();
  });
});

describe('extra survives a new -> old -> new round trip', () => {
  // The `extra` bag makes a *downgrade* non-destructive. These cover the other half: the build
  // that owns the field again must recover it, or the field is lost on the way back up —
  // silently, with no repair flag, because by then it looks like an ordinary absent field.

  it('promotes a conversation field an older build parked in extra', () => {
    const c = normalizeConversation({
      id: 'c1', title: 'Mine', createdAt: 1, updatedAt: 2, messages: [],
      extra: { titlePinned: true },
    });
    expect(c.conversation?.titlePinned).toBe(true);
    // The value is represented at the top level now, so keeping a duplicate in `extra` would
    // let the two disagree after the next edit.
    expect(c.conversation?.extra).toBeUndefined();
    expect(c.repaired).toBe(false);
  });

  it('lets a top-level value win over a stale copy in extra', () => {
    const c = normalizeConversation({
      id: 'c1', title: 'T', createdAt: 1, updatedAt: 2, messages: [],
      recovered: true, extra: { recovered: false },
    });
    expect(c.conversation?.recovered).toBe(true);
    expect(c.repaired).toBe(false);
  });

  it('flags a repair when the promoted value is unusable', () => {
    const c = normalizeConversation({
      id: 'c1', title: 'T', createdAt: 1, updatedAt: 2, messages: [],
      extra: { titlePinned: 'yes' },
    });
    expect(c.repaired).toBe(true);
  });

  it('promotes a message field an older build parked in extra', () => {
    const r = normalizeMessageDetailed(
      { id: 'm1', role: 'user', content: 'hi', extra: { pinned: true } },
      'fb',
    );
    expect(r.message?.pinned).toBe(true);
    expect(r.message?.extra).toBeUndefined();
    expect(r.repaired).toBe(false);
  });

  it('keeps genuinely unknown keys in extra while promoting known ones', () => {
    const c = normalizeConversation({
      id: 'c1', title: 'T', createdAt: 1, updatedAt: 2, messages: [],
      extra: { titlePinned: true, fromTheFuture: 42 },
    });
    expect(c.conversation?.titlePinned).toBe(true);
    expect(c.conversation?.extra).toEqual({ fromTheFuture: 42 });
  });

  it('survives the full downgrade and re-upgrade of a pinned title', () => {
    // Simulates the real sequence: a new build writes `titlePinned`, an old build that has
    // never heard of it reads and rewrites the archive, then a new build reads it again.
    const asStored = {
      id: 'c1', title: 'Budget notes', createdAt: 1, updatedAt: 2, titlePinned: true,
      messages: [{ id: 'm1', role: 'user', content: 'unrelated text' }],
    };
    const oldBuildKnownKeys = new Set(
      [...KNOWN_CONVERSATION_KEYS_FOR_TEST].filter((k) => k !== 'titlePinned'),
    );
    const parked: Record<string, unknown> = { extra: {} as Record<string, unknown> };
    for (const [k, v] of Object.entries(asStored)) {
      if (oldBuildKnownKeys.has(k)) parked[k] = v;
      else (parked.extra as Record<string, unknown>)[k] = v;
    }
    const back = normalizeConversation(parked);
    expect(back.conversation?.titlePinned).toBe(true);
    expect(applyConversationTitle(back.conversation!).title).toBe('Budget notes');
  });
});

describe('keys that collide with Object.prototype', () => {
  // `JSON.parse` produces `__proto__` as an ordinary own property, so a stored archive can
  // reach this. Plain assignment would route it to the inherited setter: neither stored nor
  // reported, which is the one silent loss the `extra` mechanism exists to prevent.
  const evil = () => JSON.parse('{"__proto__": "kept", "constructor": "also kept"}');

  it('preserves them in a message extra bag', () => {
    const r = normalizeMessageDetailed({ id: 'm', role: 'user', content: 'x', ...evil() }, 'fb');
    expect(Object.getOwnPropertyDescriptor(r.message?.extra ?? {}, '__proto__')?.value).toBe('kept');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('preserves them in a conversation extra bag', () => {
    const c = normalizeConversation({
      id: 'c1', title: 'T', createdAt: 1, updatedAt: 2, messages: [], ...evil(),
    });
    expect(Object.getOwnPropertyDescriptor(c.conversation?.extra ?? {}, '__proto__')?.value).toBe('kept');
  });

  it('preserves them in a settings passthrough bag', () => {
    const r = readConversationSettings({ modelAlias: 'a', ...evil() });
    expect(Object.getOwnPropertyDescriptor(r.passthrough, '__proto__')?.value).toBe('kept');
    expect(r.passthrough.constructor).toBe('also kept');
  });

  it('round-trips them through JSON, which is the only thing that matters downstream', () => {
    const r = readConversationSettings(evil());
    expect(JSON.parse(JSON.stringify(r.passthrough))).toEqual(evil());
  });

  it('does not pollute Object.prototype', () => {
    normalizeConversation({ id: 'c', title: '', createdAt: 1, updatedAt: 1, messages: [], ...evil() });
    expect(Object.prototype.hasOwnProperty.call({}, '__proto__')).toBe(false);
    expect(({} as any).kept).toBeUndefined();
  });
});

describe('the running build can always reopen what it writes', () => {
  it('ships an app version at or above the archive rollback floor', async () => {
    // `saveConversationArchive` stamps MIN_ROLLBACK_APP_VERSION into every archive, and
    // `parseConversationArchive` refuses an archive whose floor is above the running build. If
    // the floor ever exceeds the shipped version, the app writes an archive on first launch and
    // then rejects it on the next one: no conversations, writes disabled, for every user.
    const pkg = await import('../../package.json');
    const appVersion = String((pkg as any).default?.version ?? (pkg as any).version);
    expect(isUsableVersion(appVersion)).toBe(true);
    // Uses the same predicate as the gate, so a pre-release tag such as 0.6.0-rc.1 is judged
    // exactly as the running app would judge it rather than failing on semver precedence.
    expect(meetsArchiveFloor(appVersion, MIN_ROLLBACK_APP_VERSION)).toBe(true);
  });

  it('accepts an archive stamped with its own floor', () => {
    const archive = createEmptyArchive('c1');
    const parsed = parseConversationArchive(JSON.stringify(archive), MIN_ROLLBACK_APP_VERSION);
    expect(parsed.archive).not.toBeNull();
    expect(parsed.incompatible).toBe(false);
  });
});

describe('meetsArchiveFloor treats a pre-release as its release', () => {
  it('accepts a release candidate of the floor version', () => {
    // Semver orders 0.6.0-rc.1 below 0.6.0. Applying that to the capability gate would make
    // every pre-release build refuse the archives it had just written, and the release workflow
    // stamps the app version straight from the git tag — so a `-rc` tag would ship that.
    expect(meetsArchiveFloor('0.6.0-rc.1', '0.6.0')).toBe(true);
    expect(meetsArchiveFloor('0.6.0-alpha', '0.6.0')).toBe(true);
  });

  it('still rejects a genuinely older build', () => {
    expect(meetsArchiveFloor('0.5.9', '0.6.0')).toBe(false);
    expect(meetsArchiveFloor('0.5.0', '0.6.0')).toBe(false);
    expect(meetsArchiveFloor('0.5.9-rc.1', '0.6.0')).toBe(false);
  });

  it('accepts newer builds', () => {
    expect(meetsArchiveFloor('0.6.1', '0.6.0')).toBe(true);
    expect(meetsArchiveFloor('1.0.0', '0.6.0')).toBe(true);
  });

  it('lets a pre-release build open an archive stamped with the floor', () => {
    const parsed = parseConversationArchive(JSON.stringify(createEmptyArchive('c1')), '0.6.0-rc.1');
    expect(parsed.incompatible).toBe(false);
    expect(parsed.archive).not.toBeNull();
  });
})
