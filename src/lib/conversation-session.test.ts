import { describe, it, expect } from 'vitest';
import {
  captureThread,
  ensureMessageIds,
  snapshotMessages,
  createConversation,
  deleteConversation,
  findConversation,
  renameConversationInSession,
  selectConversation,
  summarizeConversations,
  EMPTY_THREAD,
  type SessionState,
} from './conversation-session';
import type { ConversationArchive, StoredConversation, StoredMessage } from './conversation-store';
import {
  CONVERSATION_SCHEMA_VERSION,
  MIN_ROLLBACK_APP_VERSION,
  contentToText,
} from './conversation-store';
import { openConversationArchive, saveConversationArchive } from './conversation-repository';

const NOW = 1_700_000_000_000;

function msg(id: string, text: string, role: StoredMessage['role'] = 'user'): StoredMessage {
  return { id, role, content: text };
}

function conv(id: string, messages: StoredMessage[] = [], extra: Partial<StoredConversation> = {}): StoredConversation {
  return {
    id,
    title: 'New chat',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    messages,
    ...extra,
  };
}

function archiveOf(...conversations: StoredConversation[]): ConversationArchive {
  return {
    version: CONVERSATION_SCHEMA_VERSION,
    minAppVersion: MIN_ROLLBACK_APP_VERSION,
    activeId: conversations[0]?.id ?? null,
    conversations,
  };
}

function state(archive: ConversationArchive, loadedFor: string | null, messages: StoredMessage[] = []): SessionState {
  return { archive, thread: { loadedFor, messages } };
}

describe('captureThread refuses to guess a destination', () => {
  it('stores nothing when no thread is loaded', () => {
    const archive = archiveOf(conv('a', [msg('m1', 'hello')]));
    const result = captureThread(state(archive, null, []), { now: NOW });
    expect(result.changed).toBe(false);
    expect(result.skipped).toBe('no-thread');
    expect(result.archive).toBe(archive);
  });

  it('does not erase stored messages when an empty thread is not attributed', () => {
    // The core hazard: an empty `chatMessages` means both "empty conversation" and "nothing
    // loaded yet". Only the attributed reading may be written back.
    const archive = archiveOf(conv('a', [msg('m1', 'irreplaceable')]));
    const result = captureThread(state(archive, null, []), { now: NOW });
    expect(findConversation(result.archive, 'a')!.messages).toHaveLength(1);
  });

  it('stores an empty thread when it is genuinely attributed', () => {
    const archive = archiveOf(conv('a', [msg('m1', 'gone')]));
    const result = captureThread(state(archive, 'a', []), { now: NOW });
    expect(result.changed).toBe(true);
    expect(findConversation(result.archive, 'a')!.messages).toEqual([]);
  });

  it('refuses to resurrect a conversation deleted while its thread was loaded', () => {
    const archive = archiveOf(conv('b'));
    const result = captureThread(state(archive, 'a', [msg('m1', 'orphan')]), { now: NOW });
    expect(result.skipped).toBe('conversation-absent');
    expect(result.archive.conversations.map((c) => c.id)).toEqual(['b']);
  });

  it('never writes the thread into a conversation it did not come from', () => {
    const archive = archiveOf(conv('a', [msg('a1', 'a text')]), conv('b', [msg('b1', 'b text')]));
    const result = captureThread(state(archive, 'a', [msg('a1', 'a text'), msg('a2', 'more')]), { now: NOW });
    expect(findConversation(result.archive, 'b')!.messages).toEqual([msg('b1', 'b text')]);
    expect(findConversation(result.archive, 'a')!.messages).toHaveLength(2);
  });
});

describe('captureThread only reports a change when there is one', () => {
  it('is a no-op for an unchanged conversation', () => {
    // Title already matches what the thread derives, so nothing at all is outstanding.
    const messages = [msg('m1', 'hello')];
    const archive = archiveOf(conv('a', messages, { title: 'hello' }));
    const result = captureThread(state(archive, 'a', messages), { now: NOW });
    expect(result.changed).toBe(false);
    expect(result.skipped).toBe('unchanged');
    expect(result.archive).toBe(archive);
  });

  it('leaves updatedAt alone when only the title changed', () => {
    // Ordering is user-visible; a derived title settling must not reorder the sidebar.
    const messages = [msg('m1', 'Explain closures')];
    const archive = archiveOf(conv('a', messages));
    const result = captureThread(state(archive, 'a', messages), { now: NOW });
    expect(result.changed).toBe(true);
    expect(findConversation(result.archive, 'a')!.title).toBe('Explain closures');
    expect(findConversation(result.archive, 'a')!.updatedAt).toBe(NOW - 1000);
  });

  it('advances updatedAt when messages change', () => {
    const archive = archiveOf(conv('a', [msg('m1', 'hi')]));
    const result = captureThread(state(archive, 'a', [msg('m1', 'hi'), msg('m2', 'again')]), { now: NOW });
    expect(findConversation(result.archive, 'a')!.updatedAt).toBe(NOW);
  });

  it('detects a replaced turn even when the count is unchanged', () => {
    // A stable first user turn, so the derived title cannot be what makes this look changed.
    const first = msg('m1', 'Question');
    const archive = archiveOf(conv('a', [first, msg('m2', 'partial', 'assistant')], { title: 'Question' }));
    const result = captureThread(
      state(archive, 'a', [first, msg('m2', 'the complete answer', 'assistant')]),
      { now: NOW },
    );
    expect(result.changed).toBe(true);
  });
});

describe('the archive never aliases the UI message objects', () => {
  it('sees a flag mutated in place after a capture', () => {
    // Pinning does `msg.pinned = true` on the object and reassigns the array only to re-render.
    // If the archive held that same object the edit would already be "stored", so the change
    // would never be detected and the pin would revert on restart.
    const first = msg('m1', 'Question');
    const thread = [first, msg('m2', 'answer', 'assistant')];
    const archive = archiveOf(conv('a', [], { title: 'Question' }));
    const captured = captureThread(state(archive, 'a', thread), { now: NOW });
    expect(captured.changed).toBe(true);

    (thread[1] as any).pinned = true;
    const second = captureThread(
      { archive: captured.archive, thread: { loadedFor: 'a', messages: [...thread] } },
      { now: NOW + 1 },
    );
    expect(second.changed).toBe(true);
    expect(findConversation(second.archive, 'a')!.messages[1].pinned).toBe(true);
  });

  it('does not let an in-place edit reach the archive without a capture', () => {
    const thread = [msg('m1', 'Question'), msg('m2', 'answer', 'assistant')];
    const archive = archiveOf(conv('a', [], { title: 'Question' }));
    const captured = captureThread(state(archive, 'a', thread), { now: NOW });

    (thread[1] as any).condensed = true;
    expect(findConversation(captured.archive, 'a')!.messages[1].condensed).toBeUndefined();
  });

  it('does not let a selected thread be edited into the archive', () => {
    const archive = archiveOf(conv('a'), conv('b', [msg('b1', 'stored')]));
    const result = selectConversation(state(archive, 'a', []), 'b', { now: NOW });
    (result.thread.messages[0] as any).pinned = true;
    expect(findConversation(result.archive, 'b')!.messages[0].pinned).toBeUndefined();
  });

  it('does not let a thread loaded by deletion be edited into the archive', () => {
    const archive = archiveOf(conv('a'), conv('b', [msg('b1', 'stored')]));
    const result = deleteConversation(state(archive, 'a', []), 'a', { now: NOW });
    (result.thread.messages[0] as any).pinned = true;
    expect(findConversation(result.archive, 'b')!.messages[0].pinned).toBeUndefined();
  });

  it('detects an in-place edit to a thread hydrated from the archive at startup', () => {
    // The startup path reads the active conversation straight out of the opened archive. A
    // shallow array copy is not enough — `[...conversation.messages]` clones the array but
    // shares every message object, so a later pin writes into the archive without a capture and
    // change detection then compares an object with itself and reports no change. `adoptThread`
    // snapshots for exactly this reason; this pins the behaviour it depends on.
    const stored = [msg('m1', 'Question'), msg('m2', 'answer', 'assistant')];
    const archive = archiveOf(conv('a', stored, { title: 'Question' }));

    const hydrated = snapshotMessages(findConversation(archive, 'a')!.messages);
    (hydrated[1] as any).pinned = true;

    // The archive is untouched until a capture says so.
    expect(findConversation(archive, 'a')!.messages[1].pinned).toBeUndefined();

    const captured = captureThread(state(archive, 'a', hydrated), { now: NOW + 1 });
    expect(captured.changed).toBe(true);
    expect(findConversation(captured.archive, 'a')!.messages[1].pinned).toBe(true);
  });

  it('would miss that edit if the thread were only array-copied', () => {
    // Documents the hazard the snapshot removes, so a future change that drops it fails here
    // rather than silently losing pins on restart.
    const stored = [msg('m1', 'Question'), msg('m2', 'answer', 'assistant')];
    const archive = archiveOf(conv('a', stored, { title: 'Question' }));

    const aliased = [...findConversation(archive, 'a')!.messages];
    (aliased[1] as any).pinned = true;

    // The edit reached the archive without any capture: the ownership guard was bypassed.
    expect(findConversation(archive, 'a')!.messages[1].pinned).toBe(true);
    expect(captureThread(state(archive, 'a', aliased), { now: NOW + 1 }).changed).toBe(false);
  });

  it('still reports no change when nothing was actually edited', () => {
    const thread = [msg('m1', 'Question')];
    const archive = archiveOf(conv('a', snapshotMessages(thread), { title: 'Question' }));
    const result = captureThread(state(archive, 'a', thread), { now: NOW });
    expect(result.changed).toBe(false);
  });
});

describe('ensureMessageIds', () => {
  const mint = (i: number) => `minted-${i}`;

  it('stamps an id onto a turn created without one', () => {
    // The UI creates the user turn, the injected web-context pair, and the summary with no id.
    // The storage layer counts a minted id as a repair and refuses the whole archive, so a
    // single id-less turn would stop every future save.
    const result = ensureMessageIds([{ role: 'user', content: 'hi' } as any], mint);
    expect(result.changed).toBe(true);
    expect(result.messages[0].id).toBe('minted-0');
  });

  it('leaves existing ids alone', () => {
    const messages = [msg('keep-me', 'hi')];
    const result = ensureMessageIds(messages, mint);
    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('is idempotent', () => {
    const once = ensureMessageIds([{ role: 'user', content: 'hi' } as any], mint);
    const twice = ensureMessageIds(once.messages, mint);
    expect(twice.changed).toBe(false);
    expect(twice.messages).toBe(once.messages);
  });

  it('does not disturb the assistant id the streaming path looks up', () => {
    const assistant = msg('asst-123', 'streaming', 'assistant');
    const result = ensureMessageIds([{ role: 'user', content: 'hi' } as any, assistant], mint);
    expect(result.messages[1].id).toBe('asst-123');
  });

  it('resolves a duplicate id rather than storing two turns that claim to be the same', () => {
    const result = ensureMessageIds([msg('dup', 'a'), msg('dup', 'b')], mint);
    expect(result.messages[0].id).toBe('dup');
    expect(result.messages[1].id).not.toBe('dup');
  });

  it('does not collide a minted id with an existing one', () => {
    const result = ensureMessageIds(
      [msg('minted-1', 'existing'), { role: 'user', content: 'new' } as any],
      mint,
    );
    expect(result.messages[1].id).not.toBe('minted-1');
  });
});

describe('captureThread and titles', () => {
  it('derives a title from the first user turn', () => {
    const archive = archiveOf(conv('a'));
    const result = captureThread(state(archive, 'a', [msg('m1', 'How do I use Flint?')]), { now: NOW });
    expect(findConversation(result.archive, 'a')!.title).toBe('How do I use Flint?');
  });

  it('never overwrites a pinned title', () => {
    const archive = archiveOf(conv('a', [], { title: 'Budget planning', titlePinned: true }));
    const result = captureThread(state(archive, 'a', [msg('m1', 'unrelated opening line')]), { now: NOW });
    expect(findConversation(result.archive, 'a')!.title).toBe('Budget planning');
  });

  it('never overwrites a recovery label', () => {
    const archive = archiveOf(conv('a', [], { title: 'Recovered chat — earlier session', recovered: true }));
    const result = captureThread(state(archive, 'a', [msg('m1', 'new opening line')]), { now: NOW });
    expect(findConversation(result.archive, 'a')!.title).toBe('Recovered chat — earlier session');
  });
});

describe('captureThread and settings', () => {
  it('leaves stored settings untouched when no patch is given', () => {
    const archive = archiveOf(conv('a', [], { settings: { modelAlias: 'phi-4', custom: 1 } }));
    const result = captureThread(state(archive, 'a', [msg('m1', 'hi')]), { now: NOW });
    expect(findConversation(result.archive, 'a')!.settings).toEqual({ modelAlias: 'phi-4', custom: 1 });
  });

  it('merges a patch without discarding unknown keys', () => {
    const archive = archiveOf(conv('a', [], { settings: { modelAlias: 'phi-4', fromNewerBuild: 'keep' } }));
    const result = captureThread(state(archive, 'a', []), {
      now: NOW,
      settings: { modelAlias: 'qwen3-0.6b' },
    });
    expect(findConversation(result.archive, 'a')!.settings).toEqual({
      modelAlias: 'qwen3-0.6b',
      fromNewerBuild: 'keep',
    });
  });

  it('reports a settings-only change so it is persisted', () => {
    const messages = [msg('m1', 'hi')];
    const archive = archiveOf(conv('a', messages, { title: 'hi' }));
    const result = captureThread(state(archive, 'a', messages), {
      now: NOW,
      settings: { contextTurns: 12 },
    });
    expect(result.changed).toBe(true);
    expect(findConversation(result.archive, 'a')!.settings).toEqual({ contextTurns: 12 });
  });

  it('removes the bag rather than storing an empty object', () => {
    const archive = archiveOf(conv('a', [], { settings: { modelAlias: 'phi-4' } }));
    const result = captureThread(state(archive, 'a', []), {
      now: NOW,
      settings: { modelAlias: undefined },
    });
    const stored = findConversation(result.archive, 'a')!;
    expect('settings' in stored).toBe(false);
  });
});

describe('selectConversation preserves the outgoing thread', () => {
  it('stores the outgoing thread before loading the target', () => {
    // This is the regression the whole workstream exists for: the old sidebar blanked the
    // thread on switch and the messages were simply gone.
    const archive = archiveOf(conv('a'), conv('b', [msg('b1', 'stored b')]));
    const typed = [msg('a1', 'typed into a'), msg('a2', 'and more')];
    const result = selectConversation(state(archive, 'a', typed), 'b', { now: NOW });

    expect(findConversation(result.archive, 'a')!.messages).toHaveLength(2);
    expect(result.thread.loadedFor).toBe('b');
    expect(result.thread.messages).toEqual([msg('b1', 'stored b')]);
  });

  it('loads the target conversation messages rather than blanking', () => {
    const archive = archiveOf(conv('a'), conv('b', [msg('b1', 'earlier'), msg('b2', 'later')]));
    const result = selectConversation(state(archive, 'a', []), 'b', { now: NOW });
    expect(result.thread.messages).toHaveLength(2);
  });

  it('gives the UI its own array so appending cannot mutate the archive', () => {
    const archive = archiveOf(conv('a'), conv('b', [msg('b1', 'stored')]));
    const result = selectConversation(state(archive, 'a', []), 'b', { now: NOW });
    result.thread.messages.push(msg('b2', 'appended in the UI'));
    expect(findConversation(result.archive, 'b')!.messages).toHaveLength(1);
  });

  it('moves activeId to the target', () => {
    const archive = archiveOf(conv('a'), conv('b'));
    const result = selectConversation(state(archive, 'a', []), 'b', { now: NOW });
    expect(result.archive.activeId).toBe('b');
  });

  it('applies the target conversation settings', () => {
    const archive = archiveOf(conv('a'), conv('b', [], { settings: { modelAlias: 'phi-4', contextTurns: 6 } }));
    const result = selectConversation(state(archive, 'a', []), 'b', { now: NOW });
    expect(result.settings).toEqual({ modelAlias: 'phi-4', contextTurns: 6 });
  });

  it('reports absent settings as empty so the app defaults apply', () => {
    const archive = archiveOf(conv('a'), conv('b'));
    const result = selectConversation(state(archive, 'a', []), 'b', { now: NOW });
    expect(result.settings).toEqual({});
  });

  it('leaves the thread alone when the target does not exist', () => {
    const archive = archiveOf(conv('a'));
    const typed = [msg('a1', 'still being written')];
    const result = selectConversation(state(archive, 'a', typed), 'ghost', { now: NOW });
    expect(result.thread.messages).toBe(typed);
    expect(result.conversation).toBeNull();
    expect(result.changed).toBe(false);
  });

  it('does not roll back the loaded thread when reselecting the current conversation', () => {
    // The loaded copy is newer than the stored one while a turn is streaming.
    const archive = archiveOf(conv('a', [msg('a1', 'stored')]));
    const inFlight = [msg('a1', 'stored'), msg('a2', 'streaming right now')];
    const result = selectConversation(state(archive, 'a', inFlight), 'a', { now: NOW });
    expect(result.thread.messages).toBe(inFlight);
    expect(findConversation(result.archive, 'a')!.messages).toHaveLength(2);
  });
});

describe('createConversation', () => {
  it('stores the outgoing thread before starting a new one', () => {
    const archive = archiveOf(conv('a'));
    const result = createConversation(state(archive, 'a', [msg('a1', 'do not lose me')]), {
      id: 'new',
      now: NOW,
    });
    expect(findConversation(result.archive, 'a')!.messages).toHaveLength(1);
  });

  it('selects the new conversation with an empty loaded thread', () => {
    const archive = archiveOf(conv('a'));
    const result = createConversation(state(archive, 'a', []), { id: 'new', now: NOW });
    expect(result.archive.activeId).toBe('new');
    expect(result.thread).toEqual({ loadedFor: 'new', messages: [] });
  });

  it('seeds settings on the new conversation, not the outgoing one', () => {
    const archive = archiveOf(conv('a', [], { settings: { modelAlias: 'old-model' } }));
    const result = createConversation(state(archive, 'a', []), {
      id: 'new',
      now: NOW,
      settings: { modelAlias: 'new-model' },
    });
    expect(findConversation(result.archive, 'a')!.settings).toEqual({ modelAlias: 'old-model' });
    expect(findConversation(result.archive, 'new')!.settings).toEqual({ modelAlias: 'new-model' });
  });

  it('works from a completely empty archive', () => {
    const archive = archiveOf();
    const result = createConversation(state(archive, null, []), { id: 'first', now: NOW });
    expect(result.archive.conversations).toHaveLength(1);
    expect(result.archive.activeId).toBe('first');
  });

  it('refuses to reuse an id already in the archive', () => {
    // Two records sharing an id is not cosmetic: capture resolves to the first match, so the
    // new empty thread would overwrite the existing conversation's history.
    const archive = archiveOf(conv('a', [msg('m1', 'existing history')]));
    const result = createConversation(state(archive, null, []), { id: 'a', now: NOW });
    expect(result.idAdjusted).toBe(true);
    expect(result.conversation.id).not.toBe('a');
    expect(findConversation(result.archive, 'a')!.messages).toHaveLength(1);
  });

  it('does not blank the existing conversation when its id is reused', () => {
    const archive = archiveOf(conv('a', [msg('m1', 'keep me')]));
    const created = createConversation(state(archive, null, []), { id: 'a', now: NOW });
    const captured = captureThread(
      { archive: created.archive, thread: created.thread },
      { now: NOW + 1 },
    );
    expect(findConversation(captured.archive, 'a')!.messages).toHaveLength(1);
  });
});

describe('deleteConversation', () => {
  it('removes the conversation', () => {
    const archive = archiveOf(conv('a'), conv('b'));
    const result = deleteConversation(state(archive, 'a', []), 'b', { now: NOW });
    expect(result.removed).toBe(true);
    expect(result.archive.conversations.map((c) => c.id)).toEqual(['a']);
  });

  it('captures the loaded thread when deleting a different conversation', () => {
    // Otherwise turns typed since the last autosave vanish along with an unrelated record.
    const archive = archiveOf(conv('a'), conv('b'));
    const result = deleteConversation(state(archive, 'a', [msg('a1', 'unsaved')]), 'b', { now: NOW });
    expect(findConversation(result.archive, 'a')!.messages).toHaveLength(1);
  });

  it('loads the next conversation when the active one is deleted', () => {
    const archive = archiveOf(conv('a'), conv('b', [msg('b1', 'b content')]), conv('c'));
    const result = deleteConversation(state(archive, 'a', []), 'a', { now: NOW });
    expect(result.archive.activeId).toBe('b');
    expect(result.thread).toEqual({ loadedFor: 'b', messages: [msg('b1', 'b content')] });
  });

  it('falls back to the previous conversation when the last one is deleted', () => {
    const archive = archiveOf(conv('a'), conv('b'));
    const result = deleteConversation(state(archive, 'b', []), 'b', { now: NOW });
    expect(result.archive.activeId).toBe('a');
  });

  it('leaves the archive empty and the thread unloaded when the only conversation goes', () => {
    const archive = archiveOf(conv('a'));
    const result = deleteConversation(state(archive, 'a', [msg('a1', 'x')]), 'a', { now: NOW });
    expect(result.archive.conversations).toEqual([]);
    expect(result.archive.activeId).toBeNull();
    expect(result.thread).toEqual(EMPTY_THREAD);
  });

  it('does not store the deleted conversation thread back', () => {
    const archive = archiveOf(conv('a'), conv('b'));
    const result = deleteConversation(state(archive, 'a', [msg('a1', 'x')]), 'a', { now: NOW });
    expect(result.archive.conversations.map((c) => c.id)).toEqual(['b']);
  });

  it('is a no-op for an unknown id', () => {
    const archive = archiveOf(conv('a'));
    const result = deleteConversation(state(archive, 'a', []), 'ghost', { now: NOW });
    expect(result.removed).toBe(false);
    expect(result.archive.conversations).toHaveLength(1);
  });
});

describe('renameConversationInSession', () => {
  it('pins a human-chosen title', () => {
    const archive = archiveOf(conv('a', [msg('m1', 'derived source')]));
    const result = renameConversationInSession(state(archive, 'a', []), 'a', 'Quarterly notes', { now: NOW });
    const stored = findConversation(result.archive, 'a')!;
    expect(stored.title).toBe('Quarterly notes');
    expect(stored.titlePinned).toBe(true);
  });

  it('survives a later capture', () => {
    const archive = archiveOf(conv('a'));
    const renamed = renameConversationInSession(state(archive, 'a', []), 'a', 'Kept', { now: NOW });
    const captured = captureThread(
      { archive: renamed.archive, thread: { loadedFor: 'a', messages: [msg('m1', 'a different opening')] } },
      { now: NOW },
    );
    expect(findConversation(captured.archive, 'a')!.title).toBe('Kept');
  });

  it('renames a conversation whose thread is not loaded', () => {
    const archive = archiveOf(conv('a'), conv('b'));
    const result = renameConversationInSession(state(archive, 'a', []), 'b', 'Renamed from sidebar', { now: NOW });
    expect(findConversation(result.archive, 'b')!.title).toBe('Renamed from sidebar');
  });

  it('clearing the name unpins and re-derives', () => {
    const archive = archiveOf(conv('a', [msg('m1', 'Original question')], { title: 'Pinned', titlePinned: true }));
    const result = renameConversationInSession(state(archive, 'a', []), 'a', '   ', { now: NOW });
    const stored = findConversation(result.archive, 'a')!;
    expect(stored.titlePinned).toBeUndefined();
    expect(stored.title).toBe('Original question');
  });

  it('is a no-op for an unknown id', () => {
    const archive = archiveOf(conv('a'));
    const result = renameConversationInSession(state(archive, 'a', []), 'ghost', 'x', { now: NOW });
    expect(result.changed).toBe(false);
    expect(result.archive).toBe(archive);
  });
});

describe('summarizeConversations', () => {
  it('counts stored messages', () => {
    const archive = archiveOf(conv('a', [msg('m1', 'x'), msg('m2', 'y')]));
    expect(summarizeConversations(archive)[0].messageCount).toBe(2);
  });

  it('counts the loaded thread for the active row so the count does not lag', () => {
    const archive = archiveOf(conv('a', [msg('m1', 'x')]));
    const rows = summarizeConversations(archive, { loadedFor: 'a', messages: [msg('m1', 'x'), msg('m2', 'y')] });
    expect(rows[0].messageCount).toBe(2);
  });

  it('reports the claimed count for a legacy conversation whose turns were never stored', () => {
    // Showing "0 messages" for a chat the user remembers writing reads as deletion.
    const archive = archiveOf(conv('a', [], { messagesUnavailable: true, unavailableMessageCount: 14 }));
    const row = summarizeConversations(archive)[0];
    expect(row.messagesUnavailable).toBe(true);
    expect(row.unavailableMessageCount).toBe(14);
    expect(row.messageCount).toBe(0);
  });

  it('flags a recovered conversation', () => {
    const archive = archiveOf(conv('a', [], { recovered: true }));
    expect(summarizeConversations(archive)[0].recovered).toBe(true);
  });

  it('omits the flags for an ordinary conversation', () => {
    const archive = archiveOf(conv('a'));
    const row = summarizeConversations(archive)[0];
    expect(row.recovered).toBeUndefined();
    expect(row.messagesUnavailable).toBeUndefined();
  });
});

describe('a full session sequence never loses a thread', () => {
  it('survives create, type, switch, type, switch back', () => {
    let s: SessionState = state(archiveOf(), null, []);

    const first = createConversation(s, { id: 'c1', now: NOW });
    s = { archive: first.archive, thread: first.thread };

    s = { ...s, thread: { loadedFor: 'c1', messages: [msg('m1', 'first conversation')] } };

    const second = createConversation(s, { id: 'c2', now: NOW + 1 });
    s = { archive: second.archive, thread: second.thread };

    s = { ...s, thread: { loadedFor: 'c2', messages: [msg('m2', 'second conversation')] } };

    const back = selectConversation(s, 'c1', { now: NOW + 2 });
    s = { archive: back.archive, thread: back.thread };

    expect(s.thread.messages).toEqual([msg('m1', 'first conversation')]);
    expect(findConversation(s.archive, 'c2')!.messages).toEqual([msg('m2', 'second conversation')]);

    const forward = selectConversation(s, 'c2', { now: NOW + 3 });
    expect(forward.thread.messages).toEqual([msg('m2', 'second conversation')]);
  });
});

describe('the session survives the real storage boundary', () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      map,
    };
  }

  it('saves a thread built the way the UI builds it', () => {
    // The UI creates the user turn with no id at all. Left alone, the storage layer counts the
    // minted id as a repair and refuses the entire archive, so persistence would silently stop
    // working the first time anyone sent a message.
    const storage = memoryStorage();
    const created = createConversation(state(archiveOf(), null, []), { id: 'c1', now: NOW });

    const uiMessages = [
      { role: 'user', content: 'What is Flint?' },
      { role: 'assistant', content: 'A desktop control plane.', id: 'asst-1' },
    ] as any[];
    const stamped = ensureMessageIds(uiMessages, (i) => `m-${i}`);

    const captured = captureThread(
      { archive: created.archive, thread: { loadedFor: 'c1', messages: stamped.messages } },
      { now: NOW },
    );
    const saved = saveConversationArchive(storage, captured.archive);
    expect(saved.error).toBeNull();
    expect(saved.ok).toBe(true);
  });

  it('round-trips a switch through storage without losing either thread', () => {
    const storage = memoryStorage();
    let s: SessionState = state(archiveOf(), null, []);

    const first = createConversation(s, { id: 'c1', now: NOW });
    s = { archive: first.archive, thread: first.thread };
    s = {
      ...s,
      thread: {
        loadedFor: 'c1',
        messages: ensureMessageIds(
          [{ role: 'user', content: 'first thread' }] as any,
          (i) => `a-${i}`,
        ).messages,
      },
    };

    const second = createConversation(s, { id: 'c2', now: NOW + 1 });
    s = { archive: second.archive, thread: second.thread };
    s = {
      ...s,
      thread: {
        loadedFor: 'c2',
        messages: ensureMessageIds(
          [{ role: 'user', content: 'second thread' }] as any,
          (i) => `b-${i}`,
        ).messages,
      },
    };

    const captured = captureThread(s, { now: NOW + 2 });
    expect(saveConversationArchive(storage, captured.archive).ok).toBe(true);

    const reopened = openConversationArchive({
      storage,
      appVersion: '99.0.0',
      now: NOW + 3,
    });
    expect(reopened.writable).toBe(true);
    const c1 = findConversation(reopened.archive, 'c1')!;
    const c2 = findConversation(reopened.archive, 'c2')!;
    expect(contentToText(c1.messages[0].content)).toBe('first thread');
    expect(contentToText(c2.messages[0].content)).toBe('second thread');
  });

  it('saves a conversation carrying pinned and condensed flags', () => {
    const storage = memoryStorage();
    const thread = ensureMessageIds(
      [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ] as any,
      (i) => `m-${i}`,
    ).messages;
    const created = createConversation(state(archiveOf(), null, []), { id: 'c1', now: NOW });
    const captured = captureThread(
      { archive: created.archive, thread: { loadedFor: 'c1', messages: thread } },
      { now: NOW },
    );

    (thread[0] as any).pinned = true;
    (thread[1] as any).condensed = true;
    const second = captureThread(
      { archive: captured.archive, thread: { loadedFor: 'c1', messages: [...thread] } },
      { now: NOW + 1 },
    );
    expect(second.changed).toBe(true);
    expect(saveConversationArchive(storage, second.archive).ok).toBe(true);

    const reopened = openConversationArchive({ storage, appVersion: '99.0.0', now: NOW + 2 });
    const stored = findConversation(reopened.archive, 'c1')!;
    expect(stored.messages[0].pinned).toBe(true);
    expect(stored.messages[1].condensed).toBe(true);
  });
});
