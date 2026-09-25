// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createSessionChatClient, createSessionEmbeddingClient, disposeSession, mergeSessionCleanupFailure } from './session-clients.js';

// Minimal fake ChatSession/Request/Item, matching the shapes createSessionChatClient
// expects. `dispose()` records every call so tests can assert it always runs, including
// when the caller stops iterating a stream before it finishes naturally.
function fakeSdk({ disposeThrows = false } = {}) {
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
});
