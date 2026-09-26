import { describe, it, expect } from 'vitest';
import {
  parsePersistedState,
  readPersistedTheme,
  mayEnableAutosave,
  parsePersistedConversations
} from './chat-persistence';

describe('parsePersistedState', () => {
  it('reports nothing to restore for an absent value', () => {
    for (const raw of [null, undefined, '']) {
      expect(parsePersistedState(raw)).toEqual({ data: null, corrupt: false });
    }
  });

  it('returns the object for a valid blob', () => {
    const result = parsePersistedState('{"selectedModelAlias":"qwen3-0.6b","networkPort":6123}');
    expect(result.corrupt).toBe(false);
    expect(result.data).toEqual({ selectedModelAlias: 'qwen3-0.6b', networkPort: 6123 });
  });

  it('flags unparseable JSON as corrupt', () => {
    expect(parsePersistedState('{not json')).toEqual({ data: null, corrupt: true });
  });

  it.each([
    ['null literal', 'null'],
    ['array root', '[1,2,3]'],
    ['string root', '"hello"'],
    ['number root', '42']
  ])('flags a valid-JSON but non-object root as corrupt (%s)', (_label, raw) => {
    expect(parsePersistedState(raw)).toEqual({ data: null, corrupt: true });
  });
});

describe('readPersistedTheme', () => {
  it('reads a stored theme', () => {
    expect(readPersistedTheme('{"theme":"light"}')).toBe('light');
    expect(readPersistedTheme('{"theme":"dark"}')).toBe('dark');
  });

  it('ignores unknown, missing and corrupt themes', () => {
    expect(readPersistedTheme('{"theme":"neon"}')).toBeNull();
    expect(readPersistedTheme('{}')).toBeNull();
    expect(readPersistedTheme('null')).toBeNull();
    expect(readPersistedTheme('{broken')).toBeNull();
  });
});

describe('mayEnableAutosave', () => {
  it('allows autosave whenever the blob was usable', () => {
    expect(mayEnableAutosave({ data: {}, corrupt: false }, false)).toBe(true);
    expect(mayEnableAutosave({ data: null, corrupt: false }, false)).toBe(true);
  });

  it('allows autosave after a corrupt blob was backed up', () => {
    expect(mayEnableAutosave({ data: null, corrupt: true }, true)).toBe(true);
  });

  it('keeps autosave off when a corrupt blob could not be backed up', () => {
    // Otherwise the first default-state write destroys the only copy of the user's data.
    expect(mayEnableAutosave({ data: null, corrupt: true }, false)).toBe(false);
  });
});

describe('parsePersistedConversations', () => {
  it('reports nothing to restore for an absent value', () => {
    for (const raw of [null, undefined, '']) {
      expect(parsePersistedConversations(raw)).toEqual({ data: null, corrupt: false });
    }
  });

  it('returns the list for a valid index', () => {
    const raw = '[{"id":"chat-1","title":"Hi","createdAt":1,"messageCount":2}]';
    expect(parsePersistedConversations(raw)).toEqual({
      data: [{ id: 'chat-1', title: 'Hi', createdAt: 1, messageCount: 2 }],
      corrupt: false
    });
  });

  it('flags unparseable JSON as corrupt', () => {
    expect(parsePersistedConversations('[{')).toEqual({ data: null, corrupt: true });
  });

  it.each([
    ['object root', '{"id":"chat-1"}'],
    ['null literal', 'null'],
    ['string root', '"chat-1"']
  ])('flags a non-array root as corrupt (%s)', (_label, raw) => {
    // The app calls .filter/.find on this value, so a non-array must not be treated as empty.
    expect(parsePersistedConversations(raw)).toEqual({ data: null, corrupt: true });
  });

  it('keeps usable entries and flags the list when some were dropped', () => {
    const result = parsePersistedConversations('[{"id":"chat-1"},null,{"title":"no id"},{"id":""}]');
    expect(result.data).toEqual([{ id: 'chat-1' }]);
    expect(result.corrupt).toBe(true);
  });
});
