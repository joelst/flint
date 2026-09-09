import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  appSettingDefaultsToPersisted,
  readAppSettingDefaults,
  resolveConversationSettings,
  seedSettingsFor,
  type AppSettingDefaults,
} from './conversation-settings';

const baseline: AppSettingDefaults = {
  modelAlias: 'phi-4-mini',
  systemPrompt: 'You are terse.',
  contextTurns: 8,
  showFullHistory: false,
};

describe('readAppSettingDefaults', () => {
  it('falls back entirely when the blob is not an object', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      expect(readAppSettingDefaults(raw, baseline)).toEqual(baseline);
    }
  });

  it('reads the persisted key names, not the field names', () => {
    const read = readAppSettingDefaults(
      { selectedModelAlias: 'qwen3-0.6b', systemPrompt: 'hi', contextTurns: 20, showFullHistory: true },
      baseline,
    );
    expect(read).toEqual({
      modelAlias: 'qwen3-0.6b',
      systemPrompt: 'hi',
      contextTurns: 20,
      showFullHistory: true,
    });
  });

  it('keeps a stored empty alias and a stored false rather than treating them as absent', () => {
    // The obvious `||` implementation discards both, silently reinstating a model the user
    // cleared and a full-thread view they turned off.
    const read = readAppSettingDefaults({ selectedModelAlias: '', showFullHistory: false }, {
      ...baseline,
      showFullHistory: true,
    });
    expect(read.modelAlias).toBe('');
    expect(read.showFullHistory).toBe(false);
  });

  it('rejects a context length the app would refuse to apply', () => {
    for (const turns of [0, -4, 12.5, '12', NaN]) {
      expect(readAppSettingDefaults({ contextTurns: turns }, baseline).contextTurns).toBe(8);
    }
  });

  it('rejects wrongly typed strings and booleans instead of coercing them', () => {
    const read = readAppSettingDefaults(
      { selectedModelAlias: 7, systemPrompt: { a: 1 }, showFullHistory: 'yes' },
      baseline,
    );
    expect(read).toEqual(baseline);
  });

  it('uses the shipped defaults when no fallback is given', () => {
    expect(readAppSettingDefaults(null)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('round-trips through the persisted projection', () => {
    // The alias is excluded from the projection on purpose: the component keeps writing
    // `selectedModelAlias` itself as the last model used. Reading it back as the baseline is
    // still correct, so only the write side omits it.
    const persisted = appSettingDefaultsToPersisted(baseline);
    expect('selectedModelAlias' in persisted).toBe(false);
    expect(readAppSettingDefaults({ ...persisted, selectedModelAlias: baseline.modelAlias })).toEqual(
      baseline,
    );
  });
});

describe('resolveConversationSettings', () => {
  it('inherits every key when the bag is absent', () => {
    const resolved = resolveConversationSettings(undefined, baseline);
    expect(resolved.effective).toEqual(baseline);
    expect(resolved.fromDefault.sort()).toEqual([
      'contextTurns',
      'modelAlias',
      'showFullHistory',
      'systemPrompt',
    ]);
  });

  it('prefers a stored value over the baseline, key by key', () => {
    const resolved = resolveConversationSettings({ systemPrompt: 'You are a poet.' }, baseline);
    expect(resolved.effective.systemPrompt).toBe('You are a poet.');
    expect(resolved.effective.modelAlias).toBe('phi-4-mini');
    expect(resolved.fromDefault).not.toContain('systemPrompt');
    expect(resolved.fromDefault).toContain('modelAlias');
  });

  it('reads a stored empty alias as absent, matching what the seeder writes', () => {
    const resolved = resolveConversationSettings({ modelAlias: '' }, baseline);
    // Inherit rather than resolve to '': the caller does not blank the picker on an empty
    // resolution, so an empty override would silently leave the previous chat's model selected.
    expect(resolved.effective.modelAlias).toBe('phi-4-mini');
    expect(resolved.fromDefault).toContain('modelAlias');
    expect(resolved.invalidKeys).toEqual([]);
  });

  it('honours a stored false rather than reading it as absent', () => {
    const resolved = resolveConversationSettings({ showFullHistory: false }, {
      ...baseline,
      showFullHistory: true,
    });
    expect(resolved.effective.showFullHistory).toBe(false);
    expect(resolved.fromDefault).not.toContain('showFullHistory');
  });

  it('falls back for an invalid stored value and reports it', () => {
    const resolved = resolveConversationSettings({ contextTurns: 0 }, baseline);
    expect(resolved.effective.contextTurns).toBe(8);
    expect(resolved.invalidKeys).toEqual(['contextTurns']);
    // Reported as inherited, because that is what the chat will actually use.
    expect(resolved.fromDefault).toContain('contextTurns');
  });

  it('ignores unknown keys without disturbing resolution', () => {
    const resolved = resolveConversationSettings(
      { systemPrompt: 'x', somethingNewerBuildsUse: { deep: true } },
      baseline,
    );
    expect(resolved.effective.systemPrompt).toBe('x');
    expect(resolved.invalidKeys).toEqual([]);
  });

  it('does not mutate the baseline it resolved against', () => {
    const defaults = { ...baseline };
    resolveConversationSettings({ systemPrompt: 'changed', contextTurns: 30 }, defaults);
    expect(defaults).toEqual(baseline);
  });
});

describe('seedSettingsFor', () => {
  it('stamps explicit values so a new chat never depends on the baseline', () => {
    expect(seedSettingsFor(baseline)).toEqual({
      modelAlias: 'phi-4-mini',
      systemPrompt: 'You are terse.',
      contextTurns: 8,
      showFullHistory: false,
    });
  });

  it('leaves an empty alias absent rather than recording "explicitly no model"', () => {
    // Otherwise the component's auto-selection, which is a runtime fallback and not a stored
    // choice, would be overridden every time the conversation is reselected.
    const seed = seedSettingsFor({ ...baseline, modelAlias: '' });
    expect('modelAlias' in seed).toBe(false);
  });

  it('lets an explicit override win over the inherited value', () => {
    // The model-card flow chooses the model before the conversation exists.
    const seed = seedSettingsFor(baseline, { modelAlias: 'qwen3-4b' });
    expect(seed.modelAlias).toBe('qwen3-4b');
    expect(seed.systemPrompt).toBe('You are terse.');
  });

  it('can override even when the inherited alias is empty', () => {
    const seed = seedSettingsFor({ ...baseline, modelAlias: '' }, { modelAlias: 'qwen3-4b' });
    expect(seed.modelAlias).toBe('qwen3-4b');
  });
});
