export const UNSUPPORTED_FREQUENCY_PENALTY_MESSAGE =
  'Foundry Local does not support a nonzero frequency penalty. Set it to 0 or omit it.';

/** @param {unknown} value @returns {string | null} */
export function unsupportedFrequencyPenaltyMessage(value) {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0
    ? UNSUPPORTED_FREQUENCY_PENALTY_MESSAGE
    : null;
}
