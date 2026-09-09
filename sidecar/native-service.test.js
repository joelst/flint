import { describe, expect, it, vi } from 'vitest';
import {
  stopNativeWebService,
  waitForHttpReady,
} from './native-service.js';

describe('stopNativeWebService', () => {
  it('uses the SDK stop method for a service with a published address', () => {
    const stopWebService = vi.fn();

    expect(stopNativeWebService({
      manager: { urls: ['http://127.0.0.1:1234'], stopWebService },
      startAttempted: true,
    })).toBe(true);
    expect(stopWebService).toHaveBeenCalledOnce();
  });

  it('uses core stop_service when startup did not publish an address', () => {
    const executeCommand = vi.fn();

    stopNativeWebService({
      manager: {
        urls: [],
        coreInterop: { executeCommand },
      },
      startAttempted: true,
    });

    expect(executeCommand).toHaveBeenCalledWith('stop_service');
  });

  it('fails explicitly when an unpublished native listener has no teardown path', () => {
    expect(() => stopNativeWebService({
      manager: { urls: [] },
      startAttempted: true,
    })).toThrow('did not publish an address');
  });
});

describe('waitForHttpReady', () => {
  it('bounds a stalled readiness attempt by the overall deadline', async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    }));

    const started = Date.now();
    await expect(waitForHttpReady({
      fetchImpl,
      url: 'http://127.0.0.1:1234/status',
      deadlineMs: 20,
      pollIntervalMs: 0,
    })).resolves.toMatchObject({ ready: false });
    expect(Date.now() - started).toBeLessThan(500);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries non-ready responses and cancels their unused bodies', async () => {
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        body: { cancel: firstCancel },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { cancel: secondCancel },
      });

    await expect(waitForHttpReady({
      fetchImpl,
      url: 'http://127.0.0.1:1234/status',
      deadlineMs: 100,
      pollIntervalMs: 0,
    })).resolves.toEqual({ ready: true, lastError: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).toHaveBeenCalledOnce();
  });

  it('does not start an attempt when the deadline is zero', async () => {
    const fetchImpl = vi.fn();

    await expect(waitForHttpReady({
      fetchImpl,
      url: 'http://127.0.0.1:1234/status',
      deadlineMs: 0,
    })).resolves.toEqual({ ready: false, lastError: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
