import { describe, expect, it, vi } from 'vitest';
import { stopNativeWebService } from './native-service.js';

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
    const stopWebService = vi.fn();

    stopNativeWebService({
      manager: {
        urls: [],
        stopWebService,
        coreInterop: { executeCommand },
      },
      startAttempted: true,
    });

    expect(executeCommand).toHaveBeenCalledWith('stop_service');
    expect(stopWebService).not.toHaveBeenCalled();
  });

  it('fails explicitly when an unpublished native listener has no teardown path', () => {
    expect(() => stopNativeWebService({
      manager: { urls: [] },
      startAttempted: true,
    })).toThrow('did not publish an address');
  });
});
