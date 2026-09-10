import { describe, expect, it } from 'vitest';
import { normalizeChatResponse } from './chat-response.js';

describe('normalizeChatResponse', () => {
  it('removes non-standard fields and keeps the assistant message', () => {
    expect(normalizeChatResponse({
      id: 'chat-1',
      IsDelta: false,
      Successful: true,
      HttpStatusCode: 200,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello' },
        delta: { role: 'assistant', content: 'h' },
        finish_reason: 'stop',
      }],
    })).toEqual({
      id: 'chat-1',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      }],
    });
  });

  it('uses delta when a runtime omits message content', () => {
    expect(normalizeChatResponse({
      choices: [{ delta: { role: 'assistant', content: 'h' } }],
    })).toEqual({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'h' },
        finish_reason: null,
      }],
    });
  });

  it('normalizes streaming choices without exposing both forms', () => {
    expect(normalizeChatResponse({
      choices: [{
        message: { role: 'assistant', content: 'hello' },
        delta: { role: 'assistant', content: 'h' },
        IsDelta: true,
      }],
    }, { stream: true })).toEqual({
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: 'h' },
        finish_reason: null,
      }],
    });
  });

  it('rejects non-object responses', () => {
    expect(() => normalizeChatResponse(null)).toThrow('Chat response must be an object');
  });
});
