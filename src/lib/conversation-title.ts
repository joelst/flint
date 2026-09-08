/**
 * When a conversation's title may be replaced by one derived from its first turn.
 *
 * The pre-v2 app re-derived the title on *every* save, unconditionally. That is destructive in
 * three separate ways, and each of them is silent:
 *
 *  - A conversation whose thread is not currently loaded derives to the fallback, so simply
 *    switching away from it renames it to "New chat".
 *  - A recovered conversation loses the label that says its messages could not be attributed,
 *    which is the only thing telling the user not to trust the pairing.
 *  - A conversation the user named loses that name the next time they type in it.
 *
 * This module is the single place that decides, so no call site can re-introduce the rewrite by
 * accident. It is pure: it reports what the title *should* be and why, and stores nothing.
 */

import { deriveConversationTitle, type StoredConversation, type StoredMessage } from './conversation-store';

export const DEFAULT_CONVERSATION_TITLE = 'New chat';

export type TitleDecisionReason =
  /** The user named this conversation; a derived title must never replace a deliberate one. */
  | 'pinned'
  /**
   * The conversation carries a recovery or unavailable-messages label. That label describes the
   * provenance of the record, which no amount of later editing changes.
   */
  | 'labelled'
  /**
   * The thread has no user text to derive from. This is the case that renamed conversations to
   * "New chat" merely because their messages were not in memory — an existing title is better
   * evidence of what the conversation is than the absence of a loaded thread.
   */
  | 'no-source'
  /** Derived from the first user turn. */
  | 'derived';

export interface TitleDecision {
  title: string;
  /** True when `title` differs from the current one, so callers can skip a pointless write. */
  changed: boolean;
  reason: TitleDecisionReason;
}

export interface TitleInput {
  /** The currently stored title. */
  current: string;
  /** The thread as loaded. An empty array means "not loaded", not "known to be empty". */
  messages: StoredMessage[];
  titlePinned?: boolean;
  recovered?: boolean;
  messagesUnavailable?: boolean;
  fallback?: string;
}

/**
 * Decide the title for a conversation.
 *
 * Note the asymmetry: a *derived* title may replace another derived title freely, but nothing
 * derived may replace a pinned or labelled one, and an absent thread may not replace anything.
 * The rule is that a title is only rewritten when the rewrite is strictly better informed than
 * what it replaces.
 */
export function resolveConversationTitle(input: TitleInput): TitleDecision {
  const fallback = input.fallback ?? DEFAULT_CONVERSATION_TITLE;
  const current = typeof input.current === 'string' ? input.current : '';
  const keep = (reason: TitleDecisionReason): TitleDecision => {
    // A blank stored title is not worth protecting: it renders as an empty row in the sidebar
    // and tells the user nothing. Only a title with actual content outranks the fallback.
    const title = current.trim() ? current : fallback;
    return { title, changed: title !== input.current, reason };
  };

  if (input.titlePinned) return keep('pinned');
  if (input.recovered || input.messagesUnavailable) return keep('labelled');

  const derived = deriveConversationTitle(input.messages ?? [], '');
  if (!derived) return keep('no-source');
  return { title: derived, changed: derived !== input.current, reason: 'derived' };
}

/**
 * Convenience wrapper for a whole conversation record.
 *
 * Returns the same object when nothing changes, so an identity check is enough to tell whether
 * a save is warranted.
 */
export function applyConversationTitle(conversation: StoredConversation): StoredConversation {
  const decision = resolveConversationTitle({
    current: conversation.title,
    messages: conversation.messages,
    titlePinned: conversation.titlePinned,
    recovered: conversation.recovered,
    messagesUnavailable: conversation.messagesUnavailable,
  });
  if (!decision.changed) return conversation;
  return { ...conversation, title: decision.title };
}

/**
 * Record a human-chosen title, pinning it against future derivation.
 *
 * An empty or whitespace-only name is treated as clearing the custom name rather than as a
 * request to display nothing: the conversation returns to deriving its title.
 */
export function renameConversation(
  conversation: StoredConversation,
  name: string,
): StoredConversation {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    const { titlePinned: _dropped, ...rest } = conversation;
    return applyConversationTitle(rest as StoredConversation);
  }
  return { ...conversation, title: trimmed, titlePinned: true };
}
