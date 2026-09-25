// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createSessionChatClient, createSessionEmbeddingClient, disposeSession, mergeSessionCleanupFailure } from './session-clients.js';

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

  it('serializes zero-valued settings instead of treating them as absent', async () => {
    // Number.isFinite(0) is true, so a zero temperature/penalty/topK/randomSeed must
    // still be serialized. A regression to a truthiness check (`settings.temperature &&
    // ...`) would silently drop these legitimate zero values.
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
    expect(wire.frequency_penalty).toBe(0);
    expect(wire.max_tokens).toBe(0);
    expect(wire.presence_penalty).toBe(0);
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
