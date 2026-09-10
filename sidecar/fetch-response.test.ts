import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ERROR_BODY_LIMIT,
  fetchBoundedResponseText,
  readBoundedErrorBody,
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

afterEach(() => {
  vi.useRealTimers();
});

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
    vi.useFakeTimers();
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = {
      body: new ReadableStream<Uint8Array>({ pull, cancel }),
    } as Response;

    await expect(readBoundedResponseText(response, 0, { timeoutMs: 20 })).resolves.toEqual({
      text: '',
      truncated: true,
      byteCount: 0,
    });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(vi.getTimerCount()).toBe(0);
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

  it('clears an active deadline after a successful read', async () => {
    vi.useFakeTimers();
    const { response } = responseFromChunks(['ok']);

    await expect(readBoundedResponseText(response, 16, { timeoutMs: 100 }))
      .resolves.toMatchObject({ text: 'ok', truncated: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears an active deadline after overflow', async () => {
    vi.useFakeTimers();
    const { response } = responseFromChunks(['overflow']);

    await expect(readBoundedResponseText(response, 1, { timeoutMs: 100 }))
      .resolves.toMatchObject({ text: 'o', truncated: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears an active deadline after a read failure', async () => {
    vi.useFakeTimers();
    const response = {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('read failed'));
        },
      }),
    } as Response;

    await expect(readBoundedResponseText(response, 16, { timeoutMs: 100 }))
      .rejects.toThrow('read failed');
    expect(vi.getTimerCount()).toBe(0);
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

describe('readBoundedErrorBody', () => {
  it('keeps default diagnostics within 64 KiB', () => {
    expect(DEFAULT_ERROR_BODY_LIMIT).toBe(64 * 1024);
  });

  it('normalizes a bounded JSON error body', async () => {
    const { response } = responseFromChunks(['{ "error": "bad" }']);
    Object.defineProperty(response, 'headers', {
      value: new Headers({ 'content-type': 'application/json' }),
    });

    await expect(readBoundedErrorBody(response)).resolves.toBe('{"error":"bad"}');
  });

  it('preserves malformed JSON as bounded text', async () => {
    const { response } = responseFromChunks(['{"error":']);
    Object.defineProperty(response, 'headers', {
      value: new Headers({ 'content-type': 'application/json' }),
    });

    await expect(readBoundedErrorBody(response)).resolves.toBe('{"error":');
  });

  it('preserves a truncated JSON prefix with an explicit marker', async () => {
    const onCancel = vi.fn();
    const response = {
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"too long"}'));
        },
        cancel: onCancel,
      }),
    } as Response;

    await expect(readBoundedErrorBody(response, { maxBytes: 10 })).resolves.toBe(
      '{"error":" [truncated after 10 bytes]',
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('caps oversized diagnostics and marks them as truncated', async () => {
    const limit = 64 * 1024;
    const onCancel = vi.fn();
    const bytes = new TextEncoder().encode(`${'x'.repeat(limit)}overflow`);
    const response = {
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
        },
        cancel: onCancel,
      }),
    } as Response;

    await expect(readBoundedErrorBody(response)).resolves.toBe(
      `${'x'.repeat(limit)} [truncated after ${limit} bytes]`,
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not wait indefinitely for overflow cancellation', async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    const response = {
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('overflow'));
        },
        cancel,
      }),
    } as Response;

    await expect(readBoundedErrorBody(response, { maxBytes: 1, timeoutMs: 20 }))
      .resolves.toBe('o [truncated after 1 bytes]');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds a stalled error body and preserves an explicit diagnostic', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = {
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream<Uint8Array>({ cancel }),
    } as Response;

    const result = readBoundedErrorBody(response, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe('[Response body read timed out after 0.1 seconds]');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('uses a five-second default error-body deadline', async () => {
    vi.useFakeTimers();
    const response = {
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new ReadableStream<Uint8Array>({ cancel() {} }),
    } as Response;
    let settled = false;
    const result = readBoundedErrorBody(response).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('[Response body read timed out after 5 seconds]');
  });
});
