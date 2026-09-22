import { describe, expect, it } from 'vitest';
import { caseBodyLabel, generationSettingLabel, suiteDefinitionView, targetVariantLabel } from './benchmark-suite-summary';
import type { BenchmarkSuite } from './benchmark-suite';

const suite = (over: Partial<BenchmarkSuite> = {}): BenchmarkSuite => ({
  id: 'suite-1',
  name: 'Arithmetic',
  createdAt: 1,
  targets: [{ alias: 'model-a', variantId: null }, { alias: 'model-b', variantId: 'cuda' }],
  cases: [
    { id: 'c1', prompt: 'What is 2+2?', expected: '4', tags: ['math'] },
    { id: 'c2', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] },
  ],
  warmupCount: 1,
  repeatCount: 2,
  ...over,
});

describe('suite definition labels', () => {
  it('names an alias-only target as the default variant', () => {
    expect(targetVariantLabel(null)).toBe('default');
    expect(targetVariantLabel('cuda')).toBe('cuda');
  });

  it('does not present a missing generation setting as zero', () => {
    expect(generationSettingLabel(undefined)).toBe('runtime default');
    expect(generationSettingLabel(0)).toBe('0');
    expect(generationSettingLabel(256)).toBe('256');
  });

  it('labels a messages case by count instead of dropping it', () => {
    expect(caseBodyLabel({ prompt: 'hi' })).toBe('hi');
    expect(caseBodyLabel({ messages: [{ role: 'user', content: 'hi' }] })).toBe('1 message');
    expect(caseBodyLabel({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] })).toBe('2 messages');
  });

  it('projects the stored suite, including expected text, without attempt data', () => {
    const view = suiteDefinitionView(suite({ description: 'basic math', temperature: 0.2, maxTokens: 128 }));
    expect(view.description).toBe('basic math');
    expect(view.temperatureLabel).toBe('0.2');
    expect(view.maxTokensLabel).toBe('128');
    expect(view.targets).toEqual([
      { alias: 'model-a', variantLabel: 'default' },
      { alias: 'model-b', variantLabel: 'cuda' },
    ]);
    expect(view.cases[0]).toEqual({ id: 'c1', body: 'What is 2+2?', tags: ['math'], expected: '4' });
    expect(view.cases[1]).toEqual({ id: 'c2', body: '2 messages', tags: [] });
  });

  it('labels omitted temperature and max tokens as the runtime default', () => {
    const view = suiteDefinitionView(suite());
    expect(view.description).toBeUndefined();
    expect(view.temperatureLabel).toBe('runtime default');
    expect(view.maxTokensLabel).toBe('runtime default');
  });
});
