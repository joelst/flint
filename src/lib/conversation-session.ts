/**
 * Session state transitions for the conversation list.
 *
 * The pre-v2 app kept one global message thread and a sidebar index that stored only titles.
 * Selecting a conversation therefore did not *load* anything — it blanked the thread and let the
 * user start typing. Whatever they had been reading was gone, and because the index recorded a
 * `messageCount` taken from that global thread, the sidebar confidently displayed a turn count
 * for messages that no longer existed anywhere.
 *
 * This module owns the transitions that replace that scheme. It is pure and storage-free so the
 * rules can be tested directly: `+page.svelte` is excluded from coverage, and these are exactly
 * the paths where a mistake destroys a user's history rather than merely misrendering it.
 *
 * The invariant everything here protects:
 *
 *   A conversation's stored messages may only be replaced by a thread that is known to have
 *   been loaded from that same conversation.
 *
 * An empty `chatMessages` is ambiguous on its own — it means both "this conversation is empty"
 * and "no thread is loaded yet". Writing it back on the second reading erases a real thread, so
 * a thread here always carries the id it was loaded for and a capture that cannot prove the
 * match refuses rather than guesses.
 */

import {
  applyConversationTitle,
  renameConversation as renameStoredConversation,
} from './conversation-title';
import {
  mergeConversationSettings,
  readConversationSettings,
  type ConversationArchive,
  type ConversationSettings,
  type StoredConversation,
  type StoredMessage,
} from './conversation-store';

/**
 * The messages currently held in the UI, tagged with the conversation they came from.
 *
 * `loadedFor: null` means nothing is loaded. It is deliberately distinct from an empty message
 * list, because only one of those two states may be written back.
 */
export interface SessionThread {
  loadedFor: string | null;
  messages: StoredMessage[];
}

export interface SessionState {
  archive: ConversationArchive;
  thread: SessionThread;
}

/** Why a capture did not store anything. `null` means it did. */
export type CaptureSkipReason =
  /** No thread was loaded, so there is nothing to attribute to any conversation. */
  | 'no-thread'
  /**
   * The loaded thread belongs to a conversation that is no longer in the archive — it was
   * deleted while loaded. Storing it would resurrect the conversation the user just removed.
   */
  | 'conversation-absent'
  /** Nothing about the conversation actually changed, so no write is warranted. */
  | 'unchanged'
  | null;

export interface CaptureResult {
  archive: ConversationArchive;
  /** True when `archive` differs from the input and is worth persisting. */
  changed: boolean;
  skipped: CaptureSkipReason;
}

export const EMPTY_THREAD: SessionThread = { loadedFor: null, messages: [] };

export function findConversation(
  archive: ConversationArchive,
  id: string | null,
): StoredConversation | null {
  if (!id) return null;
  return archive.conversations.find((c) => c.id === id) ?? null;
}

/**
 * Write the loaded thread back into its own conversation.
 *
 * Refuses in every case where the destination cannot be proven, which is the whole point: this
 * is the only function that overwrites stored messages.
 *
 * `settings` is a patch, not a replacement — see `mergeConversationSettings`. Passing none
 * leaves the conversation's stored settings untouched rather than clearing them.
 */
export function captureThread(
  state: SessionState,
  options: { now: number; settings?: ConversationSettings },
): CaptureResult {
  const { archive, thread } = state;
  if (!thread.loadedFor) {
    return { archive, changed: false, skipped: 'no-thread' };
  }
  const index = archive.conversations.findIndex((c) => c.id === thread.loadedFor);
  if (index === -1) {
    return { archive, changed: false, skipped: 'conversation-absent' };
  }

  const existing = archive.conversations[index];
  const settings = options.settings
    ? mergeConversationSettings(existing.settings, options.settings)
    : existing.settings;

  const candidate: StoredConversation = { ...existing, messages: snapshotMessages(thread.messages) };
  // A settings bag that merges to nothing must be removed, not stored as `{}`: the schema
  // treats an absent bag as "inherit the app defaults", which is not the same as an empty one.
  if (settings === undefined) delete candidate.settings;
  else candidate.settings = settings;

  const titled = applyConversationTitle(candidate);

  // `updatedAt` is user-visible ordering, so it may only move when something really changed.
  // Comparing against the stored record rather than tracking dirty flags at the call sites
  // keeps this correct no matter which of them ran.
  const messagesChanged = !sameMessages(existing.messages, titled.messages);
  const settingsChanged = !sameSettings(existing.settings, titled.settings);
  const titleChanged = titled.title !== existing.title;
  if (!messagesChanged && !settingsChanged && !titleChanged) {
    return { archive, changed: false, skipped: 'unchanged' };
  }

  const stored: StoredConversation = messagesChanged
    ? { ...titled, updatedAt: options.now }
    : titled;
  const conversations = archive.conversations.map((c, i) => (i === index ? stored : c));
  return { archive: { ...archive, conversations }, changed: true, skipped: null };
}

/**
 * Field comparison for a message list.
 *
 * Reference identity is not sufficient, because the UI mutates message objects in place: pinning
 * assigns `msg.pinned`, condensing assigns `m.condensed`, and both then reassign `chatMessages`
 * only to force a re-render. If the archive held the same objects, those edits would already be
 * "in" the archive and the comparison would report no change — so the flags would never be
 * persisted, and pinned or condensed turns would silently revert on restart.
 *
 * `snapshotMessages` breaks the aliasing and this compares by value, one level deep. Deeper is
 * unnecessary: `content` is always replaced wholesale rather than edited in place, including
 * while streaming.
 */
function sameMessages(a: StoredMessage[], b: StoredMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!sameMessage(a[i], b[i])) return false;
  }
  return true;
}

function sameMessage(a: StoredMessage, b: StoredMessage): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      (a as unknown as Record<string, unknown>)[k] ===
        (b as unknown as Record<string, unknown>)[k],
  );
}

/**
 * Detach a thread from the UI's objects before it is stored.
 *
 * Without this the archive and the UI share message objects, so an in-place edit reaches the
 * archive without going through `captureThread` — bypassing the ownership guard entirely and
 * defeating change detection at the same time.
 */
export function snapshotMessages(messages: StoredMessage[]): StoredMessage[] {
  return messages.map((m) => ({ ...m }));
}

/**
 * Give every turn a stable id.
 *
 * The UI creates several kinds of message without one — the user turn, the injected web-context
 * pair, and the generated summary. The storage layer treats a minted id as a *repair*, and its
 * save gate refuses any archive that would not round-trip exactly, so a single id-less turn
 * makes every subsequent save fail. Persistence would appear to work and then silently stop the
 * first time the user sent an ordinary message.
 *
 * Idempotent: a turn that already has an id keeps it, so applying this repeatedly converges and
 * never invalidates the identity lookups the streaming path relies on. Returns the original
 * array when nothing was missing, so callers can skip a pointless reassignment.
 */
export function ensureMessageIds(
  messages: StoredMessage[],
  mint: (index: number) => string,
): { messages: StoredMessage[]; changed: boolean } {
  let changed = false;
  const seen = new Set<string>();
  const out = messages.map((m, i) => {
    const id = (m as StoredMessage | undefined)?.id;
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      return m;
    }
    changed = true;
    let next = mint(i);
    while (seen.has(next)) next = `${next}-x`;
    seen.add(next);
    return { ...m, id: next };
  });
  return changed ? { messages: out, changed } : { messages, changed: false };
}

function sameSettings(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

export interface SelectResult extends SessionState {
  /** The selected conversation, or null when the id was not found. */
  conversation: StoredConversation | null;
  /** Settings the UI should apply for this conversation. Absent keys mean "app default". */
  settings: ConversationSettings;
  /** True when the archive changed and should be persisted. */
  changed: boolean;
}

/**
 * Switch to another conversation, storing the outgoing thread first.
 *
 * The capture is not optional and not deferred to the caller: doing it here is what makes the
 * switch non-destructive, and it was the missing step that made the old sidebar lose history.
 *
 * An id that is not in the archive leaves the selection alone rather than blanking the thread.
 * That case means the UI and the archive have diverged, and discarding the user's visible
 * messages is the worst available response to a disagreement about which record is current.
 */
export function selectConversation(
  state: SessionState,
  targetId: string,
  options: { now: number; settings?: ConversationSettings },
): SelectResult {
  const target = findConversation(state.archive, targetId);
  if (!target) {
    return {
      ...state,
      conversation: null,
      settings: {},
      changed: false,
    };
  }

  // Selecting what is already selected still reconciles `activeId`, but must not re-read the
  // thread from the archive: the loaded copy is newer than the stored one whenever a turn is
  // in flight, so re-reading would visibly roll the thread back.
  if (state.thread.loadedFor === targetId) {
    const captured = captureThread(state, options);
    const archive =
      captured.archive.activeId === targetId
        ? captured.archive
        : { ...captured.archive, activeId: targetId };
    return {
      archive,
      thread: state.thread,
      conversation: findConversation(archive, targetId),
      settings: readConversationSettings(findConversation(archive, targetId)?.settings).settings,
      changed: captured.changed || archive !== captured.archive,
    };
  }

  const captured = captureThread(state, options);
  const stored = findConversation(captured.archive, targetId);
  const archive: ConversationArchive = { ...captured.archive, activeId: targetId };
  return {
    archive,
    // Snapshot, not just a fresh array: the UI edits message objects in place (pin, condense),
    // and a shared object would let that reach the archive without passing the capture guard.
    thread: { loadedFor: targetId, messages: snapshotMessages(stored?.messages ?? []) },
    conversation: stored,
    settings: readConversationSettings(stored?.settings).settings,
    changed: true,
  };
}

export interface CreateResult extends SessionState {
  conversation: StoredConversation;
  /**
   * True when the requested id was already taken and a suffixed one was used instead.
   *
   * A duplicate id is not a cosmetic problem: `captureThread` resolves an id to the *first*
   * match, so a second record sharing an id would take the empty thread of the new conversation
   * and overwrite the existing one's history. The archive would also then fail validation, and
   * deleting either record would remove both.
   */
  idAdjusted: boolean;
}

/**
 * Start a new conversation, storing the outgoing thread first.
 *
 * `settings` seeds the new conversation rather than patching the old one — the capture of the
 * outgoing thread deliberately passes no settings patch, so creating a chat cannot rewrite the
 * settings of the one being left.
 */
export function createConversation(
  state: SessionState,
  options: {
    id: string;
    now: number;
    title?: string;
    settings?: ConversationSettings;
  },
): CreateResult {
  const captured = captureThread(state, { now: options.now });
  const taken = new Set(captured.archive.conversations.map((c) => c.id));
  let id = typeof options.id === 'string' && options.id ? options.id : `chat-${options.now}`;
  const requested = id;
  while (taken.has(id)) id = `${id}-2`;

  const settings = mergeConversationSettings(undefined, options.settings ?? {});
  const conversation: StoredConversation = {
    id,
    title: options.title ?? 'New chat',
    createdAt: options.now,
    updatedAt: options.now,
    messages: [],
  };
  if (settings !== undefined) conversation.settings = settings;

  return {
    archive: {
      ...captured.archive,
      activeId: id,
      conversations: [...captured.archive.conversations, conversation],
    },
    thread: { loadedFor: id, messages: [] },
    conversation,
    idAdjusted: id !== requested,
  };
}

export interface DeleteResult extends SessionState {
  /** True when a conversation was actually removed. */
  removed: boolean;
  /** The conversation now selected, or null when the archive is empty. */
  conversation: StoredConversation | null;
  settings: ConversationSettings;
}

/**
 * Remove a conversation and select a neighbour.
 *
 * Deleting the *inactive* conversation must still capture the loaded thread, or an autosave
 * that has not yet run is lost along with the unrelated record the user removed.
 *
 * When the deleted conversation was the active one the neighbour's thread is loaded, so the UI
 * shows a real conversation rather than an empty pane attributed to nothing. Deleting the last
 * conversation leaves the archive empty and the thread unloaded; the caller creates the
 * replacement so the new id comes from one place.
 */
export function deleteConversation(
  state: SessionState,
  id: string,
  options: { now: number },
): DeleteResult {
  const index = state.archive.conversations.findIndex((c) => c.id === id);
  if (index === -1) {
    return {
      ...state,
      removed: false,
      conversation: findConversation(state.archive, state.archive.activeId),
      settings: readConversationSettings(
        findConversation(state.archive, state.archive.activeId)?.settings,
      ).settings,
    };
  }

  // Capture before removal. If the loaded thread belongs to the conversation being deleted the
  // capture is pointless but harmless; if it belongs to any other, skipping this would discard
  // unsaved turns from a conversation the user never asked to touch.
  const captured = captureThread(state, { now: options.now });
  const remaining = captured.archive.conversations.filter((c) => c.id !== id);

  const deletingActive = state.archive.activeId === id || state.thread.loadedFor === id;
  if (!deletingActive) {
    return {
      archive: { ...captured.archive, conversations: remaining },
      thread: state.thread,
      removed: true,
      conversation: findConversation({ ...captured.archive, conversations: remaining }, captured.archive.activeId),
      settings: readConversationSettings(
        remaining.find((c) => c.id === captured.archive.activeId)?.settings,
      ).settings,
    };
  }

  // Prefer the following conversation so repeated deletes walk down the list rather than
  // jumping to the top on every removal.
  const next = remaining[index] ?? remaining[index - 1] ?? remaining[0] ?? null;
  return {
    archive: {
      ...captured.archive,
      conversations: remaining,
      activeId: next?.id ?? null,
    },
    thread: next
      ? { loadedFor: next.id, messages: snapshotMessages(next.messages) }
      : { ...EMPTY_THREAD },
    removed: true,
    conversation: next,
    settings: readConversationSettings(next?.settings).settings,
  };
}

/**
 * Record a human-chosen title.
 *
 * Separate from `captureThread` because it must pin the title even when the thread is not
 * loaded — renaming from the sidebar is exactly that case.
 */
export function renameConversationInSession(
  state: SessionState,
  id: string,
  name: string,
  options: { now: number },
): { archive: ConversationArchive; changed: boolean } {
  const index = state.archive.conversations.findIndex((c) => c.id === id);
  if (index === -1) return { archive: state.archive, changed: false };
  const existing = state.archive.conversations[index];
  const renamed = renameStoredConversation(existing, name);
  if (renamed.title === existing.title && renamed.titlePinned === existing.titlePinned) {
    return { archive: state.archive, changed: false };
  }
  const conversations = state.archive.conversations.map((c, i) =>
    i === index ? { ...renamed, updatedAt: options.now } : c,
  );
  return { archive: { ...state.archive, conversations }, changed: true };
}

/** Sidebar row. `messageCount` is a fact about stored messages, never about the loaded thread. */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  recovered?: boolean;
  messagesUnavailable?: boolean;
  unavailableMessageCount?: number;
}

/**
 * Project the archive into sidebar rows.
 *
 * The loaded thread is passed in so the active row's count reflects what the user is looking at
 * rather than what was last written; without it the count visibly lags one autosave behind.
 * A conversation whose legacy turns were never stored reports the count the old index claimed,
 * flagged, so the UI can say the messages are unavailable instead of showing "0 messages" for a
 * chat the user remembers writing.
 */
export function summarizeConversations(
  archive: ConversationArchive,
  thread: SessionThread = EMPTY_THREAD,
): ConversationSummary[] {
  return archive.conversations.map((c) => {
    const live = thread.loadedFor === c.id ? thread.messages : c.messages;
    const summary: ConversationSummary = {
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: live.length,
    };
    if (c.recovered) summary.recovered = true;
    if (c.messagesUnavailable) {
      summary.messagesUnavailable = true;
      summary.unavailableMessageCount = c.unavailableMessageCount ?? 0;
    }
    return summary;
  });
}
