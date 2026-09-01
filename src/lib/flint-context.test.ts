import { describe, it, expect } from 'vitest';
import {
  userAsksAboutFlint,
  buildFlintAwareSystemPrompt,
  contentToPlainText,
  FLINT_IDENTITY_LINE,
  FLINT_FACT_SHEET,
} from './flint-context';

describe('userAsksAboutFlint', () => {
  it('detects explicit flint / foundry questions', () => {
    expect(userAsksAboutFlint('What is Flint?')).toBe(true);
    expect(userAsksAboutFlint('How do I use Foundry Local with this app?')).toBe(true);
    expect(userAsksAboutFlint('Tell me about this app')).toBe(true);
    expect(userAsksAboutFlint('Does Foundry Local support tool calling?')).toBe(true);
    expect(userAsksAboutFlint('What is the OpenAI-compatible local endpoint?')).toBe(true);
  });

  it('does not trigger on ordinary coding/chat', () => {
    expect(userAsksAboutFlint('Write a Python function to sort a list')).toBe(false);
    expect(userAsksAboutFlint('Explain quicksort')).toBe(false);
    expect(userAsksAboutFlint('Fix this TypeScript error')).toBe(false);
  });

  it('skips very long pastes', () => {
    expect(userAsksAboutFlint('x'.repeat(2001))).toBe(false);
  });
});

describe('buildFlintAwareSystemPrompt', () => {
  it('always includes identity for normal turns', () => {
    const out = buildFlintAwareSystemPrompt('You are a helpful assistant.', 'hello');
    expect(out).toContain(FLINT_IDENTITY_LINE);
    expect(out).not.toContain(FLINT_FACT_SHEET);
  });

  it('adds fact sheet when user asks about flint', () => {
    const out = buildFlintAwareSystemPrompt('You are a helpful assistant.', 'What is Flint?');
    expect(out).toContain(FLINT_IDENTITY_LINE);
    expect(out).toContain(FLINT_FACT_SHEET);
    expect(out).toContain('Foundry Local (Microsoft)');
    expect(out).toContain('OpenAI-compatible');
    expect(out).toMatch(/bundled Node|Node 22/i);
    expect(out).toContain('Model Arena');
    expect(out).toMatch(/pool/i);
  });

  it('forceFull always expands', () => {
    const out = buildFlintAwareSystemPrompt('You are concise.', 'hi', { forceFull: true });
    expect(out).toContain(FLINT_FACT_SHEET);
  });
});

describe('contentToPlainText', () => {
  it('handles string and vision parts', () => {
    expect(contentToPlainText('hi')).toBe('hi');
    expect(
      contentToPlainText([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'x' } },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });
});
