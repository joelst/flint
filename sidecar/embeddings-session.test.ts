import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateEmbeddings, openAiJsonText } from './embeddings-session.js';

// The hand-rolled fakeSdk() below only proves generateEmbeddings() calls the shape it
// assumes; it can't catch a real signature drift in Request, Item, or EmbeddingsSession.
// Where the native addon for this platform/arch is present, exercise the actual
// 'foundry-local-sdk' module instead of a fake. Constructing Request loads that addon;
// no model load is required for the constructor validation below.
const nativeAddonPath = path.resolve(
  'node_modules/foundry-local-sdk/prebuilds',
  `${process.platform}-${process.arch}`,
  'foundry_local_node.node',
);
const hasNativeAddon = fs.existsSync(nativeAddonPath);

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
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk))
      .rejects.toThrow(/Embedding generation failed.*native rejected/);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('returns a completed vector and reports a dispose warning', async () => {
    const { sdk } = fakeSdk({
      output: [{ type: 'text', textType: 'openai-json', text: '{"data":[]}' }],
    }, { failDispose: true });
    const warn = vi.fn();
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk, warn))
      .resolves.toEqual({ data: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cleanup failed.*dispose failed/));
  });

  it('reports both generation and cleanup failures', async () => {
    const { sdk, dispose } = fakeSdk(undefined, { failDispose: true });
    sdk.EmbeddingsSession = class {
      processRequest = vi.fn(async () => { throw new Error('native rejected'); });
      dispose = dispose;
    };
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk))
      .rejects.toThrow(/native rejected.*cleanup also failed.*dispose failed/i);
  });

  it('rejects a response that is not openai-json', async () => {
    const { sdk } = fakeSdk({ output: [{ type: 'tensor', data: new Uint8Array() }] });
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk)).rejects.toThrow(/no openai-json/);
  });

  it('adds model context when openai-json is malformed', async () => {
    const { sdk } = fakeSdk({
      output: [{ type: 'text', textType: 'openai-json', text: '{' }],
    });
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk))
      .rejects.toThrow(/model 'bge-cpu:1'.*invalid openai-json/i);
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

// No cached model in this repo's catalog declares task 'embeddings' (BYOM aside), so a
// real load-and-embed round trip isn't reachable without shipping a model binary. These
// checks cover the actual Request/Item/session-constructor surface; the openai-json
// response contract remains covered by the fake above and mirrors SDK 2.0.1's deprecated
// EmbeddingClient implementation.
describe.skipIf(!hasNativeAddon)('generateEmbeddings against the real foundry-local-sdk', () => {
  it('sends a real openai-json Request item with the shape generateEmbeddings assumes', async () => {
    const sdk = await import('foundry-local-sdk');
    const item = sdk.Item.text(JSON.stringify({ model: 'bge-cpu:1', input: ['ping'] }), 'openai-json');
    expect(item).toEqual({ type: 'text', textType: 'openai-json', text: JSON.stringify({ model: 'bge-cpu:1', input: ['ping'] }) });
    const request = new sdk.Request();
    request.addItem(item);
    expect(request.itemCount).toBe(1);
  });

  it('surfaces the real EmbeddingsSession task-validation error for a non-Model argument', async () => {
    const sdk = await import('foundry-local-sdk');
    // Confirms our call shape reaches the real constructor and its Model validation
    // without requiring a loaded embeddings model.
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk))
      .rejects.toThrow(/expected a Model/);
  });
});
