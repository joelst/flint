import { describe, expect, it } from 'vitest';
import { getAllPersonas, getModelTags, scorePersonaForModel } from './personas';

describe('persona helpers', () => {
  it('detects model tags from alias/task/capabilities', () => {
    const tags = getModelTags('qwen-vision-coder', {
      task: 'automatic-speech-recognition',
      capabilities: 'image+code'
    });

    expect(tags).toContain('vision');
    expect(tags).toContain('coding');
    expect(tags).toContain('audio');
  });

  it('falls back to general tag when no specialty is detected', () => {
    const tags = getModelTags('tiny-model', {});
    expect(tags).toEqual(['general']);
  });

  it('prefers matching persona tags', () => {
    const score = scorePersonaForModel(
      { id: 'p1', name: 'Coder', prompt: 'x', tags: ['coding', 'general'] },
      ['coding']
    );
    expect(score).toBeGreaterThan(2);
  });

  it('allows custom personas to override predefined ids', () => {
    const all = getAllPersonas([
      { id: 'default', name: 'My Default', prompt: 'custom prompt', tags: ['general'] }
    ]);
    const overridden = all.find((p) => p.id === 'default');
    expect(overridden?.name).toBe('My Default');
  });
});
