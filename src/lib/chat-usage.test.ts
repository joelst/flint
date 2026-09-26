import { describe, expect, it } from 'vitest';
import { usageFromChatCompletion } from './chat-usage';

describe('usageFromChatCompletion', () => {
  it('reads OpenAI-shaped fields', () => {
    expect(usageFromChatCompletion({ prompt_tokens: 3, completion_tokens: 2 })).toEqual({
      promptTokens: 3,
      completionTokens: 2,
    });
  });

  it('falls back to SDK-shaped fields', () => {
    expect(usageFromChatCompletion({ input_tokens: 5, output_tokens: 7 })).toEqual({
      promptTokens: 5,
      completionTokens: 7,
    });
  });

  it('prefers OpenAI fields when both are present', () => {
    expect(usageFromChatCompletion({
      prompt_tokens: 1,
      completion_tokens: 2,
      input_tokens: 9,
      output_tokens: 8,
    })).toEqual({ promptTokens: 1, completionTokens: 2 });
  });

  it('keeps a present side even when the other is missing, and does not coerce to 0', () => {
    expect(usageFromChatCompletion({ prompt_tokens: 3 })).toEqual({ promptTokens: 3 });
    expect(usageFromChatCompletion({ output_tokens: 2 })).toEqual({ completionTokens: 2 });
  });

  it('returns undefined when neither shape is a finite number', () => {
    expect(usageFromChatCompletion({})).toBeUndefined();
    expect(usageFromChatCompletion(null)).toBeUndefined();
    expect(usageFromChatCompletion({ prompt_tokens: null, completion_tokens: Infinity })).toBeUndefined();
  });
});
