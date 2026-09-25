/**
 * Resolving a conversation's stored settings against the application's baseline.
 *
 * A stored conversation carries an opaque settings bag in which an *absent* key means "inherit
 * the application default". Until now Flint had no separate record of those defaults: the four
 * settings variables in `+page.svelte` simply held whatever the previously selected conversation
 * had left behind, so an absent key would have inherited the previous conversation's model and
 * persona and then written that leaked value back out as an application-level setting. That is
 * why the settings bag was stored and round-tripped but never applied.
 *
 * This module supplies the missing baseline and the resolution rule, and nothing else. It is
 * deliberately **read-only**: resolving a conversation for display must never materialise
 * overrides onto it, because doing so would freeze today's defaults into a record that had
 * chosen to inherit them, and would silently replace any stored value this build considers
 * invalid but is obliged to preserve. Writing is the caller's job, one explicit patch at a
 * time, through `captureThread`.
 */

import { readConversationSettings, type ConversationSettings } from './conversation-store';

/**
 * The application-level baseline every conversation inherits from.
 *
 * Every field is required. A partial baseline would leave an absent conversation key with
 * nothing to resolve against, which is the ambiguity this type exists to remove.
 */
export interface AppSettingDefaults {
  /** Empty means no model has been chosen yet, which is a real state on a fresh install. */
  modelAlias: string;
  systemPrompt: string;
  contextTurns: number;
  showFullHistory: boolean;
  /** Sampling temperature, OpenAI's documented 0-2 range. */
  temperature: number;
  /** Maximum tokens the model may generate in a single reply. */
  maxTokens: number;
  /** Nucleus sampling cutoff, (0, 1]. */
  topP: number;
  /** Top-k sampling cutoff. */
  topK: number;
  /** Repetition penalty by raw frequency, OpenAI's documented -2 to 2 range. */
  frequencyPenalty: number;
  /** Repetition penalty by presence, OpenAI's documented -2 to 2 range. */
  presencePenalty: number;
  /**
   * Deterministic sampling seed, when the model supports it. `null` means "no seed" — generation
   * stays non-deterministic — which no number can represent, since the sidecar treats any finite
   * number (including 0) as a seed to send. Mirrors the `modelAlias`-absence convention below.
   */
  randomSeed: number | null;
}

/** The baseline used before anything has been persisted. Mirrors the component's initial state. */
export const DEFAULT_APP_SETTINGS: AppSettingDefaults = Object.freeze({
  modelAlias: '',
  systemPrompt: 'You are a helpful assistant.',
  contextTurns: 12,
  showFullHistory: false,
  // Foundry Local's model catalog reports no default sampling parameters today, so these are
  // Flint's own sensible starting point rather than anything sourced from the catalog.
  temperature: 0.7,
  maxTokens: 2048,
  topP: 1,
  topK: 50,
  frequencyPenalty: 0,
  presencePenalty: 0,
  randomSeed: null,
});

/** The persisted key each default is stored under in the application settings blob. */
const PERSISTED_KEYS: Record<keyof AppSettingDefaults, string> = {
  modelAlias: 'selectedModelAlias',
  systemPrompt: 'systemPrompt',
  contextTurns: 'contextTurns',
  showFullHistory: 'showFullHistory',
  temperature: 'temperature',
  maxTokens: 'maxTokens',
  topP: 'topP',
  topK: 'topK',
  frequencyPenalty: 'frequencyPenalty',
  presencePenalty: 'presencePenalty',
  randomSeed: 'randomSeed',
};

/**
 * Read the baseline out of the persisted application settings blob.
 *
 * Validation matches `readConversationSettings`, so a value that would be rejected as a
 * conversation override cannot enter through the baseline instead and become the value every
 * inheriting conversation resolves to.
 *
 * Presence is tested rather than truthiness. An empty `selectedModelAlias` and a
 * `showFullHistory` of `false` are both meaningful stored choices, and `||` would discard them.
 */
export function readAppSettingDefaults(
  raw: unknown,
  fallback: AppSettingDefaults = DEFAULT_APP_SETTINGS,
): AppSettingDefaults {
  const defaults: AppSettingDefaults = { ...fallback };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const source = raw as Record<string, unknown>;

  const alias = source[PERSISTED_KEYS.modelAlias];
  if (typeof alias === 'string') defaults.modelAlias = alias;

  const prompt = source[PERSISTED_KEYS.systemPrompt];
  if (typeof prompt === 'string') defaults.systemPrompt = prompt;

  const turns = source[PERSISTED_KEYS.contextTurns];
  if (typeof turns === 'number' && Number.isInteger(turns) && turns > 0) {
    defaults.contextTurns = turns;
  }

  const full = source[PERSISTED_KEYS.showFullHistory];
  if (typeof full === 'boolean') defaults.showFullHistory = full;

  const temperature = source[PERSISTED_KEYS.temperature];
  if (typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    defaults.temperature = temperature;
  }

  const maxTokens = source[PERSISTED_KEYS.maxTokens];
  if (typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens > 0) {
    defaults.maxTokens = maxTokens;
  }

  const topP = source[PERSISTED_KEYS.topP];
  if (typeof topP === 'number' && Number.isFinite(topP) && topP > 0 && topP <= 1) {
    defaults.topP = topP;
  }

  const topK = source[PERSISTED_KEYS.topK];
  if (typeof topK === 'number' && Number.isInteger(topK) && topK > 0) {
    defaults.topK = topK;
  }

  const frequencyPenalty = source[PERSISTED_KEYS.frequencyPenalty];
  if (typeof frequencyPenalty === 'number' && Number.isFinite(frequencyPenalty) && frequencyPenalty >= -2 && frequencyPenalty <= 2) {
    defaults.frequencyPenalty = frequencyPenalty;
  }

  const presencePenalty = source[PERSISTED_KEYS.presencePenalty];
  if (typeof presencePenalty === 'number' && Number.isFinite(presencePenalty) && presencePenalty >= -2 && presencePenalty <= 2) {
    defaults.presencePenalty = presencePenalty;
  }

  // `null` is a valid stored value here (it means "no seed"), unlike every other field where an
  // absent/wrong-type value simply falls through to the existing default.
  const randomSeed = source[PERSISTED_KEYS.randomSeed];
  if (randomSeed === null) {
    defaults.randomSeed = null;
  } else if (typeof randomSeed === 'number' && Number.isSafeInteger(randomSeed)) {
    defaults.randomSeed = randomSeed;
  }

  return defaults;
}

/**
 * Project the baseline back onto the persisted key names, for writing the settings blob.
 *
 * `modelAlias` is deliberately **not** emitted. Its persisted key, `selectedModelAlias`, is the
 * application's existing "last model used" value: it drives startup prewarming and is what a
 * rolled-back build would chat with. That is a genuine global preference and the component keeps
 * writing it, so re-publishing a frozen copy from here would fight with it. Reading it back as
 * the baseline is still right — a conversation that stores no model should open with a model
 * that works, and unlike a persona the alias is not a leak of the previous chat's character.
 */
export function appSettingDefaultsToPersisted(
  defaults: AppSettingDefaults,
): Record<string, unknown> {
  return {
    [PERSISTED_KEYS.systemPrompt]: defaults.systemPrompt,
    [PERSISTED_KEYS.contextTurns]: defaults.contextTurns,
    [PERSISTED_KEYS.showFullHistory]: defaults.showFullHistory,
    [PERSISTED_KEYS.temperature]: defaults.temperature,
    [PERSISTED_KEYS.maxTokens]: defaults.maxTokens,
    [PERSISTED_KEYS.topP]: defaults.topP,
    [PERSISTED_KEYS.topK]: defaults.topK,
    [PERSISTED_KEYS.frequencyPenalty]: defaults.frequencyPenalty,
    [PERSISTED_KEYS.presencePenalty]: defaults.presencePenalty,
    [PERSISTED_KEYS.randomSeed]: defaults.randomSeed,
  };
}

export interface ResolvedConversationSettings {
  /** The values the chat should actually use. Every field is populated. */
  effective: AppSettingDefaults;
  /** Keys with no usable stored value, which therefore came from the baseline. */
  fromDefault: (keyof AppSettingDefaults)[];
  /**
   * Stored keys this build recognises but could not use. Reported so a caller can explain the
   * discrepancy; the stored values themselves are untouched.
   */
  invalidKeys: string[];
}

/**
 * Resolve one conversation's stored bag against the baseline.
 *
 * Takes the **raw** bag rather than an already-filtered typed view, so `invalidKeys` survives.
 */
export function resolveConversationSettings(
  raw: unknown,
  defaults: AppSettingDefaults,
): ResolvedConversationSettings {
  const { settings, invalidKeys } = readConversationSettings(raw);
  const effective: AppSettingDefaults = { ...defaults };
  const fromDefault: (keyof AppSettingDefaults)[] = [];

  const take = <K extends keyof AppSettingDefaults>(key: K, stored: AppSettingDefaults[K] | undefined) => {
    if (stored === undefined) fromDefault.push(key);
    else effective[key] = stored;
  };

  // An empty alias is the absence of a choice, not a choice of nothing — the same rule
  // `seedSettingsFor` applies when writing. It matters here because the caller deliberately
  // does not blank the picker on an empty resolution (an empty resolution means the
  // conversation predates model tracking), so a stored `''` treated as an override would leave
  // the previous conversation's model selected: exactly the leak per-conversation settings
  // exist to close. Flint never writes `''`, so this guards archives written by something else.
  take('modelAlias', settings.modelAlias === '' ? undefined : settings.modelAlias);
  take('systemPrompt', settings.systemPrompt);
  take('contextTurns', settings.contextTurns);
  take('showFullHistory', settings.showFullHistory);
  take('temperature', settings.temperature);
  take('maxTokens', settings.maxTokens);
  take('topP', settings.topP);
  take('topK', settings.topK);
  take('frequencyPenalty', settings.frequencyPenalty);
  take('presencePenalty', settings.presencePenalty);
  take('randomSeed', settings.randomSeed);

  return { effective, fromDefault, invalidKeys };
}

/**
 * The settings patch a newly created conversation should be seeded with.
 *
 * New conversations are stamped with explicit values rather than left to inherit, so that the
 * baseline only ever governs conversations that predate this feature. That keeps "what a new
 * chat starts from" — the chat you were just in — separate from "what an inheriting
 * conversation resolves to", which must stay stable underneath the user.
 */
export function seedSettingsFor(
  effective: AppSettingDefaults,
  overrides: ConversationSettings = {},
): ConversationSettings {
  const seed: ConversationSettings = {
    systemPrompt: effective.systemPrompt,
    contextTurns: effective.contextTurns,
    showFullHistory: effective.showFullHistory,
    temperature: effective.temperature,
    maxTokens: effective.maxTokens,
    topP: effective.topP,
    topK: effective.topK,
    frequencyPenalty: effective.frequencyPenalty,
    presencePenalty: effective.presencePenalty,
    randomSeed: effective.randomSeed,
  };
  // An empty alias is not a choice, it is the absence of one — on a fresh install no model has
  // been picked yet, and the component's auto-selector fills it in at runtime. Seeding `''`
  // would record "this chat explicitly has no model", so selecting the chat again would blank
  // the picker that auto-selection had just filled. Leave the key absent and let it inherit.
  if (effective.modelAlias) seed.modelAlias = effective.modelAlias;
  return { ...seed, ...overrides };
}
