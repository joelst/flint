// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createSessionChatClient,
  createSessionEmbeddingClient,
  disposeSession,
  mergeCleanupFailure,
  mergeSessionCleanupFailure,
  normalizeChatPenalty,
} from './session-clients.js';
import { imageDataUrl, pngDataUrl, TINY_PNG_BYTES, TINY_PNG_DATA_URL } from './test-fixtures/images';

describe('normalizeChatPenalty', () => {
  it('omits neutral and invalid penalties while preserving effective values', () => {
    expect(normalizeChatPenalty(0)).toBeUndefined();
    expect(normalizeChatPenalty(Number.NaN)).toBeUndefined();
    expect(normalizeChatPenalty(undefined)).toBeUndefined();
    expect(normalizeChatPenalty(0.1)).toBe(0.1);
    expect(normalizeChatPenalty(-0.1)).toBe(-0.1);
  });
});

describe('mergeCleanupFailure', () => {
  it('does not flatten a foreign AggregateError that happens to carry a cause', () => {
    const root = new Error('root');
    const foreign = new AggregateError([new Error('inner')], 'foreign aggregate', { cause: root });
    const cleanup = new Error('cleanup');
    const merged = mergeCleanupFailure(foreign, cleanup, 'resource disposal');
    expect(merged.cause).toBe(foreign);
    expect(merged.errors).toEqual([foreign, cleanup]);
  });

  it('flattens only its own prior cleanup merges and preserves the root error code', () => {
    const primary = Object.assign(new Error('unsupported'), { code: 'unsupported-by-runtime' });
    const first = mergeCleanupFailure(primary, new Error('queue cleanup'), 'queue disposal');
    const second = mergeCleanupFailure(first, new Error('session cleanup'), 'session disposal');
    expect(second.cause).toBe(primary);
    expect(second.code).toBe('unsupported-by-runtime');
    expect(second.errors).toEqual([
      primary,
      expect.objectContaining({ message: 'queue cleanup' }),
      expect.objectContaining({ message: 'session cleanup' }),
    ]);
  });
});

// Minimal fake ChatSession/Request/Item, matching the shapes createSessionChatClient
// expects. `dispose()` records every call so tests can assert it always runs, including
// when the caller stops iterating a stream before it finishes naturally.
function fakeSdk({ disposeThrows = false, processRequestThrows = false, processRequestNoOutput = false } = {}) {
  const disposeCalls = [];
  class Request {
    constructor() { this.items = []; }
    addItem(item) { this.items.push(item); return this; }
  }

  const Item = {
    text: (text, textType) => ({ type: 'text', textType, text }),
  };
  class ChatSession {
    constructor(model) { this.model = model; }
    async processRequest() {
      if (processRequestThrows) throw new Error('native processRequest failed');
      if (processRequestNoOutput) return { output: [] };
      return { output: [Item.text(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), 'openai-json')] };
    }
    async *processStreamingRequest() {
      yield Item.text(JSON.stringify({ choices: [{ delta: { content: 'a' } }] }), 'openai-json');
      yield Item.text(JSON.stringify({ choices: [{ delta: { content: 'b' } }] }), 'openai-json');
      yield Item.text(JSON.stringify({ choices: [{ delta: { content: 'c' } }] }), 'openai-json');
    }
    dispose() {
      disposeCalls.push(this);
      if (disposeThrows) throw new Error('native dispose failed');
    }
  }
  return { sdkModule: { ChatSession, Request, Item }, disposeCalls };
}

describe('createSessionChatClient buffered chat', () => {
  it('sends multipart messages as native text and decoded image items', async () => {
    let capturedRequest: any;
    class Request {
      items: any[] = [];
      options: any;
      addItem(item: any) { this.items.push(item); return this; }
      setOptions(options: any) { this.options = options; return this; }
    }
    const Item = {
      text: (text: string, textType = 'default') => ({ type: 'text', textType, text }),
      message: (role: string, parts: any) => ({ type: 'message', role, parts }),
      imageFromData: (format: string, data: Uint8Array) => ({ type: 'image', format, data }),
    };
    class ChatSession {
      async processRequest(request: any) {
        capturedRequest = request;
        return {
          output: [{
            type: 'message',
            role: 'assistant',
            parts: [{ type: 'text', text: 'A red square.', textType: 'default' }],
          }],
          usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
          finishReason: 'stop',
        };
      }
      dispose() {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    Object.assign(client.settings, { maxTokens: 64, temperature: 0.5, randomSeed: 7 });
    const result = await client.completeChat([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this.' },
        { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
      ],
    }]);

    expect(client.supportsMultipart).toBe(true);
    expect(capturedRequest.items).toHaveLength(1);
    expect(capturedRequest.items[0].role).toBe('user');
    expect(capturedRequest.items[0].parts[0]).toMatchObject({ type: 'text', text: 'Describe this.' });
    expect(capturedRequest.items[0].parts[1]).toMatchObject({ type: 'image', format: 'png' });
    expect(Array.from(capturedRequest.items[0].parts[1].data)).toEqual(Array.from(TINY_PNG_BYTES));
    expect(capturedRequest.options).toEqual({
      search: { maxOutputTokens: 64, temperature: 0.5, seed: 7 },
    });
    expect(result).toEqual({
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'A red square.' },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
  });

  it('rejects buffered native inference errors even when partial output exists', async () => {
    let disposeCalls = 0;
    class Request {
      addItem() { return this; }
      setOptions() { return this; }
    }
    const Item = {
      text: (text: string) => ({ type: 'text', text }),
      message: (role: string, parts: any) => ({ type: 'message', role, parts }),
      imageFromData: (format: string, data: Uint8Array) => ({ type: 'image', format, data }),
    };
    class ChatSession {
      async processRequest() {
        return {
          output: [{ type: 'message', role: 'assistant', content: 'partial answer' }],
          finishReason: 'error',
        };
      }
      dispose() { disposeCalls += 1; }
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });

    await expect(client.completeChat([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this.' },
        { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
      ],
    }])).rejects.toThrow(/native inference failed/);
    expect(disposeCalls).toBe(1);
  });

  it('rejects non-data image URLs instead of granting native file or network access', async () => {
    const { sdkModule } = fakeSdk();
    Object.assign(sdkModule.Item, {
      message: (role: string, parts: any) => ({ type: 'message', role, parts }),
      imageFromData: (format: string, data: Uint8Array) => ({ type: 'image', format, data }),
    });

    const client = createSessionChatClient({ id: 'm' }, sdkModule);
    await expect(client.completeChat([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'file:///private/image.png' } }],
    }])).rejects.toThrow('base64 data URL');
  });

  it('rejects oversized archived image data before native decoding', async () => {
    const { sdkModule } = fakeSdk();
    Object.assign(sdkModule.Item, {
      message: (role: string, parts: any) => ({ type: 'message', role, parts }),
      imageFromData: (format: string, data: Uint8Array) => ({ type: 'image', format, data }),
    });
    let decoded = false;
    const originalAtob = globalThis.atob;
    globalThis.atob = ((value: string) => {
      decoded = true;
      return originalAtob(value);
    }) as typeof atob;
    try {
      const client = createSessionChatClient({ id: 'm' }, sdkModule);
      await expect(client.completeChat([{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${'A'.repeat(350_001)}` },
        }],
      }])).rejects.toThrow(/exceeds the supported size limit/);
      expect(decoded).toBe(false);
    } finally {
      globalThis.atob = originalAtob;
    }
  });

  it('bounds decoded pixels from the header before native decoding', async () => {
    const images: Array<{ format: string }> = [];
    class Request {
      addItem() { return this; }
      setOptions() { return this; }
    }
    const Item = {
      text: (text: string) => ({ type: 'text', text }),
      message: (role: string, parts: any) => ({ type: 'message', role, parts }),
      imageFromData: (format: string, data: Uint8Array) => {
        images.push({ format });
        return { type: 'image', format, data };
      },
    };
    class ChatSession {
      async processRequest() {
        return {
          output: [{ type: 'message', role: 'assistant', content: 'ok' }],
          finishReason: 'stop',
        };
      }
      dispose() {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const send = (url: string) => client.completeChat([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url } }],
    }]);

    // A few dozen encoded bytes that would expand to 400 MB of RGBA.
    const bomb = pngDataUrl(10_000, 10_000);
    expect(bomb.length).toBeLessThan(100);
    await expect(send(bomb)).rejects.toThrow(/10000x10000, above the supported pixel limit/);
    await expect(send('data:image/png;base64,AQID')).rejects.toThrow(/unreadable image dimensions/);
    expect(images).toEqual([]);

    // The decoder sees the bytes, not the label, so the header's format is what is passed on.
    await send(imageDataUrl(TINY_PNG_BYTES, 'image/jpeg'));
    await send(pngDataUrl(4032, 3024));
    expect(images).toEqual([{ format: 'png' }, { format: 'png' }]);
  });

  it('returns the parsed response and disposes the session on success', async () => {
    const { sdkModule, disposeCalls } = fakeSdk();
    const client = createSessionChatClient({ id: 'm' }, sdkModule);
    const result = await client.completeChat([{ role: 'user', content: 'hi' }]);
    expect(result.choices[0].message.content).toBe('hi');
    expect(disposeCalls).toHaveLength(1);
  });

  it('wraps a native processRequest failure and still disposes the session', async () => {
    const { sdkModule, disposeCalls } = fakeSdk({ processRequestThrows: true });
    const client = createSessionChatClient({ id: 'm' }, sdkModule);
    await expect(client.completeChat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow("Chat completion failed for model 'm': native processRequest failed");
    expect(disposeCalls).toHaveLength(1);
  });

  it('wraps a response with no openai-json output the same way as a thrown failure', async () => {
    const { sdkModule } = fakeSdk({ processRequestNoOutput: true });
    const client = createSessionChatClient({ id: 'm' }, sdkModule);
    await expect(client.completeChat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow("returned no openai-json text item");
  });

  it('wraps a response with an undefined output list the same way as an empty one', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      async processRequest () { return {}; }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    await expect(client.completeChat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('returned no openai-json text item');
  });

  it('wraps a non-Error thrown failure using String() instead of a missing .message', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error to exercise the err?.message || err fallback
      async processRequest () { throw 'native string failure'; }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    await expect(client.completeChat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow("Chat completion failed for model 'm': native string failure");
  });

  it('includes tools, tool_choice and response_format on the wire request when provided', async () => {
    let capturedItem: { text: string } | undefined;
    class Request {
      addItem (item: { text: string }) { capturedItem = item; return this; }
    }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      async processRequest () {
        return { output: [Item.text(JSON.stringify({ choices: [] }), 'openai-json')] };
      }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const tools = [{ type: 'function', function: { name: 'noop' } }];
    const messages = [{ role: 'user', content: 'hi' }];
    await client.completeChat(messages, tools, {
      toolChoice: 'auto',
      responseFormat: { type: 'json_object' },
    });
    const wire = JSON.parse(capturedItem!.text);
    expect(wire.model).toBe('m');
    expect(wire.messages).toEqual(messages);
    expect(wire.tools).toEqual(tools);
    expect(wire.tool_choice).toBe('auto');
    expect(wire.response_format).toEqual({ type: 'json_object' });
    expect(wire.stream).toBeUndefined();
  });

  it('surfaces a disposal failure raised after a successful buffered request', async () => {
    const { sdkModule } = fakeSdk({ disposeThrows: true });
    const client = createSessionChatClient({ id: 'm' }, sdkModule);
    await expect(client.completeChat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('native dispose failed');
  });

  it('merges a disposal failure with a primary buffered failure instead of dropping either', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      async processRequest () { throw new Error('native processRequest failed'); }
      dispose () { throw new Error('native dispose failed'); }
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    let caught: AggregateError | undefined;
    try {
      await client.completeChat([{ role: 'user', content: 'hi' }]);
    } catch (err) {
      caught = err as AggregateError;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught?.cause).toBeInstanceOf(Error);
    expect((caught?.cause as Error).message).toBe("Chat completion failed for model 'm': native processRequest failed");
    expect(caught?.errors).toHaveLength(2);
    expect((caught?.errors[0] as Error).message).toBe("Chat completion failed for model 'm': native processRequest failed");
    expect((caught?.errors[1] as Error).message).toBe('native dispose failed');
    expect(caught?.message).toContain("Chat completion failed for model 'm': native processRequest failed");
    expect(caught?.message).toContain('native dispose failed');
  });

  it('skips a non-matching output item before finding the openai-json text item', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      async processRequest () {
        return {
          output: [
            { type: 'text', textType: 'other', text: 'ignored' },
            Item.text(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), 'openai-json'),
          ],
        };
      }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const result = await client.completeChat([{ role: 'user', content: 'hi' }]);
    expect(result.choices[0].message.content).toBe('hi');
  });

  it('serializes every optional sampling setting onto the wire request', async () => {
    let capturedItem: { text: string } | undefined;
    class Request {
      addItem (item: { text: string }) { capturedItem = item; return this; }
    }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      async processRequest () {
        return { output: [Item.text(JSON.stringify({ choices: [] }), 'openai-json')] };
      }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    Object.assign(client.settings, {
      frequencyPenalty: 0.1,
      maxTokens: 128,
      presencePenalty: 0.2,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      randomSeed: 7,
    });
    await client.completeChat([{ role: 'user', content: 'hi' }]);
    const wire = JSON.parse(capturedItem!.text);
    expect(wire.frequency_penalty).toBe(0.1);
    expect(wire.max_tokens).toBe(128);
    expect(wire.presence_penalty).toBe(0.2);
    expect(wire.temperature).toBe(0.7);
    expect(wire.top_p).toBe(0.9);
    expect(wire.metadata).toEqual({ top_k: '40', random_seed: '7' });
  });

  it('omits neutral penalties while preserving other zero-valued settings', async () => {
    // Foundry Local 2.0.1 misapplies an explicit frequency_penalty of 0 for some models.
    // Omission is semantically identical for penalties, but not for the other settings.
    let capturedItem: { text: string } | undefined;
    class Request {
      addItem (item: { text: string }) { capturedItem = item; return this; }
    }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      async processRequest () {
        return { output: [Item.text(JSON.stringify({ choices: [] }), 'openai-json')] };
      }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    Object.assign(client.settings, {
      frequencyPenalty: 0,
      maxTokens: 0,
      presencePenalty: 0,
      temperature: 0,
      topP: 0,
      topK: 0,
      randomSeed: 0,
    });
    await client.completeChat([{ role: 'user', content: 'hi' }]);
    const wire = JSON.parse(capturedItem!.text);
    expect(wire.frequency_penalty).toBeUndefined();
    expect(wire.max_tokens).toBe(0);
    expect(wire.presence_penalty).toBeUndefined();
    expect(wire.temperature).toBe(0);
    expect(wire.top_p).toBe(0);
    expect(wire.metadata).toEqual({ top_k: '0', random_seed: '0' });
  });

  it('omits non-finite settings instead of serializing NaN/Infinity', async () => {
    let capturedItem: { text: string } | undefined;
    class Request {
      addItem (item: { text: string }) { capturedItem = item; return this; }
    }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      async processRequest () {
        return { output: [Item.text(JSON.stringify({ choices: [] }), 'openai-json')] };
      }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    Object.assign(client.settings, {
      frequencyPenalty: NaN,
      maxTokens: Infinity,
      presencePenalty: undefined,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      randomSeed: undefined,
    });
    await client.completeChat([{ role: 'user', content: 'hi' }]);
    const wire = JSON.parse(capturedItem!.text);
    expect(wire.frequency_penalty).toBeUndefined();
    expect(wire.max_tokens).toBeUndefined();
    expect(wire.presence_penalty).toBeUndefined();
    expect(wire.temperature).toBeUndefined();
    expect(wire.top_p).toBeUndefined();
    expect(wire.metadata).toBeUndefined();
  });
});

describe('createSessionChatClient fallback', () => {
  it('returns null when the SDK build does not export ChatSession/Request/Item', () => {
    expect(createSessionChatClient({ id: 'm' }, {})).toBeNull();
    expect(createSessionChatClient({ id: 'm' }, undefined)).toBeNull();
    expect(createSessionChatClient({ id: 'm' }, { ChatSession: class {} })).toBeNull();
    expect(createSessionChatClient({ id: 'm' }, { ChatSession: class {}, Request: class {} })).toBeNull();
  });

  it('returns null when an export is present but not the expected type, not merely absent', () => {
    const ChatSession = class {};
    const Request = class {};
    // A truthy-but-non-function ChatSession/Request must still be rejected: the guard is
    // `typeof X !== 'function'`, not a truthiness check.
    expect(createSessionChatClient({ id: 'm' }, { ChatSession: {}, Request, Item: { text: () => {} } })).toBeNull();
    expect(createSessionChatClient({ id: 'm' }, { ChatSession, Request: {}, Item: { text: () => {} } })).toBeNull();
    expect(createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item: {} })).toBeNull();
    expect(createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item: { text: 'not-a-function' } })).toBeNull();
  });
});

describe('createSessionChatClient streaming disposal', () => {
  it('adapts native multimodal deltas and terminal metadata to OpenAI-shaped chunks', async () => {
    class Request {
      items: any[] = [];
      addItem(item: any) { this.items.push(item); return this; }
      setOptions() { return this; }
    }
    const Item = {
      text: (text: string, textType = 'default') => ({ type: 'text', textType, text }),
      message: (role: string, parts: any) => ({ type: 'message', role, parts }),
      imageFromData: (format: string, data: Uint8Array) => ({ type: 'image', format, data }),
    };
    class ChatSession {
      processStreamingRequest() {
        const iterable = {
          async *[Symbol.asyncIterator]() {
            yield Item.text('red');
            yield Item.text(' square');
          },
          response: Promise.resolve({
            output: [],
            usage: { promptTokens: 9, completionTokens: 2, totalTokens: 11 },
            finishReason: 'length',
          }),
        };
        return iterable;
      }
      dispose() {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const chunks = [];
    for await (const chunk of client.completeStreamingChat([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this.' },
        { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
      ],
    }])) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'red' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { role: 'assistant', content: ' square' }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      },
    ]);
  });

  it('rejects a native terminal inference error after preserving emitted partial deltas', async () => {
    let disposeCalls = 0;
    class Request {
      addItem() { return this; }
      setOptions() { return this; }
    }
    const Item = {
      text: (text: string) => ({ type: 'text', text }),
      message: (role: string, parts: any) => ({ type: 'message', role, parts }),
      imageFromData: (format: string, data: Uint8Array) => ({ type: 'image', format, data }),
    };
    class ChatSession {
      processStreamingRequest() {
        return {
          async *[Symbol.asyncIterator]() {
            yield Item.text('partial answer');
          },
          response: Promise.resolve({
            output: [],
            finishReason: 'error',
          }),
        };
      }
      dispose() { disposeCalls += 1; }
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const iterator = client.completeStreamingChat([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this.' },
        { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
      ],
    }])[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { choices: [{ delta: { content: 'partial answer' } }] },
    });
    await expect(iterator.next()).rejects.toThrow(/native inference failed/);
    expect(disposeCalls).toBe(1);
  });

  it('handles a rejected terminal response when a multimodal consumer stops early', async () => {
    class Request {
      addItem() { return this; }
      setOptions() { return this; }
    }
    const Item = {
      text: (text: string, textType = 'default') => ({ type: 'text', textType, text }),
      message: (role: string, parts: any) => ({ type: 'message', role, parts }),
      imageFromData: (format: string, data: Uint8Array) => ({ type: 'image', format, data }),
    };
    let rejectResponse!: (error: Error) => void;
    const response = new Promise((_, reject) => { rejectResponse = reject; });
    const catchSpy = vi.spyOn(response, 'catch');
    class ChatSession {
      processStreamingRequest() {
        return {
          async *[Symbol.asyncIterator]() {
            yield Item.text('partial');
            await new Promise(() => {});
          },
          response,
        };
      }
      dispose() {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const iterator = client.completeStreamingChat([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this.' },
        { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
      ],
    }])[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { choices: [{ delta: { content: 'partial' } }] } });
    rejectResponse(new Error('terminal response failed'));
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    await Promise.resolve();
    expect(catchSpy).toHaveBeenCalledOnce();
  });

  it('disposes the native session when the stream is fully consumed', async () => {
    const { sdkModule, disposeCalls } = fakeSdk();
    const client = createSessionChatClient({ id: 'm' }, sdkModule);
    const chunks = [];
    for await (const chunk of client.completeStreamingChat([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    expect(disposeCalls).toHaveLength(1);
  });

  it('skips a non-matching streamed item before yielding the matching ones', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      async *processStreamingRequest () {
        yield { type: 'text', textType: 'other', text: 'ignored' };
        yield Item.text(JSON.stringify({ choices: [{ delta: { content: 'a' } }] }), 'openai-json');
      }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const chunks = [];
    for await (const chunk of client.completeStreamingChat([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
  });

  it('includes tools, tool_choice and response_format on the streamed wire request when provided', async () => {
    let capturedItem: { text: string } | undefined;
    class Request {
      addItem (item: { text: string }) { capturedItem = item; return this; }
    }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      async *processStreamingRequest () {
        yield Item.text(JSON.stringify({ choices: [{ delta: { content: 'a' } }] }), 'openai-json');
      }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const tools = [{ type: 'function', function: { name: 'noop' } }];
    const messages = [{ role: 'user', content: 'hi' }];
    const chunks = [];
    for await (const chunk of client.completeStreamingChat(messages, tools, {
      toolChoice: 'auto',
      responseFormat: { type: 'json_object' },
    })) {
      chunks.push(chunk);
    }
    const wire = JSON.parse(capturedItem!.text);
    expect(wire.model).toBe('m');
    expect(wire.messages).toEqual(messages);
    expect(wire.stream).toBe(true);
    expect(wire.tools).toEqual(tools);
    expect(wire.tool_choice).toBe('auto');
    expect(wire.response_format).toEqual({ type: 'json_object' });
  });

  // This is the PR #173 review finding: a consumer that stops iterating early (a `break`,
  // or any exception thrown from the loop body, both invoke the async generator's
  // `.return()`) must still dispose the native ChatSession. Disposal living after the
  // try/catch instead of in a `finally` would leak it, because a `.return()` completion
  // skips everything after the try/catch and only runs `finally` blocks.
  it('disposes the native session when the consumer stops iterating early', async () => {
    const { sdkModule, disposeCalls } = fakeSdk();
    const client = createSessionChatClient({ id: 'm' }, sdkModule);
    const iterator = client.completeStreamingChat([{ role: 'user', content: 'hi' }])[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await iterator.return();
    expect(disposeCalls).toHaveLength(1);
  });

  it('surfaces a disposal failure raised by an early return() instead of swallowing it', async () => {
    const { sdkModule, disposeCalls } = fakeSdk({ disposeThrows: true });
    const client = createSessionChatClient({ id: 'm' }, sdkModule);
    const iterator = client.completeStreamingChat([{ role: 'user', content: 'hi' }])[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.return()).rejects.toThrow('native dispose failed');
    expect(disposeCalls).toHaveLength(1);
  });

  it('passes an AbortError through unwrapped and still disposes the session', async () => {
    const disposeCalls: unknown[] = [];
    let abortError: Error | undefined;
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      // eslint-disable-next-line require-yield -- must throw before any yield to exercise the abort path
      async *processStreamingRequest () {
        abortError = new Error('native stream aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }
      dispose () { disposeCalls.push(this); }
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const iterator = client.completeStreamingChat([{ role: 'user', content: 'hi' }])[Symbol.asyncIterator]();
    let caught: Error | undefined;
    try {
      await iterator.next();
    } catch (err) {
      caught = err as Error;
    }
    // The AbortError must pass through by identity, not merely by carrying a matching
    // message: a regression that started re-wrapping it (e.g. into the generic
    // "Streaming chat completion failed for model '...'" error, which also contains this
    // message as its suffix) would otherwise still satisfy a message-only assertion.
    expect(caught).toBe(abortError);
    expect(caught?.name).toBe('AbortError');
    expect(disposeCalls).toHaveLength(1);
  });

  it('preserves a frozen AbortError by identity when disposal also fails and reports safe diagnostics', async () => {
    const disposeCalls: unknown[] = [];
    const diagnostics: unknown[] = [];
    const existingCause = new Error('existing abort cause');
    const abortError = Object.freeze(Object.assign(
      new Error('native stream aborted'),
      { name: 'AbortError', cause: existingCause },
    ));
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      // eslint-disable-next-line require-yield -- must throw before any yield to exercise abort plus cleanup
      async *processStreamingRequest () { throw abortError; }
      dispose () {
        disposeCalls.push(this);
        throw new Error('SECRET_NATIVE_CLEANUP_DETAIL');
      }
    }
    const client = createSessionChatClient(
      { id: 'm' },
      { ChatSession, Request, Item },
      { onDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic) },
    );
    const iterator = client.completeStreamingChat([{ role: 'user', content: 'hi' }])[Symbol.asyncIterator]();
    let caught: Error | undefined;
    try {
      await iterator.next();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBe(abortError);
    expect((caught as Error & { cause?: unknown }).cause).toBe(existingCause);
    expect(disposeCalls).toHaveLength(1);
    expect(diagnostics).toEqual([{
      code: 'chat-session-dispose-after-abort',
      message: 'ChatSession disposal failed after streaming cancellation.',
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET_NATIVE_CLEANUP_DETAIL');
  });

  it('wraps a stream that ends without any openai-json output', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    // eslint-disable-next-line require-yield -- deliberately empty to exercise the no-output guard
    class ChatSession { async *processStreamingRequest () {} dispose () {} }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const iterator = client.completeStreamingChat([{ role: 'user', content: 'hi' }])[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("returned no openai-json text item");
  });

  it('wraps a non-abort thrown error the same way an empty stream is wrapped', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    // eslint-disable-next-line require-yield -- must throw before any yield to exercise the wrapping path
    class ChatSession { async *processStreamingRequest () { throw new Error('native stream failed'); } dispose () {} }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const iterator = client.completeStreamingChat([{ role: 'user', content: 'hi' }])[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("Streaming chat completion failed for model 'm': native stream failed");
  });

  it('wraps a non-Error thrown failure using String() instead of a missing .message', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class ChatSession {
      // eslint-disable-next-line require-yield, prefer-promise-reject-errors -- deliberately non-Error to exercise the err?.message || err fallback
      async *processStreamingRequest () { throw 'native string failure'; }
      dispose () {}
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const iterator = client.completeStreamingChat([{ role: 'user', content: 'hi' }])[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("Streaming chat completion failed for model 'm': native string failure");
  });

  it('merges a disposal failure with a primary streaming failure instead of dropping either', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    // eslint-disable-next-line require-yield -- must throw before any yield to pair with a disposal failure
    class ChatSession {
      async *processStreamingRequest () { throw new Error('native stream failed'); }
      dispose () { throw new Error('native dispose failed'); }
    }
    const client = createSessionChatClient({ id: 'm' }, { ChatSession, Request, Item });
    const iterator = client.completeStreamingChat([{ role: 'user', content: 'hi' }])[Symbol.asyncIterator]();
    let caught: Error | undefined;
    try {
      await iterator.next();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).cause).toBeInstanceOf(Error);
    expect(((caught as AggregateError).cause as Error).message).toContain('native stream failed');
    expect(caught?.message).toContain('native dispose failed');
    const aggregate = caught as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message).toBe("Streaming chat completion failed for model 'm': native stream failed");
    expect((aggregate.errors[1] as Error).message).toBe('native dispose failed');
    expect(caught?.message).toContain("Streaming chat completion failed for model 'm': native stream failed");
  });
});

describe('session cleanup helpers', () => {
  it('disposeSession is a no-op when no session was constructed', () => {
    expect(disposeSession(undefined, null)).toBeNull();
    const primary = new Error('boom');
    expect(disposeSession(undefined, primary)).toBe(primary);
  });

  it('mergeSessionCleanupFailure preserves the primary failure as the cause', () => {
    const primary = new Error('primary');
    const cleanup = new Error('cleanup');
    const merged = mergeSessionCleanupFailure(primary, cleanup);
    expect(merged).toBeInstanceOf(AggregateError);
    expect(merged.cause).toBe(primary);
    expect(merged.errors).toEqual([primary, cleanup]);
  });

  it('falls back to String() when a failure has no .message property', () => {
    const merged = mergeSessionCleanupFailure('primary string failure', 'cleanup string failure');
    expect(merged.message).toBe('primary string failure; session disposal failed: cleanup string failure');
  });
});

describe('createSessionEmbeddingClient', () => {
  it('disposes the native session after a buffered request', async () => {
    const disposeCalls = [];
    class Request {
      addItem(item) { this.item = item; return this; }
    }
    const Item = { text: (text, textType) => ({ type: 'text', textType, text }) };
    class EmbeddingsSession {
      async processRequest() {
        return { output: [Item.text(JSON.stringify({ data: [{ embedding: [0.1] }] }), 'openai-json')] };
      }
      dispose() { disposeCalls.push(this); }
    }
    const client = createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item });
    const result = await client.generateEmbeddings(['hi']);
    expect(result.data[0].embedding).toEqual([0.1]);
    expect(disposeCalls).toHaveLength(1);
  });

  it('skips a non-matching output item before finding the openai-json text item', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class EmbeddingsSession {
      async processRequest () {
        return {
          output: [
            { type: 'text', textType: 'other', text: 'ignored' },
            Item.text(JSON.stringify({ data: [{ embedding: [0.1] }] }), 'openai-json'),
          ],
        };
      }
      dispose () {}
    }
    const client = createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item });
    const result = await client.generateEmbeddings(['hi']);
    expect(result.data[0].embedding).toEqual([0.1]);
  });

  it('wraps a native processRequest failure and still disposes the session', async () => {
    const disposeCalls: unknown[] = [];
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class EmbeddingsSession {
      async processRequest () { throw new Error('native embedding request failed'); }
      dispose () { disposeCalls.push(this); }
    }
    const client = createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item });
    await expect(client.generateEmbeddings(['hi']))
      .rejects.toThrow("Embedding generation failed for model 'm': native embedding request failed");
    expect(disposeCalls).toHaveLength(1);
  });

  it('wraps a response with no openai-json output the same way as a thrown failure', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class EmbeddingsSession {
      async processRequest () { return { output: [] }; }
      dispose () {}
    }
    const client = createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item });
    await expect(client.generateEmbeddings(['hi']))
      .rejects.toThrow('returned no openai-json text item');
  });

  it('wraps a response with an undefined output list the same way as an empty one', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class EmbeddingsSession {
      async processRequest () { return {}; }
      dispose () {}
    }
    const client = createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item });
    await expect(client.generateEmbeddings(['hi']))
      .rejects.toThrow('returned no openai-json text item');
  });

  it('wraps a non-Error thrown failure using String() instead of a missing .message', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class EmbeddingsSession {
      // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error to exercise the err?.message || err fallback
      async processRequest () { throw 'native string failure'; }
      dispose () {}
    }
    const client = createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item });
    await expect(client.generateEmbeddings(['hi']))
      .rejects.toThrow("Embedding generation failed for model 'm': native string failure");
  });

  it('surfaces a disposal failure raised after a successful buffered request', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class EmbeddingsSession {
      async processRequest () {
        return { output: [Item.text(JSON.stringify({ data: [{ embedding: [0.1] }] }), 'openai-json')] };
      }
      dispose () { throw new Error('native dispose failed'); }
    }
    const client = createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item });
    await expect(client.generateEmbeddings(['hi'])).rejects.toThrow('native dispose failed');
  });

  it('merges a disposal failure with a primary embedding failure instead of dropping either', async () => {
    class Request { addItem() { return this; } }
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class EmbeddingsSession {
      async processRequest () { throw new Error('native embedding request failed'); }
      dispose () { throw new Error('native dispose failed'); }
    }
    const client = createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item });
    let caught: AggregateError | undefined;
    try {
      await client.generateEmbeddings(['hi']);
    } catch (err) {
      caught = err as AggregateError;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught?.cause).toBeInstanceOf(Error);
    expect((caught?.cause as Error).message).toBe("Embedding generation failed for model 'm': native embedding request failed");
    expect(caught?.errors).toHaveLength(2);
    expect((caught?.errors[0] as Error).message).toBe("Embedding generation failed for model 'm': native embedding request failed");
    expect((caught?.errors[1] as Error).message).toBe('native dispose failed');
  });

  it('returns null when the SDK build does not export EmbeddingsSession/Request/Item', () => {
    expect(createSessionEmbeddingClient({ id: 'm' }, {})).toBeNull();
    expect(createSessionEmbeddingClient({ id: 'm' }, undefined)).toBeNull();
    expect(createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession: class {} })).toBeNull();
    expect(createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession: class {}, Request: class {} })).toBeNull();
  });

  it('returns null when an export is present but not the expected type, not merely absent', () => {
    const EmbeddingsSession = class {};
    const Request = class {};
    // A truthy-but-non-function EmbeddingsSession/Request must still be rejected: the
    // guard is `typeof X !== 'function'`, not a truthiness check.
    expect(createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession: {}, Request, Item: { text: () => {} } })).toBeNull();
    expect(createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request: {}, Item: { text: () => {} } })).toBeNull();
    expect(createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item: {} })).toBeNull();
    expect(createSessionEmbeddingClient({ id: 'm' }, { EmbeddingsSession, Request, Item: { text: 'not-a-function' } })).toBeNull();
  });
});

// V8's JSON.parse quotes an excerpt of its input ("Unexpected token 'S', \"SENSITIVE_\"...
// is not valid JSON"). These wrappers copy err.message into the error the sidecar
// forwards over IPC and writes to the app log, so a malformed model response must never
// carry generated text, tool-call arguments or echoed prompt content into that message.
describe('session client malformed output redaction', () => {
  const SECRET = 'SENSITIVE_PROMPT_a1b2c3_user@example.com';
  // A model emitting prose instead of JSON is the realistic failure, and it is the shape
  // whose parser error quotes the input.
  const MALFORMED = `${SECRET} - I could not answer that.`;
  const LEAKY = /SENSITIVE_|a1b2c3|example\.com/;

  async function messageOf (run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (e) {
      return e instanceof Error ? `${e.message}` : String(e);
    }
    throw new Error('expected the operation to reject');
  }

  function malformedSdk() {
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class Request {
      items: unknown[] = [];
      addItem(item: unknown) { this.items.push(item); return this; }
    }
    class Session {
      async processRequest() { return { output: [Item.text(MALFORMED, 'openai-json')] }; }
      async *processStreamingRequest() { yield Item.text(MALFORMED, 'openai-json'); }
      dispose() {}
    }
    return { ChatSession: Session, EmbeddingsSession: Session, Request, Item };
  }

  // Anchors the whole suite: if the runtime ever stops quoting the input, these tests
  // would otherwise start passing for the wrong reason.
  it('confirms the unredacted parser error would leak the payload', () => {
    let raw = '';
    try { JSON.parse(MALFORMED); } catch (e) { raw = (e as Error).message; }
    expect(raw).toMatch(LEAKY);
  });

  it('keeps model output out of buffered chat errors', async () => {
    const client = createSessionChatClient({ id: 'm' }, malformedSdk());
    const message = await messageOf(() => client.completeChat([], undefined));
    expect(message).toMatch(/not valid JSON \(\d+ bytes\)/);
    expect(message).not.toMatch(LEAKY);
  });

  it('keeps model output out of streaming chat errors', async () => {
    const client = createSessionChatClient({ id: 'm' }, malformedSdk());
    const message = await messageOf(async () => {
      for await (const _chunk of client.completeStreamingChat([], undefined)) { /* consume */ }
    });
    expect(message).toMatch(/not valid JSON \(\d+ bytes\)/);
    expect(message).not.toMatch(LEAKY);
  });

  it('keeps embedding output out of errors', async () => {
    const client = createSessionEmbeddingClient({ id: 'e' }, malformedSdk());
    const message = await messageOf(() => client.generateEmbeddings(['x']));
    expect(message).toMatch(/not valid JSON \(\d+ bytes\)/);
    expect(message).not.toMatch(LEAKY);
  });

  it('reports UTF-8 byte length, not UTF-16 code units', async () => {
    const Item = { text: (text: string, textType: string) => ({ type: 'text', textType, text }) };
    class Request { items: unknown[] = []; addItem(i: unknown) { this.items.push(i); return this; } }
    class Session {
      async processRequest() { return { output: [Item.text('\u00e9\u{1F642}', 'openai-json')] }; }
      dispose() {}
    }
    const client = createSessionEmbeddingClient({ id: 'e' }, { EmbeddingsSession: Session, Request, Item });
    // 'e-acute + slightly-smiling-face' is 3 UTF-16 code units but 6 UTF-8 bytes.
    const message = await messageOf(() => client.generateEmbeddings(['x']));
    expect(message).toContain('(6 bytes)');
  });
});
