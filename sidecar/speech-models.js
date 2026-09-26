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
  const names = [variantId, alias].map((name) => String(name || '').trim()).filter(Boolean);
  for (const rule of FAMILY_RULES) {
    if (names.some((name) => rule.pattern.test(name))) {
      return {
        family: rule.family,
        strategy: rule.strategy,
        supported: rule.strategy !== null,
        reason: rule.reason ?? null,
      };
    }
  }
  return { family: 'unknown', strategy: 'audioUri', supported: true, reason: null };
}
