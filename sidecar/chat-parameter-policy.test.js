import { describe, expect, it } from 'vitest';
import {
  UNSUPPORTED_FREQUENCY_PENALTY_MESSAGE,
  unsupportedFrequencyPenaltyMessage,
} from './chat-parameter-policy.js';

describe('chat parameter policy', () => {
  it('rejects nonzero frequency penalties and permits neutral or absent values', () => {
    expect(unsupportedFrequencyPenaltyMessage(0)).toBeNull();
    expect(unsupportedFrequencyPenaltyMessage(-0)).toBeNull();
    expect(unsupportedFrequencyPenaltyMessage(undefined)).toBeNull();
    expect(unsupportedFrequencyPenaltyMessage('0.4')).toBeNull();
    expect(unsupportedFrequencyPenaltyMessage(Number.NaN)).toBeNull();
    expect(unsupportedFrequencyPenaltyMessage(Number.POSITIVE_INFINITY)).toBeNull();
    expect(unsupportedFrequencyPenaltyMessage(-0.4)).toBe(UNSUPPORTED_FREQUENCY_PENALTY_MESSAGE);
    expect(unsupportedFrequencyPenaltyMessage(2)).toBe(UNSUPPORTED_FREQUENCY_PENALTY_MESSAGE);
  });
});
