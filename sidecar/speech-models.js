export const SPEECH_SDK_VERSION = '2.0.1';

const FAMILY_RULES = [
  {
    family: 'parakeet',
    pattern: /parakeet/i,
    strategy: null,
    reason: `Parakeet transcription is not supported by Foundry Local SDK ${SPEECH_SDK_VERSION}.`,
  },
  {
    family: 'nemotron',
    pattern: /nemotron.*(?:speech|asr)|nemotron.*3[.]5/i,
    strategy: 'itemQueue',
  },
  {
    family: 'whisper',
    pattern: /whisper/i,
    strategy: 'audioUri',
  },
];

/**
 * Select the probed SDK 2.0.1 audio request shape from model names, which carry the
 * family information absent from catalog metadata.
 *
 * @param {string} alias
 * @param {string} [variantId]
 */
export function getSpeechModelStrategy (alias, variantId = '') {
  const variant = strategyForName(variantId);
  if (variant) return variant;
  return strategyForName(alias)
    ?? { family: 'unknown', strategy: 'audioUri', supported: true, reason: null };
}

function strategyForName (name) {
  const normalized = String(name || '').trim();
  if (!normalized) return null;
  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        family: rule.family,
        strategy: rule.strategy,
        supported: rule.strategy !== null,
        reason: rule.reason ?? null,
      };
    }
  }
  return null;
}

/**
 * Resolve an opaque alias only when every cached candidate identifies the same family.
 * Alias loads let the runtime select the exact variant, so mixed or unknown candidate
 * families must remain deferred until `load()` reports the selected variant.
 *
 * @param {string} alias
 * @param {string[]} variantIds
 */
export function getSpeechModelStrategyForVariants (alias, variantIds = []) {
  const aliasStrategy = getSpeechModelStrategy(alias);
  const candidates = variantIds.map((variantId) => getSpeechModelStrategy('', variantId));
  if (candidates.length === 0 || candidates.some((candidate) => candidate.family === 'unknown')) {
    return aliasStrategy;
  }
  const [first] = candidates;
  return candidates.every((candidate) => candidate.family === first.family)
    ? first
    : aliasStrategy;
}
