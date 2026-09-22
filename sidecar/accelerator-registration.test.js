import { describe, expect, it, vi } from 'vitest';
import { registerDiscoveredExecutionProviders } from './accelerator-registration.js';

describe('registerDiscoveredExecutionProviders', () => {
  it('registers every discovered provider explicitly', async () => {
    const providers = [
      { name: 'CUDAExecutionProvider', isRegistered: false },
      { name: 'WebGpuExecutionProvider', isRegistered: false },
    ];
    const manager = {
      discoverEps: vi.fn(() => providers),
      downloadAndRegisterEps: vi.fn(async ([name]) => {
        providers.find((provider) => provider.name === name).isRegistered = true;
        return {
          success: true,
          status: 'registered',
          registeredEps: [name],
          failedEps: [],
        };
      }),
    };

    await expect(registerDiscoveredExecutionProviders(manager)).resolves.toEqual({
      success: true,
      status: 'Registered 2 execution providers',
      registeredEps: ['CUDAExecutionProvider', 'WebGpuExecutionProvider'],
      failedEps: [],
    });
    expect(manager.downloadAndRegisterEps.mock.calls.map(([names]) => names)).toEqual([
      ['CUDAExecutionProvider'],
      ['WebGpuExecutionProvider'],
    ]);
  });

  it('preserves successes when another provider fails', async () => {
    const providers = [
      { name: 'CUDAExecutionProvider', isRegistered: false },
      { name: 'WebGpuExecutionProvider', isRegistered: false },
    ];
    const manager = {
      discoverEps: vi.fn(() => providers),
      downloadAndRegisterEps: vi.fn(async ([name]) => {
        if (name === 'CUDAExecutionProvider') {
          providers[0].isRegistered = true;
          return {
            success: true,
            status: 'registered',
            registeredEps: [name],
            failedEps: [],
          };
        }
        throw new Error('package unavailable');
      }),
    };

    const result = await registerDiscoveredExecutionProviders(manager);
    expect(result).toMatchObject({
      success: false,
      registeredEps: ['CUDAExecutionProvider'],
      failedEps: ['WebGpuExecutionProvider'],
    });
    expect(result.status).toContain('WebGpuExecutionProvider (package unavailable)');
  });

  it('keeps the legacy no-discovery fallback', async () => {
    const fallback = {
      success: true,
      status: 'registered automatically',
      registeredEps: ['QNNExecutionProvider'],
      failedEps: [],
    };
    const manager = {
      downloadAndRegisterEps: vi.fn().mockResolvedValue(fallback),
    };
    const onProgress = vi.fn();

    await expect(
      registerDiscoveredExecutionProviders(manager, onProgress),
    ).resolves.toBe(fallback);
    expect(manager.downloadAndRegisterEps).toHaveBeenCalledWith(onProgress);
  });
});
