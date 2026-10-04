import { describe, expect, it } from 'vitest';
import {
  generationReserve,
  packContextMessages,
  plannedWebFit,
  repackToolRequest,
} from './context-packer';
import { estimateTokens, estimateTokensForMessages } from './token-estimate';
import { buildWebEnvelope } from './web-envelope';

describe('context packer', () => {
  it('reserves a quarter of a 4096-token window when max tokens is 2048', () => {
    expect(generationReserve(4096, 2048)).toBe(1024);
    expect(generationReserve(4096, 100)).toBe(100);
  });

  it('fits a normal send when four full fences do not fit in the fallback window', () => {
    const system = 'Be helpful.';
    const latest = { role: 'user', content: 'What is the public weather?' };
    const occupied = Math.ceil(
      (estimateTokens(system) + estimateTokensForMessages([latest])) * 1.15,
    );
    const fit = plannedWebFit({
      contextTokens: 4096,
      maxTokens: 2048,
      roundsRemaining: 2,
      occupiedTokens: occupied,
    });
    expect(fit.maxChars).toBe(1_000);
    expect(fit.promptTokens).toBeGreaterThanOrEqual(occupied);
    const packed = packContextMessages({
      messages: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
        latest,
      ],
      systemPrompt: system,
      budgetTokens: fit.promptTokens,
      bodyChars: fit.maxChars,
    });
    expect(packed.contextFull).toBe(false);
    expect(packed.messages.at(-1)).toEqual(latest);
  });

  it('refuses only when the system prompt and latest message still do not fit', () => {
    const system = 'word '.repeat(20_000);
    const latest = { role: 'user', content: 'hi' };
    const fit = plannedWebFit({
      contextTokens: 4096,
      maxTokens: 2048,
      roundsRemaining: 0,
      occupiedTokens: Math.ceil(estimateTokens(system) * 1.15),
    });
    const packed = packContextMessages({
      messages: [latest],
      systemPrompt: system,
      budgetTokens: fit.promptTokens,
    });
    expect(packed.contextFull).toBe(true);
    expect(packed.messages).toEqual([]);
  });

  it('keeps the latest user turn when an earlier turn does not fit beside the tool reserve', () => {
    const closer = 'flint-ref-abcdef012345';
    const fence = buildWebEnvelope({
      closer,
      title: 'Page',
      url: 'https://example.com/',
      retrievedOn: '2026-10-03',
      body: 'alpha beta ',
    });
    const latest = { role: 'user', content: `Question\n\n${fence}` };
    const messages = [
      { role: 'user', content: 'system folded' },
      { role: 'assistant', content: 'old '.repeat(8_000) },
      latest,
    ];
    const occupied = Math.ceil(estimateTokensForMessages([messages[0], latest]) * 1.15);
    const fit = plannedWebFit({
      contextTokens: 4096,
      maxTokens: 2048,
      roundsRemaining: 1,
      occupiedTokens: occupied,
    });
    const packed = repackToolRequest({
      messages,
      budgetTokens: fit.promptTokens,
      closer,
      bodyChars: fit.maxChars,
    });
    expect(packed.contextFull).toBe(false);
    expect(packed.messages[0].content).toBe('system folded');
    expect(packed.omittedHistory).toBeGreaterThan(0);
    expect(String(packed.messages.at(-1)?.content)).toContain('Question');
  });
});
