import { describe, it, expect } from 'vitest';
import {
  resolveConversationTitle,
  applyConversationTitle,
  renameConversation,
  DEFAULT_CONVERSATION_TITLE,
} from './conversation-title';
import type { StoredConversation, StoredMessage } from './conversation-store';

function msg(role: string, text: string): StoredMessage {
  return { id: `${role}-1`, role, content: text };
}

function conversation(over: Partial<StoredConversation> = {}): StoredConversation {
  return {
    id: 'c1',
    title: 'Existing title',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    ...over,
  };
}

describe('resolveConversationTitle', () => {
  it('derives from the first user turn', () => {
    const d = resolveConversationTitle({
      current: 'New chat',
      messages: [msg('system', 'ignored'), msg('user', 'How do I load a model?')],
    });
    expect(d).toEqual({ title: 'How do I load a model?', changed: true, reason: 'derived' });
  });

  it('reports no change when the derived title already matches', () => {
    const d = resolveConversationTitle({ current: 'Hello', messages: [msg('user', 'Hello')] });
    expect(d.changed).toBe(false);
    expect(d.reason).toBe('derived');
  });

  it('keeps a later derived title as the first turn changes', () => {
    // A derived title may freely replace another derived title.
    const d = resolveConversationTitle({ current: 'Old', messages: [msg('user', 'New')] });
    expect(d.title).toBe('New');
  });

  describe('when there is nothing to derive from', () => {
    it('keeps an existing title rather than renaming to the fallback', () => {
      // The regression that renamed every conversation to "New chat" on switch: an unloaded
      // thread is an absence of evidence, not evidence the conversation is untitled.
      const d = resolveConversationTitle({ current: 'Quarterly planning', messages: [] });
      expect(d).toEqual({ title: 'Quarterly planning', changed: false, reason: 'no-source' });
    });

    it('keeps the title when only non-user turns are present', () => {
      const d = resolveConversationTitle({
        current: 'Quarterly planning',
        messages: [msg('assistant', 'Sure!'), msg('system', 'Be brief')],
      });
      expect(d.title).toBe('Quarterly planning');
      expect(d.reason).toBe('no-source');
    });

    it('keeps the title when the user turn has no extractable text', () => {
      const d = resolveConversationTitle({
        current: 'Screenshot review',
        messages: [{ id: 'm', role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:,' } }] }],
      });
      expect(d.title).toBe('Screenshot review');
    });

    it('falls back only when the stored title is blank', () => {
      expect(resolveConversationTitle({ current: '', messages: [] })).toEqual({
        title: DEFAULT_CONVERSATION_TITLE,
        changed: true,
        reason: 'no-source',
      });
    });

    it('treats a whitespace-only title as blank', () => {
      const d = resolveConversationTitle({ current: '   ', messages: [] });
      expect(d.title).toBe(DEFAULT_CONVERSATION_TITLE);
      expect(d.changed).toBe(true);
    });

    it('honours a custom fallback', () => {
      const d = resolveConversationTitle({ current: '', messages: [], fallback: 'Untitled' });
      expect(d.title).toBe('Untitled');
    });
  });

  describe('protected titles', () => {
    it('never derives over a pinned title', () => {
      const d = resolveConversationTitle({
        current: 'Budget notes',
        messages: [msg('user', 'completely different text')],
        titlePinned: true,
      });
      expect(d).toEqual({ title: 'Budget notes', changed: false, reason: 'pinned' });
    });

    it('never derives over a recovery label', () => {
      const d = resolveConversationTitle({
        current: 'Recovered chat — earlier session',
        messages: [msg('user', 'hello there')],
        recovered: true,
      });
      expect(d.title).toBe('Recovered chat — earlier session');
      expect(d.reason).toBe('labelled');
    });

    it('never derives over a conversation whose messages were unavailable', () => {
      // The title is the only surviving evidence of what this conversation was.
      const d = resolveConversationTitle({
        current: 'Deployment postmortem',
        messages: [msg('user', 'unrelated new turn')],
        messagesUnavailable: true,
      });
      expect(d.title).toBe('Deployment postmortem');
      expect(d.reason).toBe('labelled');
    });

    it('prefers the pinned reason when a conversation is both pinned and labelled', () => {
      const d = resolveConversationTitle({
        current: 'Named',
        messages: [],
        titlePinned: true,
        recovered: true,
      });
      expect(d.reason).toBe('pinned');
    });

    it('still replaces a blank pinned title so the sidebar row is not empty', () => {
      const d = resolveConversationTitle({ current: '', messages: [], titlePinned: true });
      expect(d.title).toBe(DEFAULT_CONVERSATION_TITLE);
      expect(d.changed).toBe(true);
    });
  });

  it('tolerates a non-string current title', () => {
    const d = resolveConversationTitle({ current: undefined as any, messages: [] });
    expect(d.title).toBe(DEFAULT_CONVERSATION_TITLE);
  });

  it('tolerates a missing messages array', () => {
    const d = resolveConversationTitle({ current: 'Kept', messages: undefined as any });
    expect(d.title).toBe('Kept');
  });
});

describe('applyConversationTitle', () => {
  it('returns the same object when nothing changes', () => {
    const c = conversation({ title: 'Hi', messages: [msg('user', 'Hi')] });
    expect(applyConversationTitle(c)).toBe(c);
  });

  it('returns a copy with the derived title', () => {
    const c = conversation({ title: 'New chat', messages: [msg('user', 'Explain ONNX')] });
    const next = applyConversationTitle(c);
    expect(next).not.toBe(c);
    expect(next.title).toBe('Explain ONNX');
    expect(c.title).toBe('New chat');
  });

  it('leaves a pinned conversation untouched', () => {
    const c = conversation({ title: 'Mine', titlePinned: true, messages: [msg('user', 'other')] });
    expect(applyConversationTitle(c)).toBe(c);
  });

  it('leaves an unloaded conversation untouched', () => {
    const c = conversation({ title: 'Loaded elsewhere', messages: [] });
    expect(applyConversationTitle(c)).toBe(c);
  });
});

describe('renameConversation', () => {
  it('sets the title and pins it', () => {
    const next = renameConversation(conversation({ messages: [msg('user', 'derivable')] }), 'My name');
    expect(next.title).toBe('My name');
    expect(next.titlePinned).toBe(true);
  });

  it('trims the supplied name', () => {
    expect(renameConversation(conversation(), '  Spaced  ').title).toBe('Spaced');
  });

  it('does not mutate the input', () => {
    const c = conversation();
    renameConversation(c, 'Renamed');
    expect(c.title).toBe('Existing title');
    expect(c.titlePinned).toBeUndefined();
  });

  it('clearing the name unpins and returns to deriving', () => {
    const pinned = conversation({
      title: 'Manual',
      titlePinned: true,
      messages: [msg('user', 'Derived from here')],
    });
    const next = renameConversation(pinned, '   ');
    expect(next.titlePinned).toBeUndefined();
    expect(next.title).toBe('Derived from here');
  });

  it('clearing the name on an unloaded conversation keeps the existing title', () => {
    // Unpinning must not become a way to lose the title entirely.
    const next = renameConversation(conversation({ title: 'Manual', titlePinned: true }), '');
    expect(next.titlePinned).toBeUndefined();
    expect(next.title).toBe('Manual');
  });

  it('clearing the name never leaves a pinned flag behind on the copy', () => {
    const next = renameConversation(conversation({ titlePinned: true }), '');
    expect('titlePinned' in next).toBe(false);
  });

  it('treats a non-string name as clearing', () => {
    const next = renameConversation(conversation({ titlePinned: true }), null as any);
    expect(next.titlePinned).toBeUndefined();
  });
});
