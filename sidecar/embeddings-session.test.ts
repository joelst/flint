import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateEmbeddings, openAiJsonText } from './embeddings-session.js';

// The hand-rolled fakeSdk() below only proves generateEmbeddings() calls the shape it
// assumes; it can't catch a real signature drift in Request, Item, or EmbeddingsSession.
// Where the native addon for this platform/arch is present, exercise the actual
// 'foundry-local-sdk' module instead of a fake — no model load is required because
// EmbeddingsSession validates `model instanceof Model` in pure JS before touching native
// code (sidecar/dist prebuild lives at prebuilds/<platform>-<arch>).
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

// No cached model in this repo's catalog declares task 'embeddings' (BYOM aside), so a
// real load-and-embed round trip isn't reachable without shipping a model binary. This
// still drives the real native addon end to end for everything short of that load, so a
// drift in the SDK's Request/Item/EmbeddingsSession contract fails here instead of only
// surfacing behind the fake in the suite above.
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
    // Confirms our call shape (model, inputs, sdk) reaches the real constructor: the SDK
    // validates `model instanceof Model` in JS before any native call, so this exercises
    // the actual contract without needing a loaded model.
    await expect(generateEmbeddings({ id: 'bge-cpu:1' }, ['ping'], sdk))
      .rejects.toThrow(/expected a Model/);
  });
});
