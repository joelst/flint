import { describe, expect, it, vi } from 'vitest';
import { generateEmbeddings, openAiJsonText } from './embeddings-session.js';

function fakeSdk(response, { failDispose = false } = {}) {
  const dispose = vi.fn(() => {
    if (failDispose) throw new Error('dispose failed');
  });
  const request = {
    added: [] as unknown[],
    addItem(item: unknown) {
      this.added.push(item);
      return this;
    },
  };
  return {
    request,
    sdk: {
      Request: class {
        constructor() { return request; }
      },
      Item: { text: (text: string, textType?: string) => ({ type: 'text', text, textType }) },
      EmbeddingsSession: class {
        constructor(public model: unknown) {}
        processRequest = vi.fn(async () => response);
        dispose = dispose;
      },
    },
    dispose,
  };
}

describe('generateEmbeddings', () => {
  it('sends openai-json for the loaded variant id and returns the parsed reply', async () => {
    const { sdk, request, dispose } = fakeSdk({
      output: [{
        type: 'text',
        textType: 'openai-json',
        text: JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }] }),
      }],
    });
    const model = { id: 'bge-cpu:1', alias: 'bge' };
    const result = await generateEmbeddings(model, ['ping'], sdk);
    expect(result).toEqual({ data: [{ embedding: [0.1, 0.2], index: 0 }] });
    expect(request.added).toEqual([{
      type: 'text',
      textType: 'openai-json',
      text: JSON.stringify({ model: 'bge-cpu:1', input: ['ping'] }),
    }]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the session when generation throws and still reports that error', async () => {
    const { sdk, dispose } = fakeSdk(undefined);
    sdk.EmbeddingsSession = class {
      processRequest = vi.fn(async () => { throw new Error('native rejected'); });
      dispose = dispose;
    };
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk)).rejects.toThrow(/native rejected/);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps a successful vector when dispose fails', async () => {
    const { sdk } = fakeSdk({
      output: [{ type: 'text', textType: 'openai-json', text: '{"data":[]}' }],
    }, { failDispose: true });
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk)).resolves.toEqual({ data: [] });
  });

  it('rejects a response that is not openai-json', async () => {
    const { sdk } = fakeSdk({ output: [{ type: 'tensor', data: new Uint8Array() }] });
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk)).rejects.toThrow(/no openai-json/);
  });
});

describe('openAiJsonText', () => {
  it('ignores other text items', () => {
    expect(openAiJsonText([
      { type: 'text', text: 'hello' },
      { type: 'text', textType: 'openai-json', text: '{"ok":true}' },
    ])).toBe('{"ok":true}');
    expect(openAiJsonText(null)).toBeUndefined();
  });
});
