// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { hasMultipartContent, selectChatTransport } from './chat-transport.js';

const text = (content) => ({ role: 'user', content });
const vision = () => ({
  role: 'user',
  content: [
    { type: 'text', text: 'what is this?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ],
});

describe('hasMultipartContent', () => {
  it('is false for an all-string thread', () => {
    expect(hasMultipartContent([text('a'), { role: 'assistant', content: 'b' }])).toBe(false);
  });

  it('is true when any message carries parts', () => {
    expect(hasMultipartContent([text('a'), vision()])).toBe(true);
  });

  it('is false for an empty or missing thread', () => {
    expect(hasMultipartContent([])).toBe(false);
    expect(hasMultipartContent(undefined)).toBe(false);
    expect(hasMultipartContent(null)).toBe(false);
  });

  it('tolerates a malformed entry', () => {
    expect(hasMultipartContent([null, undefined, 7, text('a')])).toBe(false);
  });

  it('treats a non-array argument as carrying nothing rather than throwing', () => {
    // This module turns an unroutable request into a reason the user can read, so throwing here
    // would replace that reason with a TypeError from inside selectChatTransport.
    for (const bogus of [{ 0: text('a') }, 'messages', 42, true]) {
      expect(() => hasMultipartContent(bogus)).not.toThrow();
      expect(hasMultipartContent(bogus)).toBe(false);
    }
    expect(selectChatTransport({}, { hasChatClient: true }).transport).toBe('sdk');
  });
});

describe('selectChatTransport', () => {
  const both = { hasChatClient: true, hasEndpoint: true };

  it('prefers the SDK for a text-only request', () => {
    // The SDK path avoids web-service schema and version mismatches.
    expect(selectChatTransport([text('a')], both)).toEqual({ transport: 'sdk', reason: null });
  });

  it('forces HTTP for a vision request even when the SDK client exists', () => {
    // The SDK client validates `typeof content === 'string'` and throws, so preferring it here
    // would fail every image request before inference starts.
    expect(selectChatTransport([vision()], both)).toEqual({ transport: 'http', reason: null });
  });

  it('forces HTTP when only one message in a long thread is multipart', () => {
    const thread = [text('a'), { role: 'assistant', content: 'b' }, vision()];
    expect(selectChatTransport(thread, both).transport).toBe('http');
  });

  it('falls back to HTTP for text when there is no chat client', () => {
    expect(selectChatTransport([text('a')], { hasChatClient: false, hasEndpoint: true })).toEqual({
      transport: 'http',
      reason: null,
    });
  });

  it('refuses a vision request with no endpoint, naming the real cause', () => {
    const r = selectChatTransport([vision()], { hasChatClient: true, hasEndpoint: false });
    expect(r.transport).toBeNull();
    // The SDK's own failure here is an opaque validator message about content types, which
    // tells the user nothing about what to do.
    expect(r.reason).toContain('Image input requires the local service endpoint');
  });

  it('refuses a text request with neither transport available', () => {
    const r = selectChatTransport([text('a')], { hasChatClient: false, hasEndpoint: false });
    expect(r.transport).toBeNull();
    expect(r.reason).toContain('Service endpoint unavailable');
  });

  it('treats missing capabilities as absent rather than throwing', () => {
    expect(selectChatTransport([text('a')], undefined).transport).toBeNull();
    expect(selectChatTransport([text('a')], {}).transport).toBeNull();
  });

  it('never returns a null transport without a reason', () => {
    const cases = [
      [[text('a')], { hasChatClient: false, hasEndpoint: false }],
      [[vision()], { hasChatClient: true, hasEndpoint: false }],
      [[vision()], { hasChatClient: false, hasEndpoint: false }],
    ];
    for (const [messages, caps] of cases) {
      const r = selectChatTransport(messages, caps);
      expect(r.transport).toBeNull();
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('never returns a reason alongside a usable transport', () => {
    for (const messages of [[text('a')], [vision()]]) {
      expect(selectChatTransport(messages, both).reason).toBeNull();
    }
  });
});
