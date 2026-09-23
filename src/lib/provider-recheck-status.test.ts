import { describe, expect, it } from 'vitest';
import { providerRecheckStatus } from './provider-recheck-status';

const webgpu = { name: 'WebGpuExecutionProvider', isRegistered: true };

describe('providerRecheckStatus', () => {
  it('names a provider the refreshed list still does not show as registered', () => {
    const status = providerRecheckStatus(
      {
        success: false,
        failedEps: ['CUDAExecutionProvider'],
        removedProviderCaches: ['CUDAExecutionProvider', 'CUDAExecutionProvider'],
        attemptedProviderRebuilds: ['CUDAExecutionProvider'],
      },
      [webgpu, { name: 'CUDAExecutionProvider', isRegistered: false }],
    );
    expect(status.failed).toBe(true);
    expect(status.message).toBe('Provider rebuild failed for CUDAExecutionProvider.');
  });

  it('treats a refreshed registration as success even when the envelope said failed', () => {
    const status = providerRecheckStatus(
      {
        success: false,
        status: 'Native failure registering CUDAExecutionProvider',
        failedEps: ['CUDAExecutionProvider'],
        removedProviderCaches: ['CUDAExecutionProvider'],
      },
      [webgpu, { name: 'CUDAExecutionProvider', isRegistered: true }],
    );
    expect(status.failed).toBe(false);
    expect(status.message).toBe('Rebuilt CUDAExecutionProvider.');
  });

  it('keeps a locked provider in the message without listing it twice', () => {
    const status = providerRecheckStatus(
      {
        success: false,
        failedEps: ['CUDAExecutionProvider'],
        busyProviderCaches: ['CUDAExecutionProvider', 'CUDAExecutionProvider'],
      },
      [webgpu],
    );
    expect(status.message).toBe(
      'Provider rebuild failed for CUDAExecutionProvider. Left in place because a file is in use: CUDAExecutionProvider.',
    );
  });

  it('counts only providers the refresh shows as registered', () => {
    const status = providerRecheckStatus(
      { success: true, status: 'No broken providers', failedEps: [] },
      [
        webgpu,
        { name: 'CPUExecutionProvider', isRegistered: true },
        { name: 'FutureExecutionProvider', isRegistered: false },
      ],
    );
    expect(status).toEqual({
      failed: false,
      message: '2 execution providers ready.',
    });
  });
});
