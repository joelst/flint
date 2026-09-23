import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildEndpointModelClassifier,
  endpointModelKind,
} from './endpoint-model-classification';

describe('endpoint model classification', () => {
  it('classifies metadata independently for every catalog model', () => {
    const classify = buildEndpointModelClassifier([
      {
        alias: 'vectorizer-one',
        task: 'embeddings',
        info: {},
        variants: [{ id: 'custom-model-one-generic-cpu:1' }],
      },
      {
        alias: 'semantic-two',
        capabilities: ['embedding'],
        variants: [{ id: 'custom-model-two-generic-cpu:2' }],
      },
    ]);

    expect(classify('custom-model-one-generic-cpu', 'vectorizer-one')).toBe('embed');
    expect(classify('custom-model-two-generic-cpu:2', 'semantic-two')).toBe('embed');
  });

  it('uses narrow speech metadata without treating generic speech capability text as STT', () => {
    expect(endpointModelKind({
      alias: 'audio-chat',
      capabilities: ['speech-input'],
    })).toBe('chat');
    expect(endpointModelKind({
      alias: 'opaque-audio-model',
      task: 'stt',
    })).toBe('speech');
  });

  it('ignores blank aliases and parentless lookups instead of creating a shared empty key', () => {
    const classify = buildEndpointModelClassifier([
      { alias: '', task: 'embeddings' },
      { alias: 'chat-model', task: 'chat-completion' },
    ]);

    expect(classify('opaque-parentless-model', null)).toBeNull();
    expect(classify('chat-model', null)).toBe('chat');
  });

  it('lets an exact parent identify an opaque variant before its own id lookup', () => {
    const classify = buildEndpointModelClassifier([
      {
        alias: 'vectorizer',
        task: 'embeddings',
        variants: [{ id: 'shared-id:1' }],
      },
      {
        alias: 'chat-model',
        task: 'chat-completion',
        variants: [{ id: 'shared-id:2' }],
      },
    ]);

    expect(classify('shared-id', 'vectorizer')).toBe('embed');
    expect(classify('shared-id', 'chat-model')).toBe('chat');
  });

  it('wires the covered catalog classifier into the page self-test call', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
    const start = source.indexOf('async function runGatewaySelfTest()');
    const end = source.indexOf('endpointSelfTestBusy = false;', start);
    const selfTestFlow = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(selfTestFlow).toContain('buildEndpointModelClassifier(state.models)');
    expect(selfTestFlow).toContain('classifyModel,');
  });
});
