import { describe, expect, it, vi } from 'vitest';
import {
  fetchBoundedResponseText,
  readBoundedResponseText,
} from './fetch-response.js';

function responseFromChunks(chunks: string[], onCancel = vi.fn()) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    response: {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[index++]));
        },
        cancel: onCancel,
      }),
    } as Response,
    onCancel,
  };
}

describe('readBoundedResponseText', () => {
  it('reads a complete response below the byte limit', async () => {
    const { response, onCancel } = responseFromChunks(['hello ', 'world']);

    await expect(readBoundedResponseText(response, 32)).resolves.toEqual({
      text: 'hello world',
      truncated: false,
      byteCount: 11,
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('keeps only the byte-limited prefix and cancels the remainder', async () => {
    const { response, onCancel } = responseFromChunks(['abcd', 'efgh']);

    await expect(readBoundedResponseText(response, 6)).resolves.toEqual({
      text: 'abcdef',
      truncated: true,
      byteCount: 6,
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('supports a zero-byte headers-only read without consuming the body', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = {
      body: new ReadableStream<Uint8Array>({ pull, cancel }),
    } as Response;

    await expect(readBoundedResponseText(response, 0)).resolves.toEqual({
      text: '',
      truncated: true,
      byteCount: 0,
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves complete UTF-8 characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('A😀B');
    let index = 0;
    const response = {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index === 0) controller.enqueue(bytes.subarray(0, 3));
          else if (index === 1) controller.enqueue(bytes.subarray(3));
          else controller.close();
          index += 1;
        },
      }),
    } as Response;

    await expect(readBoundedResponseText(response, 16)).resolves.toMatchObject({
      text: 'A😀B',
      truncated: false,
    });
  });

  it('accepts a successful response with no body', async () => {
    await expect(readBoundedResponseText({ body: null } as Response, 16))
      .resolves.toEqual({ text: '', truncated: false, byteCount: 0 });
  });

  it('drops an incomplete UTF-8 character at the byte limit', async () => {
    const { response } = responseFromChunks(['éé']);
    await expect(readBoundedResponseText(response, 3)).resolves.toMatchObject({
      text: 'é',
      truncated: true,
      byteCount: 3,
    });
  });
});

describe('fetchBoundedResponseText', () => {
  it('keeps the deadline active after headers while the body stalls', async () => {
    let bodyCancelled = false;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              bodyCancelled = true;
              controller.error(new DOMException('Aborted', 'AbortError'));
            });
          },
        }),
      } as Response;
    });

    await expect(fetchBoundedResponseText(fetchImpl as typeof fetch, 'https://example.test', {
      timeoutMs: 20,
      maxBytes: 16,
    })).rejects.toThrow();
    expect(bodyCancelled).toBe(true);
  });

  it('cancels an unused streaming HTTP error body', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: { cancel },
    } as unknown as Response));

    await expect(fetchBoundedResponseText(
      fetchImpl as typeof fetch,
      'https://example.test',
    )).rejects.toThrow('HTTP 500 Internal Server Error');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
