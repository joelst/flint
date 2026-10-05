import { describe, expect, it } from 'vitest';
import {
  chooseFetchMaxChars,
  generationReserve,
  IMAGE_TOKEN_OVERHEAD,
  PACKER_SAFETY_FACTOR,
  packContextMessages,
  pendingWebReserve,
  plannedWebFit,
  promptBudget,
  repackToolRequest,
} from './context-packer';
import { estimateTokens, estimateTokensCeiling, estimateTokensForMessages } from './token-estimate';
import {
  buildWebEnvelope,
  FENCE_FRAMING_CHARS,
  IMAGE_LABEL_CHARS,
  MAX_FENCED_RESULT_CHARS,
  SEARCH_URL_CHARS,
} from './web-envelope';

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
    expect(fit.toolsViable).toBe(true);
    expect(fit.maxToolCalls).toBe(1);
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

  it('shrinks the message budget by the tool schemas once', () => {
    const without = plannedWebFit({
      contextTokens: 100000,
      maxTokens: 100,
      roundsRemaining: 2,
      occupiedTokens: 500,
    });
    const withSchemas = plannedWebFit({
      contextTokens: 100000,
      maxTokens: 100,
      roundsRemaining: 2,
      occupiedTokens: 580,
      schemaTokens: 80,
    });
    expect(without.promptTokens - withSchemas.promptTokens).toBe(80);
    expect(without.maxToolCalls).toBe(2);
  });

  it('withholds tools when one minimum fence cannot sit beside the prompt', () => {
    const contextTokens = 4096;
    const maxTokens = 2048;
    const available = contextTokens - generationReserve(contextTokens, maxTokens);
    const callLinkage = Math.ceil(estimateTokens([
      'c'.repeat(64),
      'web_fetch',
      JSON.stringify({ url: 'u'.repeat(SEARCH_URL_CHARS) }),
    ].join('\n')) * PACKER_SAFETY_FACTOR) + Math.ceil(1.5);
    const resultLinkage = Math.ceil(estimateTokens([
      'c'.repeat(64),
      'web_fetch',
    ].join('\n')) * PACKER_SAFETY_FACTOR) + Math.ceil(1.5);
    const minimumTokens = Math.ceil(
      estimateTokensCeiling(280 + FENCE_FRAMING_CHARS + IMAGE_LABEL_CHARS) * PACKER_SAFETY_FACTOR,
    ) + callLinkage + resultLinkage;
    const crowded = plannedWebFit({
      contextTokens,
      maxTokens,
      roundsRemaining: 2,
      occupiedTokens: available - minimumTokens + 1,
    });
    expect(crowded.toolsViable).toBe(false);
    expect(crowded.maxToolCalls).toBe(0);
    const exact = plannedWebFit({
      contextTokens,
      maxTokens,
      roundsRemaining: 2,
      occupiedTokens: available - minimumTokens,
    });
    expect(exact.toolsViable).toBe(true);
    expect(exact.maxToolCalls).toBe(1);
    const toolFree = plannedWebFit({
      contextTokens,
      maxTokens,
      roundsRemaining: 0,
      occupiedTokens: available - minimumTokens + 1,
    });
    expect(toolFree.toolsViable).toBe(true);
    expect(toolFree.maxToolCalls).toBe(0);
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

  it('budgets an unknown context and subtracts a reserve', () => {
    expect(promptBudget({ contextTokens: null, maxTokens: 100 })).toBe(
      4096 - generationReserve(4096, 100),
    );
    expect(promptBudget({ contextTokens: 0, maxTokens: 100, reserveTokens: 50 })).toBe(
      4096 - generationReserve(4096, 100) - 50,
    );
    expect(promptBudget({ contextTokens: 8000, maxTokens: 100, reserveTokens: -5 })).toBe(
      8000 - generationReserve(8000, 100),
    );
    expect(chooseFetchMaxChars({
      contextTokens: 4096,
      maxTokens: 100,
      roundsRemaining: Number.NaN,
      occupiedTokens: 0,
    })).toBe(1_000);
  });

  it('does not admit a full fence when only its unscaled estimate fits', () => {
    const slots = 2;
    const fullChars = MAX_FENCED_RESULT_CHARS;
    const unscaled = slots * estimateTokens('x'.repeat(fullChars));
    const scaled = slots * Math.ceil(estimateTokens('x'.repeat(fullChars)) * PACKER_SAFETY_FACTOR);
    expect(scaled).toBeGreaterThan(unscaled);

    const contextTokens = 32_768;
    const maxTokens = 256;
    const generation = generationReserve(contextTokens, maxTokens);
    const available = contextTokens - generation;
    const occupiedTokens = available - unscaled;
    const fit = plannedWebFit({
      contextTokens,
      maxTokens,
      roundsRemaining: 1,
      occupiedTokens,
    });
    const room = available - occupiedTokens;
    expect(fit.fencedChars).toBeLessThanOrEqual(
      Math.floor(room / PACKER_SAFETY_FACTOR / slots * 3.9),
    );
    expect(pendingWebReserve({
      roundsRemaining: 0,
      fencedChars: 0,
      reserveImage: true,
    })).toBe(Math.ceil(IMAGE_TOKEN_OVERHEAD * PACKER_SAFETY_FACTOR));
    const imageFit = plannedWebFit({
      contextTokens: 8000,
      maxTokens: 100,
      roundsRemaining: 0,
      occupiedTokens: 0,
      reserveImage: true,
    });
    expect(imageFit.promptTokens).toBe(
      8000 - generationReserve(8000, 100) - Math.ceil(IMAGE_TOKEN_OVERHEAD * PACKER_SAFETY_FACTOR),
    );
  });

  it('reserves a fenced result for one-character words', () => {
    const chars = 280 + FENCE_FRAMING_CHARS;
    const dense = 'a '.repeat(Math.ceil(chars / 2)).slice(0, chars);
    expect(dense.length).toBe(chars);
    const reserved = pendingWebReserve({ roundsRemaining: 1, fencedChars: chars });
    const perSlot = Math.ceil(estimateTokens(dense) * PACKER_SAFETY_FACTOR);
    expect(reserved).toBeGreaterThanOrEqual(perSlot * 2);
  });

  it('picks a fetch size whose short words fit the leftover', () => {
    const contextTokens = 32_768;
    const maxTokens = 256;
    const occupiedTokens = 1_000;
    const roundsRemaining = 1;
    const chars = chooseFetchMaxChars({ contextTokens, maxTokens, roundsRemaining, occupiedTokens });
    const fenced = chars + FENCE_FRAMING_CHARS;
    const dense = 'a '.repeat(Math.ceil(fenced / 2)).slice(0, fenced);
    const slots = 2;
    const cost = slots * Math.ceil(estimateTokens(dense) * PACKER_SAFETY_FACTOR);
    const available = contextTokens - generationReserve(contextTokens, maxTokens) - occupiedTokens;
    expect(cost).toBeLessThanOrEqual(available);
  });

  it('drops a short answer when its huge question does not fit', () => {
    const huge = { role: 'user', content: `question ${'question '.repeat(8_000)}` };
    const answer = { role: 'assistant', content: 'short answer' };
    const latest = { role: 'user', content: 'latest question' };
    const system = 'Be helpful.';
    const budget = Math.ceil(
      (estimateTokens(system) + estimateTokensForMessages([answer, latest])) * 1.15,
    );
    const packed = packContextMessages({
      messages: [huge, answer, latest],
      systemPrompt: system,
      budgetTokens: budget,
    });
    const contents = packed.messages.map((message) => String(message.content));
    expect(contents).toContain('latest question');
    const answerAt = contents.indexOf('short answer');
    const questionAt = contents.findIndex((content) => content.startsWith('question question'));
    expect(answerAt === -1 || (questionAt !== -1 && questionAt < answerAt)).toBe(true);
  });

  it('drops a short middle answer when its huge question does not fit', () => {
    const huge = { role: 'user', content: `question ${'question '.repeat(8_000)}` };
    const answer = { role: 'assistant', content: 'short answer' };
    const head = { role: 'user', content: 'folded system' };
    const latest = { role: 'user', content: 'latest question' };
    const budget = Math.ceil(estimateTokensForMessages([head, answer, latest]) * 1.15);
    const packed = repackToolRequest({
      messages: [head, huge, answer, latest],
      budgetTokens: budget,
    });
    const contents = packed.messages.map((message) => String(message.content));
    expect(contents).toContain('folded system');
    expect(contents).toContain('latest question');
    const answerAt = contents.indexOf('short answer');
    const questionAt = contents.findIndex((content) => content.startsWith('question question'));
    expect(answerAt === -1 || (questionAt !== -1 && questionAt < answerAt)).toBe(true);
  });

  it('keeps a summary, a pinned turn, and a short older turn, and drops one that does not fit', () => {
    const summary = { role: 'assistant', content: 'summary text', isSummary: true };
    const pinned = { role: 'user', content: 'pinned note', pinned: true };
    const older = { role: 'assistant', content: 'short older answer' };
    const huge = { role: 'assistant', content: 'huge '.repeat(8_000) };
    const latest = { role: 'user', content: 'latest question' };
    const budget = Math.ceil(
      (estimateTokens('Be helpful.') + estimateTokensForMessages([summary, pinned, older, latest])) * 1.15,
    );
    const packed = packContextMessages({
      messages: [summary, pinned, older, huge, latest],
      systemPrompt: 'Be helpful.',
      budgetTokens: budget,
    });
    expect(packed.contextFull).toBe(false);
    expect(packed.messages.map((message) => message.content)).toEqual([
      'summary text',
      'pinned note',
      'short older answer',
      'latest question',
    ]);
    expect(packed.omittedPinned).toBe(0);
    expect(packed.omittedSummaries).toBe(0);
  });

  it('shortens a fenced page in string content and in the first text part', () => {
    const closer = 'flint-ref-abcdef012345';
    const fence = buildWebEnvelope({
      closer,
      title: 'Page',
      url: 'https://example.com/p',
      retrievedOn: '2026-10-03',
      body: 'alpha '.repeat(80),
    });
    const stringPacked = packContextMessages({
      messages: [{ role: 'user', content: fence }],
      systemPrompt: 'Be helpful.',
      budgetTokens: 100_000,
      closer,
      bodyChars: 24,
    });
    expect(stringPacked.shortened).toBe(true);
    expect(String(stringPacked.messages[0].content)).toContain('[shortened to fit context]');
    expect(String(stringPacked.messages[0].content)).toContain('Title: Page.');

    const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aa' } };
    const arrayPacked = packContextMessages({
      messages: [{
        role: 'user',
        content: [null, 'nope', image, { type: 'text', text: fence }, { type: 'text', text: 'second' }],
      }],
      systemPrompt: '',
      budgetTokens: 100_000,
      closer,
      bodyChars: 24,
    });
    expect(arrayPacked.shortened).toBe(true);
    const parts = arrayPacked.messages[0].content as unknown[];
    expect(parts[0]).toBeNull();
    expect(parts[1]).toBe('nope');
    expect(parts[2]).toBe(image);
    expect(String((parts[3] as { text: string }).text)).toContain('[shortened to fit context]');
    expect(String((parts[3] as { text: string }).text)).not.toContain('second');
    expect((parts[4] as { text: string }).text).toBe('second');
  });

  it('returns no latest turn when the request has no user message', () => {
    const packed = packContextMessages({
      messages: [],
      systemPrompt: 'hi',
      budgetTokens: 100,
    });
    expect(packed.contextFull).toBe(false);
    expect(packed.messages).toEqual([]);
  });

  it('keeps a middle turn that fits and refuses a tail that does not fit after shortening', () => {
    const middle = repackToolRequest({
      messages: [
        { role: 'user', content: 'folded' },
        { role: 'assistant', content: 'middle answer' },
        { role: 'user', content: 'latest' },
      ],
      budgetTokens: 100_000,
    });
    expect(middle.contextFull).toBe(false);
    expect(middle.messages.map((message) => message.content)).toEqual(['folded', 'middle answer', 'latest']);
    expect(middle.omittedHistory).toBe(0);

    const closer = 'flint-ref-abcdef012345';
    const fence = buildWebEnvelope({
      closer,
      title: 'Page',
      url: 'https://example.com/p',
      retrievedOn: '2026-10-03',
      body: 'alpha '.repeat(400),
    });
    const full = repackToolRequest({
      messages: [
        { role: 'assistant', content: 'folded' },
        { role: 'user', content: fence },
      ],
      budgetTokens: 20,
      closer,
      bodyChars: 2_000,
      minimumBodyChars: 24,
    });
    expect(full.contextFull).toBe(true);
    expect(full.shortened).toBe(true);
    expect(full.messages).toEqual([]);
  });
});
