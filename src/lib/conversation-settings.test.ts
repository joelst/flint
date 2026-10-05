import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  MAX_TOKENS_DEFAULT_GENERATION,
  RETIRED_DEFAULT_MAX_TOKENS,
  appSettingDefaultsToPersisted,
  migrateRetiredMaxTokens,
  readAppSettingDefaults,
  resolveConversationSettings,
  seedSettingsFor,
  startupWebToolsPatch,
  type AppSettingDefaults,
} from './conversation-settings';

const baseline: AppSettingDefaults = {
  modelAlias: 'phi-4-mini',
  systemPrompt: 'You are terse.',
  contextTurns: 8,
  showFullHistory: false,
  temperature: 0.5,
  maxTokens: 1024,
  topP: 0.9,
  topK: 40,
  frequencyPenalty: 0.2,
  presencePenalty: -0.2,
  randomSeed: 7,
  webToolsEnabled: false,
};

describe('readAppSettingDefaults', () => {
  it('falls back entirely when the blob is not an object', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      expect(readAppSettingDefaults(raw, baseline)).toEqual(baseline);
    }
  });

  it('reads the persisted key names, not the field names', () => {
    const read = readAppSettingDefaults(
      {
        selectedModelAlias: 'qwen3-0.6b', systemPrompt: 'hi', contextTurns: 20, showFullHistory: true,
        temperature: 1.1, maxTokens: 512, topP: 0.8, topK: 10,
        frequencyPenalty: 1.5, presencePenalty: -1.5, randomSeed: 42, webToolsEnabled: true,
      },
      baseline,
    );
    expect(read).toEqual({
      modelAlias: 'qwen3-0.6b',
      systemPrompt: 'hi',
      contextTurns: 20,
      showFullHistory: true,
      temperature: 1.1,
      maxTokens: 512,
      topP: 0.8,
      topK: 10,
      frequencyPenalty: 1.5,
      presencePenalty: -1.5,
      randomSeed: 42,
      webToolsEnabled: false,
    });
  });

  it('reads a stored null randomSeed as an explicit "no seed" override, not as absent', () => {
    const read = readAppSettingDefaults({ randomSeed: null }, { ...baseline, randomSeed: 99 });
    expect(read.randomSeed).toBeNull();
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

  it('treats a stored copy of the retired ceiling as the current default', () => {
    expect(RETIRED_DEFAULT_MAX_TOKENS).toBe(2048);
    expect(readAppSettingDefaults({ maxTokens: 2048 }).maxTokens).toBe(DEFAULT_APP_SETTINGS.maxTokens);
    expect(readAppSettingDefaults({ maxTokens: 2048 }, baseline).maxTokens).toBe(baseline.maxTokens);
    expect(readAppSettingDefaults({ maxTokens: 4096 }, baseline).maxTokens).toBe(4096);
    expect(readAppSettingDefaults({
      maxTokens: 2048,
      maxTokensDefaultGeneration: MAX_TOKENS_DEFAULT_GENERATION,
    }, baseline).maxTokens).toBe(2048);
  });

  it('round-trips through the persisted projection', () => {
    // The alias is excluded from the projection on purpose: the component keeps writing
    // `selectedModelAlias` itself as the last model used. Reading it back as the baseline is
    // still correct, so only the write side omits it.
    const persisted = appSettingDefaultsToPersisted(baseline);
    expect('selectedModelAlias' in persisted).toBe(false);
    expect('webToolsEnabled' in persisted).toBe(false);
    expect(persisted.maxTokensDefaultGeneration).toBe(MAX_TOKENS_DEFAULT_GENERATION);
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
      'frequencyPenalty',
      'maxTokens',
      'modelAlias',
      'presencePenalty',
      'randomSeed',
      'showFullHistory',
      'systemPrompt',
      'temperature',
      'topK',
      'topP',
      'webToolsEnabled',
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

  it('resolves stored generation parameters, key by key', () => {
    const resolved = resolveConversationSettings(
      { temperature: 1.2, maxTokens: 256, topP: 0.5, topK: 20, frequencyPenalty: 0.4, presencePenalty: -0.4, randomSeed: 3 },
      baseline,
    );
    expect(resolved.effective.temperature).toBe(1.2);
    expect(resolved.effective.maxTokens).toBe(256);
    expect(resolved.effective.topP).toBe(0.5);
    expect(resolved.effective.topK).toBe(20);
    expect(resolved.effective.frequencyPenalty).toBe(0.4);
    expect(resolved.effective.presencePenalty).toBe(-0.4);
    expect(resolved.effective.randomSeed).toBe(3);
    expect(resolved.fromDefault).toEqual(
      expect.not.arrayContaining([
        'temperature', 'maxTokens', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty', 'randomSeed',
      ]),
    );
  });

  it('resolves a stored null randomSeed as an explicit override, not as inherited', () => {
    const resolved = resolveConversationSettings({ randomSeed: null }, { ...baseline, randomSeed: 99 });
    expect(resolved.effective.randomSeed).toBeNull();
    expect(resolved.fromDefault).not.toContain('randomSeed');
    expect(resolved.invalidKeys).toEqual([]);
  });

  it('falls back to the baseline for out-of-range generation parameters', () => {
    const resolved = resolveConversationSettings(
      { temperature: 3, maxTokens: 0, topP: 1.5, topK: -1, frequencyPenalty: 3, presencePenalty: -3, randomSeed: 1.5 },
      baseline,
    );
    expect(resolved.effective.temperature).toBe(baseline.temperature);
    expect(resolved.effective.maxTokens).toBe(baseline.maxTokens);
    expect(resolved.effective.topP).toBe(baseline.topP);
    expect(resolved.effective.topK).toBe(baseline.topK);
    expect(resolved.effective.frequencyPenalty).toBe(baseline.frequencyPenalty);
    expect(resolved.effective.presencePenalty).toBe(baseline.presencePenalty);
    expect(resolved.effective.randomSeed).toBe(baseline.randomSeed);
    expect(resolved.invalidKeys.sort()).toEqual([
      'frequencyPenalty', 'maxTokens', 'presencePenalty', 'randomSeed', 'temperature', 'topK', 'topP',
    ]);
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
      temperature: 0.5,
      maxTokens: 1024,
      topP: 0.9,
      topK: 40,
      frequencyPenalty: 0.2,
      presencePenalty: -0.2,
      randomSeed: 7,
      webToolsEnabled: false,
      maxTokensDefaultGeneration: MAX_TOKENS_DEFAULT_GENERATION,
    });
  });

  it('requires fresh opt-in instead of carrying web permission into a new chat', () => {
    expect(seedSettingsFor({ ...baseline, webToolsEnabled: true }).webToolsEnabled).toBe(false);
    expect(seedSettingsFor(baseline, { webToolsEnabled: true }).webToolsEnabled).toBe(true);
    expect(seedSettingsFor(baseline, {}, { webToolsForNewChats: true }).webToolsEnabled).toBe(true);
    expect(seedSettingsFor(baseline, { webToolsEnabled: false }, { webToolsForNewChats: true }).webToolsEnabled)
      .toBe(false);
  });

  it('stamps an explicit null randomSeed rather than leaving it absent', () => {
    const seed = seedSettingsFor({ ...baseline, randomSeed: null });
    expect(seed.randomSeed).toBeNull();
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

describe('startupWebToolsPatch', () => {
  it('turns web search on only for an empty bag when Remember is set', () => {
    expect(startupWebToolsPatch({}, true)).toEqual({ webToolsEnabled: true });
    expect(startupWebToolsPatch({}, false)).toBeNull();
    expect(startupWebToolsPatch({ webToolsEnabled: false }, true)).toBeNull();
    expect(startupWebToolsPatch({ webToolsEnabled: true }, true)).toBeNull();
  });
});

describe('migrateRetiredMaxTokens', () => {
  const chat = (settings?: unknown) => ({ id: 'c', settings });

  it('raises an untouched 2048 ceiling and stamps every other stored bag', () => {
    const raised = migrateRetiredMaxTokens([
      chat({ maxTokens: 2048, temperature: 0.7 }),
      chat({ maxTokens: 16384 }),
      chat(),
      chat([]),
    ]);
    expect(raised.changed).toBe(true);
    expect(raised.conversations[0].settings).toMatchObject({
      maxTokens: DEFAULT_APP_SETTINGS.maxTokens,
      temperature: 0.7,
      maxTokensDefaultGeneration: MAX_TOKENS_DEFAULT_GENERATION,
    });
    expect(raised.conversations[1].settings).toMatchObject({
      maxTokens: 16384,
      maxTokensDefaultGeneration: MAX_TOKENS_DEFAULT_GENERATION,
    });
    expect(raised.conversations[2].settings).toBeUndefined();
    expect(raised.conversations[3].settings).toEqual([]);
  });

  it('leaves a later choice of 2048 alone', () => {
    const once = migrateRetiredMaxTokens([chat({ maxTokens: 2048 })]);
    const chosen = migrateRetiredMaxTokens([
      chat({ ...(once.conversations[0].settings as object), maxTokens: 2048 }),
    ]);
    expect(chosen.changed).toBe(false);
    expect((chosen.conversations[0].settings as { maxTokens: number }).maxTokens).toBe(2048);
  });

  it('does not migrate a chat twice', () => {
    const once = migrateRetiredMaxTokens([chat({ maxTokens: 16384, custom: true })]);
    const twice = migrateRetiredMaxTokens(once.conversations);
    expect(twice.changed).toBe(false);
    expect(twice.conversations[0]).toBe(once.conversations[0]);
    expect(once.conversations[0].settings).toMatchObject({ maxTokens: 16384, custom: true });
  });
});
