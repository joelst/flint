/**
 * Versioned conversation archive: schema, validation, and legacy migration.
 *
 * Pure by design — no `localStorage`, no IndexedDB, no Svelte. Storage I/O lives in the
 * repository; everything that decides *what is safe to keep* lives here so it can be tested
 * directly. Flint's pre-v2 layout stored a sidebar index of titles under one key and a single
 * global message thread under another, so switching conversations silently discarded history.
 * Migrating that shape correctly is the whole reason this module exists.
 */

/** Bump only for a change that older builds cannot read. */
export const CONVERSATION_SCHEMA_VERSION = 2;

/**
 * Oldest Flint release that can read this schema.
 *
 * This is the first build that ships the v2 repository, **not** the current package version:
 * every already-distributed 0.5.0 build predates v2 and cannot read this archive, so naming
 * 0.5.0 as the floor would authorize a downgrade that silently drops every conversation.
 *
 * A build older than an archive's `minAppVersion` must refuse to write rather than "repair"
 * it — that refusal is the entire rollback guarantee.
 */
export const MIN_ROLLBACK_APP_VERSION = '0.6.0';

/** Schema versions this build knows how to read. Anything else needs an explicit migration. */
const READABLE_SCHEMA_VERSIONS = new Set([CONVERSATION_SCHEMA_VERSION]);

/**
 * Explicit opt-out of the rollback gate, for tests and tooling that parse without a running
 * app. Named rather than optional so a bypass is always visible at the call site.
 */
export const SKIP_APP_VERSION_GATE = '__skip_app_version_gate__';

/** A version string usable for ordering: at least one numeric component. */
export function isUsableVersion(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  return /^\d+(\.\d+)*(-.+)?$/.test(value.trim());
}

/**
 * Roles this build understands well enough to render and to send to a model.
 *
 * `tool` is listed because tool-calling models emit it, but it is deliberately *not* a prompt
 * role: a faithful tool turn also carries `tool_call_id`, which this schema does not model.
 * Listing it keeps such a turn readable and round-trippable; `isPromptRole` keeps it out of
 * requests until the tool-call fields are modelled properly.
 */
export const KNOWN_MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;

export type KnownMessageRole = (typeof KNOWN_MESSAGE_ROLES)[number];

/**
 * Any non-empty role string, not just the ones above.
 *
 * A closed union here would mean a newer build's roles are unreadable by an older one, and the
 * old behaviour on an unreadable role was to drop the entire message — losing its content to
 * protect a type. Preserving the role verbatim costs nothing and keeps a downgrade
 * non-destructive; `isKnownRole` is how callers decide what to do with one they do not know.
 */
export type MessageRole = KnownMessageRole | (string & {});

const KNOWN_ROLE_SET: ReadonlySet<string> = new Set<string>(KNOWN_MESSAGE_ROLES);

/** True when this build can render and reason about the role. */
export function isKnownRole(role: unknown): role is KnownMessageRole {
  return typeof role === 'string' && KNOWN_ROLE_SET.has(role);
}

/**
 * True when a message with this role may be sent to a model as-is.
 *
 * Unknown roles are excluded because their meaning is unknown by definition, and `tool` because
 * this schema cannot reproduce the call linkage a tool turn requires.
 */
export function isPromptRole(role: unknown): role is 'system' | 'user' | 'assistant' {
  return role === 'system' || role === 'user' || role === 'assistant';
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}

/**
 * A part this schema version does not model, kept verbatim at its original position.
 *
 * It is deliberately *not* a `TextPart | ImagePart`: an older build must preserve a newer
 * build's part without ever handing it to the renderer or the inference request builder, which
 * only understand text and images. Consumers must call `supportedParts()` first.
 */
export interface OpaquePart {
  type: 'x-flint-unknown';
  /** The original part exactly as stored. */
  original: unknown;
}

export type SupportedPart = TextPart | ImagePart;
export type ContentPart = SupportedPart | OpaquePart;

export const OPAQUE_PART_TYPE = 'x-flint-unknown';

export function isOpaquePart(part: unknown): part is OpaquePart {
  return !!part && typeof part === 'object' && (part as any).type === OPAQUE_PART_TYPE;
}

/**
 * The parts a consumer may render or send for inference.
 *
 * Never pass raw stored content to either: an unknown part would reach the model as garbage or
 * break rendering. Opaque parts survive on disk precisely because they are filtered here.
 */
export function supportedParts(content: MessageContent): SupportedPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.filter((p): p is SupportedPart => !isOpaquePart(p));
}

/** A plain string or the multipart form vision turns use. Both must survive a round trip. */
export type MessageContent = string | ContentPart[];

/**
 * Message flags the app's own logic depends on.
 *
 * These are not cosmetic. `isError` keeps a failed turn out of the next inference request,
 * `pinned` exempts a turn from condensation, `condensed` hides it from the compact thread, and
 * `isSummary` marks the generated summary that replaced the turns it condensed. Dropping any of
 * them on the first save is functional corruption: error turns re-enter inference, pinned turns
 * stop being retained, and condensed turns reappear.
 */
export interface MessageFlags {
  isError?: boolean;
  pinned?: boolean;
  condensed?: boolean;
  isSummary?: boolean;
}

export const MESSAGE_FLAG_KEYS = ['isError', 'pinned', 'condensed', 'isSummary'] as const;

/** Fields this schema owns. Anything else on a message goes to `extra`. */
const KNOWN_MESSAGE_KEYS = new Set<string>([
  'id',
  'role',
  'content',
  'createdAt',
  'extra',
  ...MESSAGE_FLAG_KEYS,
]);

export interface StoredMessage extends MessageFlags {
  id: string;
  role: MessageRole;
  content: MessageContent;
  createdAt?: number;
  /**
   * Fields this schema version does not interpret, carried through untouched.
   *
   * Without this, a newer build's per-message data is destroyed the moment an older build
   * saves. Round-tripping unknown keys is what makes a downgrade non-destructive.
   */
  extra?: Record<string, unknown>;
}

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
  /**
   * Conversation-scoped settings (model alias, persona, sampling).
   *
   * Deliberately an opaque bag rather than a typed object: narrowing it at the storage boundary
   * would drop any key this build does not know, which is exactly how a downgrade destroys a
   * newer build's settings. `readConversationSettings` / `mergeConversationSettings` provide the
   * typed contract over it without ever discarding a key.
   */
  settings?: Record<string, unknown>;
  /**
   * True when the title was chosen by a human rather than derived from the first turn.
   *
   * Without this, every save re-derives the title and silently overwrites a deliberate name.
   */
  titlePinned?: boolean;
  /**
   * True for a thread imported from the pre-v2 global history, which had no provable owner
   * in the sidebar index. The UI must label it rather than claim it belongs to a title.
   */
  recovered?: boolean;
  /**
   * True when the legacy index said this conversation had messages but none were recoverable.
   * The title survived; the turns never existed on disk. Never present this as recovery.
   */
  messagesUnavailable?: boolean;
  /**
   * How many turns the legacy index claimed this conversation had. The exact count is one of
   * the few facts that survived the old layout, so it is kept rather than reduced to a boolean.
   */
  unavailableMessageCount?: number;
  /** Conversation-level fields this schema version does not interpret. See StoredMessage.extra. */
  extra?: Record<string, unknown>;
}

const KNOWN_CONVERSATION_KEYS = new Set<string>([
  'id', 'title', 'createdAt', 'updatedAt', 'messages', 'settings', 'titlePinned',
  'recovered', 'messagesUnavailable', 'unavailableMessageCount', 'extra',
]);

/**
 * Per-conversation settings this build understands.
 *
 * Every field is optional and absence is meaningful: it means "inherit the app default", which
 * is not the same as a stored value that happens to equal the default. Writing defaults in
 * eagerly would freeze today's defaults into every conversation ever saved.
 */
export interface ConversationSettings {
  /** Model this conversation was held with. */
  modelAlias?: string;
  /** Persona / system prompt in force for this conversation. */
  systemPrompt?: string;
  /** How many prior turns to include when building a request. */
  contextTurns?: number;
  /** Whether the UI shows the full thread rather than the condensed one. */
  showFullHistory?: boolean;
}

/** Keys `ConversationSettings` owns. Anything else is passthrough. */
export const CONVERSATION_SETTING_KEYS = [
  'modelAlias', 'systemPrompt', 'contextTurns', 'showFullHistory',
] as const;

export interface ConversationSettingsRead {
  /** Known keys that held a usable value. */
  settings: ConversationSettings;
  /**
   * Keys this build does not interpret, preserved verbatim so a downgrade cannot delete them.
   */
  passthrough: Record<string, unknown>;
  /**
   * Known keys whose stored value was the wrong type. They are ignored rather than coerced —
   * a coerced setting is a silent behaviour change — but they are still reported, and
   * `mergeConversationSettings` still round-trips them.
   */
  invalidKeys: string[];
}

/** Read the typed view of a settings bag without discarding anything it does not recognize. */
export function readConversationSettings(raw: unknown): ConversationSettingsRead {
  const settings: ConversationSettings = {};
  const passthrough: Record<string, unknown> = {};
  const invalidKeys: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings, passthrough, invalidKeys };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (key) {
      case 'modelAlias':
      case 'systemPrompt':
        if (typeof value === 'string') settings[key] = value;
        else invalidKeys.push(key);
        break;
      case 'contextTurns':
        // Must match what the app will actually accept, which is a positive whole number of
        // turns (`+page.svelte` restores it only when `> 0`, and the picker offers 4/8/12/20/30).
        // Storing 0, a negative, or a fraction would put a value in the archive that the app
        // silently refuses to apply, so the conversation would keep reporting a context window
        // it never uses. Rejecting it here reports it through `invalidKeys` instead of
        // presenting it as usable; the stored bag is kept verbatim by `normalizeConversation`,
        // so this is a view-level judgement and the original value is not discarded.
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
          settings.contextTurns = value;
        } else invalidKeys.push(key);
        break;
      case 'showFullHistory':
        if (typeof value === 'boolean') settings.showFullHistory = value;
        else invalidKeys.push(key);
        break;
      default:
        // `key` is arbitrary stored input, so it cannot be assigned directly.
        setOwn(passthrough, key, value);
    }
  }
  return { settings, passthrough, invalidKeys };
}

/**
 * Apply a typed patch to a stored settings bag.
 *
 * `prior` is merged rather than replaced so unknown keys — and known keys the patch does not
 * mention — survive. An explicit `undefined` in the patch clears that key; a key the patch
 * omits entirely is left alone, which is what makes a partial update safe.
 *
 * Returns `undefined` when nothing would be stored, so an empty bag is never written.
 */
export function mergeConversationSettings(
  prior: Record<string, unknown> | undefined,
  patch: ConversationSettings,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> =
    prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior } : {};
  for (const key of CONVERSATION_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export interface ConversationArchive {
  version: number;
  minAppVersion: string;
  activeId: string | null;
  conversations: StoredConversation[];
}

export interface ArchiveParseResult {
  /** Usable archive, or null when there is nothing safe to restore. */
  archive: ConversationArchive | null;
  /** A stored value existed but could not be used. Preserve the raw bytes before writing. */
  corrupt: boolean;
  /**
   * The archive was written by a newer Flint. It is intact and must be left exactly as it is:
   * writing our older shape over it is how a downgrade destroys the newer install's data.
   */
  incompatible: boolean;
  /** Entries dropped during validation, so the caller can report a partial restore honestly. */
  droppedConversations: number;
  droppedMessages: number;
  /** Content parts that could not be recovered at all. */
  droppedParts: number;
  /** Content parts kept but not understood by this build. */
  unrecognizedParts: number;
  /**
   * True when a stored field had to be substituted or rebuilt. Distinct from
   * `unrecognizedParts`, which is data we deliberately preserved: a repair means the record we
   * read back is not the record that was written.
   */
  repaired: boolean;
  /**
   * True when anything at all was dropped, repaired, or not understood. The repository must
   * back the original bytes up before its first write whenever this is set — otherwise the
   * reduced form silently replaces data we could not represent.
   */
  lossy: boolean;
  /** Why the archive was rejected, for an actionable message rather than a generic failure. */
  reason: string | null;
}

/**
 * A role is usable when it is a non-empty string, whether or not this build knows it.
 *
 * The check is deliberately not `isKnownRole`: rejecting an unrecognized role would discard the
 * message body along with it, which is the one outcome this schema exists to prevent.
 */
function isStorableRole(role: unknown): role is MessageRole {
  return typeof role === 'string' && role.trim().length > 0;
}

/**
 * Allocate an id that is definitely unused.
 *
 * Appending a single suffix is not enough: ids `x`, `x-dup1`, `x` would rename the third to an
 * id that already exists. Loop until the candidate is genuinely free.
 */
function allocateUniqueId(preferred: string, taken: Set<string>): string {
  if (!taken.has(preferred)) return preferred;
  let n = 1;
  let candidate = `${preferred}-dup${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${preferred}-dup${n}`;
  }
  return candidate;
}

/**
 * Compare dotted versions for a compatibility gate.
 *
 * A pre-release sorts *below* its release (0.6.0-rc < 0.6.0), because a release candidate must
 * not be trusted to satisfy a floor its final build defines. Callers should validate with
 * `isUsableVersion()`; any non-numeric core component is treated as 0 for ordering.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, ...rest] = String(v ?? '').trim().split('-');
    const nums = core
      .split('.')
      .map((n) => (/^\d+$/.test(n) ? Number.parseInt(n, 10) : 0));
    const tag = rest.join('-');
    return { nums, prerelease: tag === '' ? null : tag.split('.') };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i += 1) {
    const d = (pa.nums[i] || 0) - (pb.nums[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  // SemVer 11: compare prerelease identifiers pairwise. Collapsing them to a single
  // "has prerelease" bit makes 0.6.0-rc.1 and 0.6.0-rc.2 compare equal, which would let an
  // rc.1 build write over an archive that requires rc.2.
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    // A shorter set of identifiers has lower precedence when all preceding ones are equal.
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) {
      const d = Number.parseInt(ia, 10) - Number.parseInt(ib, 10);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (na !== nb) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return na ? -1 : 1;
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Reduce content to the parts we can store and re-render.
 *
 * Multipart content is preserved as multipart even when it holds a single text part: collapsing
 * it to a string loses the shape the vision request builder expects, and stringifying an array
 * is what produced `[object Object]` titles before.
 */
export interface ContentNormalization {
  content: MessageContent | null;
  /** Parts that were discarded because nothing usable could be recovered from them. */
  droppedParts: number;
  /**
   * Parts kept verbatim but not understood by this schema version. Non-zero means an older
   * build is holding a newer build's data, so the original bytes must be preserved.
   */
  unrecognizedParts: number;
}

/**
 * Reduce content to the parts we can store and re-render, reporting anything lost.
 *
 * An empty array is preserved as an empty array rather than rejected: `content: ''` survives,
 * so `content: []` must too — the two express the same thing, and deleting the message is a
 * far worse outcome than storing an empty turn.
 */
export function normalizeContentDetailed(raw: unknown): ContentNormalization {
  if (typeof raw === 'string') return { content: raw, droppedParts: 0, unrecognizedParts: 0 };
  if (!Array.isArray(raw)) return { content: null, droppedParts: 0, unrecognizedParts: 0 };

  const parts: ContentPart[] = [];
  let dropped = 0;
  let unrecognized = 0;
  for (const part of raw) {
    if (!part || typeof part !== 'object') {
      dropped += 1;
      continue;
    }
    const type = (part as any).type;
    if (type === 'text') {
      const text = (part as any).text;
      if (typeof text === 'string' && text !== '') {
        // Extra part properties (filename, MIME type, detail) are preserved verbatim.
        parts.push({ ...(part as any), type: 'text', text });
      } else dropped += 1;
    } else if (type === 'image_url') {
      const url = (part as any).image_url?.url;
      if (typeof url === 'string' && url !== '') {
        parts.push({
          ...(part as any),
          type: 'image_url',
          image_url: { ...((part as any).image_url || {}), url },
        });
      } else dropped += 1;
    } else {
      // An unrecognized part is still the user's data. Keep it, but wrapped, so no consumer
      // can mistake it for something it knows how to render or send.
      parts.push(isOpaquePart(part)
        ? (part as OpaquePart)
        : { type: OPAQUE_PART_TYPE, original: part });
      unrecognized += 1;
    }
  }
  return { content: parts, droppedParts: dropped, unrecognizedParts: unrecognized };
}

/** Convenience wrapper for callers that do not need the loss report. */
export function normalizeContent(raw: unknown): MessageContent | null {
  return normalizeContentDetailed(raw).content;
}

/** Flatten content to text for titles and search. Images contribute nothing. */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && (p as any).type === 'text' ? String((p as any).text || '') : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Store a key that came from untrusted JSON.
 *
 * Plain assignment routes `__proto__` through the inherited setter, so the key is neither stored
 * nor reported — silently losing the one key in a mechanism whose entire purpose is to lose
 * nothing. `JSON.parse` produces `__proto__` as an ordinary own property, so this is reachable
 * from any stored archive.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Fold `extra` back into a record before reading it.
 *
 * `extra` exists so a build that does not know a field carries it through instead of deleting
 * it. That promise is only half kept if the build that *does* know the field then ignores the
 * copy sitting in `extra`: a new → old → new round trip loses the field at the final step,
 * silently and with no repair flag, because by then it looks like an ordinary absent field.
 *
 * A value present at the top level always wins — the copy in `extra` is a stale duplicate in
 * that case, which is why it is not treated as a conflict.
 */
function withPromotedExtra<T>(raw: T, knownKeys: ReadonlySet<string>): T {
  const extra = (raw as any)?.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return raw;
  let promoted: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'extra' || !knownKeys.has(key)) continue;
    if ((raw as any)[key] !== undefined) continue;
    promoted ??= { ...(raw as object) } as Record<string, unknown>;
    // `key` is a known schema field, never arbitrary input, so plain assignment is safe here.
    promoted[key] = value;
  }
  return (promoted ?? raw) as T;
}

export interface MessageNormalization {
  message: StoredMessage | null;
  droppedParts: number;
  unrecognizedParts: number;
  /** A stored field had to be substituted or discarded. Forces byte retention upstream. */
  repaired: boolean;
}

export function normalizeMessageDetailed(input: unknown, fallbackId: string): MessageNormalization {
  const nothing = { message: null, droppedParts: 0, unrecognizedParts: 0, repaired: false };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return nothing;
  const raw = withPromotedExtra(input, KNOWN_MESSAGE_KEYS);
  const role = (raw as any).role;
  if (!isStorableRole(role)) return nothing;
  const { content, droppedParts, unrecognizedParts } = normalizeContentDetailed((raw as any).content);
  if (content === null) return nothing;

  let repaired = droppedParts > 0;
  const rawId = (raw as any).id;
  // A message with no usable id gets one, but that is a repair: the caller cannot address the
  // original turn any more, and a later merge cannot match it. An *absent* id is no better
  // than an invalid one — the substituted id is positional and shifts if a sibling is dropped.
  if (typeof rawId !== 'string' || !rawId) repaired = true;
  const id = typeof rawId === 'string' && rawId ? rawId : fallbackId;

  const createdAt = (raw as any).createdAt;
  if (createdAt !== undefined && !(typeof createdAt === 'number' && Number.isFinite(createdAt))) {
    repaired = true;
  }
  const message: StoredMessage = { id, role, content };
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) message.createdAt = createdAt;

  for (const flag of MESSAGE_FLAG_KEYS) {
    const value = (raw as any)[flag];
    if (value === true) message[flag] = true;
    // A known flag key cannot fall through to `extra`, so an unusable value is simply lost.
    // `isError` and `pinned` change what gets sent to the model, so that loss is behavioral.
    else if (value !== undefined && value !== false) repaired = true;
  }

  // Anything this version does not model is preserved verbatim rather than dropped.
  const extra: Record<string, unknown> = {};
  const priorExtra = (raw as any).extra;
  if (priorExtra && typeof priorExtra === 'object' && !Array.isArray(priorExtra)) {
    // A key this schema now owns must not shadow the real field from `extra`.
    for (const [key, value] of Object.entries(priorExtra)) {
      if (!KNOWN_MESSAGE_KEYS.has(key)) setOwn(extra, key, value);
    }
  } else if (priorExtra !== undefined) {
    repaired = true;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_MESSAGE_KEYS.has(key)) setOwn(extra, key, value);
  }
  if (Object.keys(extra).length > 0) message.extra = extra;

  return { message, droppedParts, unrecognizedParts, repaired };
}

/** Convenience wrapper for callers that do not need the diagnostics. */
export function normalizeMessage(raw: unknown, fallbackId: string): StoredMessage | null {
  return normalizeMessageDetailed(raw, fallbackId).message;
}

export interface NormalizedConversation {
  conversation: StoredConversation | null;
  droppedMessages: number;
  droppedParts: number;
  unrecognizedParts: number;
  /** True when a stored field had to be repaired (bad timestamp, non-object settings, …). */
  repaired: boolean;
}

export function normalizeConversation(input: unknown): NormalizedConversation {
  const nothing = {
    conversation: null, droppedMessages: 0, droppedParts: 0, unrecognizedParts: 0, repaired: false,
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return nothing;
  const raw = withPromotedExtra(input, KNOWN_CONVERSATION_KEYS);
  const id = (raw as any).id;
  // Without an id the entry cannot be selected, deleted, or written back to.
  if (typeof id !== 'string' || !id) return nothing;

  let repaired = false;
  const rawMessagesValue = (raw as any).messages;
  // A non-array or absent `messages` is a damaged record, not an empty conversation: silently
  // treating it as [] and saving would erase whatever it actually held. `messages` is required
  // by `StoredConversation`, so its absence is exactly as suspicious as a wrong type.
  if (!Array.isArray(rawMessagesValue)) repaired = true;
  const rawMessages = Array.isArray(rawMessagesValue) ? rawMessagesValue : [];

  const messages: StoredMessage[] = [];
  const seenMessageIds = new Set<string>();
  let dropped = 0;
  let droppedParts = 0;
  let unrecognizedParts = 0;
  rawMessages.forEach((m: unknown, i: number) => {
    const result = normalizeMessageDetailed(m, `${id}-m${i}`);
    droppedParts += result.droppedParts;
    unrecognizedParts += result.unrecognizedParts;
    if (result.repaired) repaired = true;
    if (!result.message) {
      dropped += 1;
      return;
    }
    // Duplicate message ids make keyed rendering and per-message updates ambiguous.
    const unique = allocateUniqueId(result.message.id, seenMessageIds);
    if (unique !== result.message.id) {
      result.message.id = unique;
      repaired = true;
    }
    seenMessageIds.add(unique);
    messages.push(result.message);
  });

  // Every required v2 field that is absent or unusable is a repair, not a default.
  const rawCreatedAt = (raw as any).createdAt;
  if (!(typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt))) repaired = true;
  const rawTitle = (raw as any).title;
  if (typeof rawTitle !== 'string') repaired = true;
  const createdAt = numberOr(rawCreatedAt, 0);
  const rawUpdatedAt = (raw as any).updatedAt;
  if (!(typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt))) repaired = true;
  const conversation: StoredConversation = {
    id,
    title: typeof rawTitle === 'string' ? rawTitle : '',
    createdAt,
    updatedAt: numberOr(rawUpdatedAt, createdAt),
    messages,
  };
  const settings = (raw as any).settings;
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    conversation.settings = settings as Record<string, unknown>;
  } else if (settings !== undefined) {
    repaired = true;
  }
  for (const flag of ['recovered', 'messagesUnavailable', 'titlePinned'] as const) {
    const value = (raw as any)[flag];
    if (value === true) conversation[flag] = true;
    else if (value !== undefined && value !== false) repaired = true;
  }
  const claimed = (raw as any).unavailableMessageCount;
  if (typeof claimed === 'number' && Number.isFinite(claimed) && claimed > 0) {
    conversation.unavailableMessageCount = claimed;
  } else if (claimed !== undefined) {
    repaired = true;
  }

  const extra: Record<string, unknown> = {};
  const priorExtra = (raw as any).extra;
  if (priorExtra && typeof priorExtra === 'object' && !Array.isArray(priorExtra)) {
    // A key this schema now owns must not shadow the real field from `extra`.
    for (const [key, value] of Object.entries(priorExtra)) {
      if (!KNOWN_CONVERSATION_KEYS.has(key)) setOwn(extra, key, value);
    }
  } else if (priorExtra !== undefined) {
    repaired = true;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_CONVERSATION_KEYS.has(key)) setOwn(extra, key, value);
  }
  if (Object.keys(extra).length > 0) conversation.extra = extra;

  return { conversation, droppedMessages: dropped, droppedParts, unrecognizedParts, repaired };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parse a stored archive blob against the running application version.
 *
 * Unparseable input, a non-object root, and a missing or unknown version are all corrupt: the
 * caller must preserve the bytes rather than start fresh over them.
 *
 * `appVersion` is **required**: an optional rollback gate is applied only by callers who
 * remember it, which is the same as having no gate. Tests that genuinely do not care may pass
 * `SKIP_APP_VERSION_GATE` so the omission is explicit and greppable.
 */
export function parseConversationArchive(
  raw: string | null | undefined,
  appVersion: string,
): ArchiveParseResult {
  const empty: ArchiveParseResult = {
    archive: null,
    corrupt: false,
    incompatible: false,
    droppedConversations: 0,
    droppedMessages: 0,
    droppedParts: 0,
    unrecognizedParts: 0,
    repaired: false,
    lossy: false,
    reason: null,
  };
  if (raw === null || raw === undefined || raw === '') return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, corrupt: true, reason: 'The stored conversations are not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...empty, corrupt: true, reason: 'The stored conversations are not an archive object.' };
  }

  const version = (parsed as any).version;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return { ...empty, corrupt: true, reason: 'The stored conversations have no usable schema version.' };
  }
  // Newer archives are intact, not damaged. Refuse to touch them.
  if (version > CONVERSATION_SCHEMA_VERSION) {
    return {
      ...empty,
      incompatible: true,
      reason: `These conversations were written by a newer version of Flint (format ${version}). Update Flint to open them.`,
    };
  }
  // An older schema needs its own migration, not this version's normalizer: reading it here
  // would stamp it as v2 and quietly discard whatever that version expressed differently.
  if (!READABLE_SCHEMA_VERSIONS.has(version)) {
    return {
      ...empty,
      incompatible: true,
      reason: `Conversation format ${version} needs a migration this build does not have.`,
    };
  }

  // Refuse to write over an archive that declares a floor above the running build.
  const rawMinAppVersion = (parsed as any).minAppVersion;
  const minAppVersionUsable = typeof rawMinAppVersion === 'string' && isUsableVersion(rawMinAppVersion);
  // An unreadable floor must not silently become "no floor": assume the strictest we know.
  // Clamp to the floor this build knows: a stored floor lower than MIN_ROLLBACK_APP_VERSION
  // was either written by a build that predates the guarantee or tampered with, and honouring
  // it would let a build that cannot read v2 write over the archive anyway.
  const storedFloor = minAppVersionUsable ? rawMinAppVersion : MIN_ROLLBACK_APP_VERSION;
  const minAppVersion =
    compareVersions(storedFloor, MIN_ROLLBACK_APP_VERSION) < 0 ? MIN_ROLLBACK_APP_VERSION : storedFloor;
  // Any effective floor that differs from what was stored means we will rewrite the header on
  // the next save. That is a change to the record, so it must not report as a clean read —
  // including the case where the running build happens to satisfy the raised floor.
  const repairedHeader = minAppVersion !== rawMinAppVersion;

  if (appVersion !== SKIP_APP_VERSION_GATE) {
    if (!isUsableVersion(appVersion)) {
      return { ...empty, incompatible: true, reason: `Cannot verify compatibility: "${appVersion}" is not a usable version.` };
    }
    if (compareVersions(appVersion, minAppVersion) < 0) {
      return {
        ...empty,
        incompatible: true,
        reason: `These conversations require Flint ${minAppVersion} or newer (this build is ${appVersion}).`,
      };
    }
  }

  const rawConversations = Array.isArray((parsed as any).conversations)
    ? (parsed as any).conversations
    : null;
  if (!rawConversations) {
    return { ...empty, corrupt: true, reason: 'The stored conversations list is missing or not a list.' };
  }

  const conversations: StoredConversation[] = [];
  const seenIds = new Set<string>();
  let droppedConversations = 0;
  let droppedMessages = 0;
  let droppedParts = 0;
  let unrecognizedParts = 0;
  let repaired = repairedHeader;
  for (const entry of rawConversations) {
    const result = normalizeConversation(entry);
    droppedMessages += result.droppedMessages;
    droppedParts += result.droppedParts;
    unrecognizedParts += result.unrecognizedParts;
    if (result.repaired) repaired = true;
    if (!result.conversation) {
      droppedConversations += 1;
      continue;
    }
    // Duplicate ids make sidebar keying ambiguous and let a delete remove the wrong entry.
    const unique = allocateUniqueId(result.conversation.id, seenIds);
    if (unique !== result.conversation.id) {
      result.conversation.id = unique;
      repaired = true;
    }
    seenIds.add(unique);
    conversations.push(result.conversation);
  }

  const activeIdRaw = (parsed as any).activeId;
  const activeIdResolves =
    typeof activeIdRaw === 'string' && conversations.some((c) => c.id === activeIdRaw);
  const activeId = activeIdResolves ? activeIdRaw : null;
  // Pointing at a conversation that is gone means we lost the one it named. An absent
  // `activeId` is equally a repair: the field is required by `ConversationArchive`, so its
  // absence means the selection was never written, not that nothing was selected.
  if (!activeIdResolves && activeIdRaw !== null) repaired = true;

  const lossy =
    droppedConversations > 0 ||
    droppedMessages > 0 ||
    droppedParts > 0 ||
    unrecognizedParts > 0 ||
    repaired;

  return {
    archive: {
      version: CONVERSATION_SCHEMA_VERSION,
      minAppVersion,
      activeId,
      conversations,
    },
    corrupt: droppedConversations > 0 || droppedMessages > 0,
    incompatible: false,
    droppedConversations,
    droppedMessages,
    droppedParts,
    unrecognizedParts,
    repaired,
    lossy,
    reason: lossy ? 'Part of the stored conversations could not be read exactly as written.' : null,
  };
}

/** Build a title from the first user turn's text. Never stringifies a parts array. */
export function deriveConversationTitle(messages: StoredMessage[], fallback = 'New chat'): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const text = contentToText(firstUser?.content).trim();
  if (!text) return fallback;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 50 ? `${oneLine.slice(0, 50).trim()}…` : oneLine;
}

export function createEmptyArchive(activeId: string | null = null): ConversationArchive {
  return {
    version: CONVERSATION_SCHEMA_VERSION,
    minAppVersion: MIN_ROLLBACK_APP_VERSION,
    activeId,
    conversations: [],
  };
}

export interface LegacyMigrationInput {
  /** Parsed pre-v2 sidebar index: `{id, title, createdAt, messageCount}` entries. */
  legacyIndex: unknown;
  /** The single global message thread from the pre-v2 settings blob. */
  legacyMessages: unknown;
  /** Injected so migration output is deterministic under test. */
  now: number;
  /**
   * Stable id for the recovered thread. Supply a value derived from the legacy bytes so an
   * interrupted migration that is retried reuses the same id instead of duplicating the thread.
   */
  recoveredId?: string;
}

export interface LegacyMigrationResult {
  archive: ConversationArchive;
  /** Conversations carried over from the legacy sidebar index. Excludes the recovered thread. */
  importedConversations: number;
  /** True when the orphan global thread was imported as its own labeled conversation. */
  recoveredThread: boolean;
  /** Legacy entries that claimed turns none of which were ever stored. */
  titleOnlyConversations: number;
  /** True when a global thread value existed on disk, even if it was malformed. */
  legacyThreadPresent: boolean;
  /** True when the stored thread was present but not an array — damage, not absence. */
  legacyThreadMalformed: boolean;
  /** True when the stored index was present but not an array. */
  legacyIndexMalformed: boolean;
  /** Content parts lost from otherwise-recoverable legacy turns. */
  droppedLegacyParts: number;
  /** Legacy content parts kept verbatim but not understood by this build. */
  unrecognizedLegacyParts: number;
  /** Legacy turns that survived but needed a field repaired (id, timestamp, flag, extra). */
  repairedLegacyMessages: number;
  /** Legacy index entries whose title, timestamp, or message count had to be repaired. */
  repairedLegacyEntries: number;
  /**
   * True when anything at all about the legacy payload was imperfect. The storage stage must
   * retain the original legacy keys rather than deleting them whenever this is set.
   */
  legacyLossy: boolean;
  /** Legacy index entries too damaged to import at all. */
  droppedLegacyConversations: number;
  /**
   * Turns from the global thread that could not be normalized. Non-zero means the legacy bytes
   * must be retained: a "recovered" thread that silently lost turns is not a recovery.
   */
  droppedLegacyMessages: number;
}

/**
 * Derive a stable id from the legacy thread's own bytes.
 *
 * Using the clock would mint a new conversation every time an interrupted migration is retried,
 * so the same input must always yield the same id. FNV-1a is sufficient here: this is a
 * de-duplication key, not a security boundary.
 */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function deriveRecoveredId(legacyMessages: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(legacyMessages) ?? '';
  } catch {
    serialized = String(legacyMessages);
  }
  return `recovered-${hashString(serialized)}`;
}

/**
 * Convert the pre-v2 layout into a v2 archive.
 *
 * The legacy index never stored messages, so its entries can only contribute titles. The one
 * real thread on disk is the global one, and nothing in the legacy data proves which sidebar
 * entry it belonged to — the app simply showed it beside whichever entry was selected. Guessing
 * "the first one" would silently attach a stranger's turns to a named conversation, so it is
 * imported as its own conversation marked `recovered`.
 *
 * Deterministic, not idempotent on its own. Given identical legacy input and the same
 * `recoveredId` it produces an identical archive, but nothing here prevents a second run from
 * creating a second copy — that is the storage layer's job. The caller must therefore:
 *   1. read and retain both legacy payloads before any write;
 *   2. build and validate the whole candidate archive;
 *   3. commit it atomically;
 *   4. treat malformed or incompatible existing v2 bytes as write-blocking recovery, never as
 *      "archive absent" (which would re-migrate over them);
 *   5. leave the legacy bytes in place until that commit is durable.
 *
 * `recoveredId` is derived from the legacy content rather than the clock so an interrupted and
 * retried migration reuses the same id instead of minting a duplicate conversation.
 */
export function migrateLegacyConversations(input: LegacyMigrationInput): LegacyMigrationResult {
  const archive = createEmptyArchive();
  const legacyIndexMalformed =
    input.legacyIndex !== undefined && input.legacyIndex !== null && !Array.isArray(input.legacyIndex);
  const legacyEntries = Array.isArray(input.legacyIndex) ? input.legacyIndex : [];
  let titleOnly = 0;
  let droppedLegacyConversations = 0;
  let repairedLegacyEntries = 0;
  const seenIds = new Set<string>();

  for (const entry of legacyEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      droppedLegacyConversations += 1;
      continue;
    }
    const id = (entry as any).id;
    if (typeof id !== 'string' || !id || seenIds.has(id)) {
      droppedLegacyConversations += 1;
      continue;
    }
    seenIds.add(id);
    // Each substituted field below is a guess. Stamping "Untitled chat" and today's date onto
    // a damaged entry looks identical to a genuinely untitled chat, so count the repair.
    let entryRepaired = false;
    const rawCreatedAt = (entry as any).createdAt;
    if (!(typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt))) entryRepaired = true;
    const createdAt = numberOr(rawCreatedAt, input.now);
    const rawCount = (entry as any).messageCount;
    // A bad count cannot become 0 quietly: 0 suppresses the messagesUnavailable notice, which
    // is the only signal the user gets that this conversation's turns were never stored. A
    // count is evidence of how much was lost, so it must be a present non-negative integer —
    // a missing, negative, or fractional value is not evidence and must not be presented as one.
    const countUsable = Number.isInteger(rawCount) && (rawCount as number) >= 0;
    if (!countUsable) entryRepaired = true;
    const claimed = countUsable ? (rawCount as number) : 0;
    const rawTitle = (entry as any).title;
    if (typeof rawTitle !== 'string') entryRepaired = true;
    if (entryRepaired) repairedLegacyEntries += 1;
    const conversation: StoredConversation = {
      id,
      title: typeof rawTitle === 'string' ? rawTitle : 'Untitled chat',
      createdAt,
      updatedAt: createdAt,
      messages: [],
    };
    // Its turns were never on disk. Say so instead of presenting an empty thread as intact.
    if (claimed > 0) {
      conversation.messagesUnavailable = true;
      conversation.unavailableMessageCount = claimed;
      titleOnly += 1;
    }
    archive.conversations.push(conversation);
  }
  const importedFromIndex = archive.conversations.length;

  // `undefined` is the only value that means "no thread was stored"; the reader maps a missing
  // key to it deliberately. Everything else was read off disk, so anything that is not an array
  // is a stored value that is not a thread — including `null`. Treating `null` as absence would
  // report a damaged source as a clean empty start and then let the retirement gate delete it,
  // which is the one outcome this migration exists to prevent.
  const legacyThreadMalformed =
    input.legacyMessages !== undefined && !Array.isArray(input.legacyMessages);
  const messages: StoredMessage[] = [];
  const rawMessages = Array.isArray(input.legacyMessages) ? input.legacyMessages : [];
  let droppedLegacyMessages = 0;
  let droppedLegacyParts = 0;
  let unrecognizedLegacyParts = 0;
  let repairedLegacyMessages = 0;
  const seenMessageIds = new Set<string>();
  rawMessages.forEach((m, i) => {
    const result = normalizeMessageDetailed(m, `recovered-m${i}`);
    droppedLegacyParts += result.droppedParts;
    unrecognizedLegacyParts += result.unrecognizedParts;
    if (result.repaired) repairedLegacyMessages += 1;
    if (!result.message) {
      droppedLegacyMessages += 1;
      return;
    }
    const unique = allocateUniqueId(result.message.id, seenMessageIds);
    // Renaming a turn that carried its own id is a repair even when normalization was clean:
    // anything that referenced the original id no longer matches.
    if (unique !== result.message.id && !result.repaired) repairedLegacyMessages += 1;
    result.message.id = unique;
    seenMessageIds.add(unique);
    messages.push(result.message);
  });

  let recoveredThread = false;
  if (messages.length > 0) {
    let id = input.recoveredId || deriveRecoveredId(input.legacyMessages);
    // Never shadow a legacy conversation that already claims this id.
    while (seenIds.has(id)) id = `${id}-r`;
    seenIds.add(id);
    archive.conversations.push({
      id,
      title: `Recovered chat — ${deriveConversationTitle(messages, 'earlier session')}`,
      createdAt: input.now,
      updatedAt: input.now,
      messages,
      recovered: true,
    });
    archive.activeId = id;
    recoveredThread = true;
  } else if (archive.conversations.length > 0) {
    archive.activeId = archive.conversations[0].id;
  }

  return {
    archive,
    importedConversations: importedFromIndex,
    recoveredThread,
    titleOnlyConversations: titleOnly,
    // "Present" means a value existed on disk — a malformed payload is damage, not absence.
    legacyThreadPresent: rawMessages.length > 0 || legacyThreadMalformed,
    legacyThreadMalformed,
    legacyIndexMalformed,
    droppedLegacyConversations,
    droppedLegacyMessages,
    droppedLegacyParts,
    unrecognizedLegacyParts,
    repairedLegacyMessages,
    repairedLegacyEntries,
    legacyLossy:
      legacyThreadMalformed ||
      legacyIndexMalformed ||
      droppedLegacyConversations > 0 ||
      droppedLegacyMessages > 0 ||
      droppedLegacyParts > 0 ||
      unrecognizedLegacyParts > 0 ||
      repairedLegacyMessages > 0 ||
      repairedLegacyEntries > 0,
  };
}
