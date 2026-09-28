// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  hasMultipartContent,
  normalizeTextPartsForLegacyClient,
  selectChatTransport,
} from './chat-transport.js';

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

  it('is true when any message carries an image part', () => {
    expect(hasMultipartContent([text('a'), vision()])).toBe(true);
  });

  it('does not classify a text-only parts array as vision', () => {
    expect(hasMultipartContent([text([{ type: 'text', text: 'hello' }])])).toBe(false);
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
    expect(selectChatTransport({}, { chatClient: 'available' }).transport).toBe('sdk');
  });
});

describe('normalizeTextPartsForLegacyClient', () => {
  it('joins text-only content parts without changing their message metadata', () => {
    const messages = [
      { role: 'user', name: 'client', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] },
    ];
    expect(normalizeTextPartsForLegacyClient(messages)).toEqual([
      { role: 'user', name: 'client', content: 'hello world' },
    ]);
    expect(messages[0].content).toHaveLength(2);
  });

  it('does not change strings or multipart image messages', () => {
    const messages = [text('plain'), vision()];
    expect(normalizeTextPartsForLegacyClient(messages)).toEqual(messages);
  });
});

describe('selectChatTransport', () => {
  const both = {
    chatClient: 'available',
    multimodalClient: 'available',
    serviceEndpoint: 'available',
  };

  it('prefers the SDK for a text-only request', () => {
    // The SDK path avoids web-service schema and version mismatches.
    expect(selectChatTransport([text('a')], both)).toEqual({ transport: 'sdk', reason: null });
  });

  it('uses the native multimodal SDK session for a vision request', () => {
    expect(selectChatTransport([vision()], both)).toEqual({ transport: 'sdk', reason: null });
  });

  it('uses the native multimodal SDK session when one message in a long thread has an image', () => {
    const thread = [text('a'), { role: 'assistant', content: 'b' }, vision()];
    expect(selectChatTransport(thread, both).transport).toBe('sdk');
  });

  it('falls back to HTTP for text when there is no chat client', () => {
    expect(selectChatTransport([text('a')], { chatClient: 'unsupported', serviceEndpoint: 'available' })).toEqual({
      transport: 'http',
      reason: null,
    });
  });

  it('serves vision without the HTTP endpoint when native multimodal sessions are available', () => {
    const r = selectChatTransport([vision()], {
      chatClient: 'available',
      multimodalClient: 'available',
      serviceEndpoint: 'unavailable',
    });
    expect(r).toEqual({ transport: 'sdk', reason: null });
  });

  it('refuses vision when native multimodal sessions are unavailable instead of silently using HTTP', () => {
    const r = selectChatTransport([vision()], {
      chatClient: 'available',
      multimodalClient: 'unsupported',
      serviceEndpoint: 'available',
    });
    expect(r.transport).toBeNull();
    expect(r.reason).toContain('native multimodal');
  });

  it('refuses a text request with neither transport available', () => {
    const r = selectChatTransport([text('a')], { chatClient: 'unsupported', serviceEndpoint: 'unavailable' });
    expect(r.transport).toBeNull();
    expect(r.reason).toContain('Service endpoint unavailable');
  });

  it('treats missing capabilities as absent rather than throwing', () => {
    expect(selectChatTransport([text('a')], undefined).transport).toBeNull();
    expect(selectChatTransport([text('a')], {}).transport).toBeNull();
  });

  it('never returns a null transport without a reason', () => {
    const cases = [
      [[text('a')], { chatClient: 'unsupported', serviceEndpoint: 'unavailable' }],
      [[vision()], { chatClient: 'available', multimodalClient: 'unsupported', serviceEndpoint: 'available' }],
      [[vision()], { chatClient: 'unsupported', serviceEndpoint: 'unavailable' }],
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
