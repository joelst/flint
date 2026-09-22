import { describe, expect, it, vi } from 'vitest';
import { createCatalogRegistrationGate, registerDiscoveredExecutionProviders } from './accelerator-registration.js';

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

  it('registers a provider that shows up only after another registration', async () => {
    let discovered = [{ name: 'CUDAExecutionProvider', isRegistered: false }];
    const manager = {
      discoverEps: () => discovered,
      downloadAndRegisterEps: vi.fn(async ([name]) => {
        discovered = discovered.map((provider) =>
          provider.name === name ? { ...provider, isRegistered: true } : provider,
        );
        if (name === 'CUDAExecutionProvider') {
          discovered = [...discovered, { name: 'NvTensorRTRTXExecutionProvider', isRegistered: false }];
        }
        return { success: true, registeredEps: [name], failedEps: [] };
      }),
    };

    const result = await registerDiscoveredExecutionProviders(manager);
    expect(manager.downloadAndRegisterEps.mock.calls.map(([names]) => names)).toEqual([
      ['CUDAExecutionProvider'],
      ['NvTensorRTRTXExecutionProvider'],
    ]);
    expect(result.registeredEps).toEqual([
      'CUDAExecutionProvider',
      'NvTensorRTRTXExecutionProvider',
    ]);
    expect(result.failedEps).toEqual([]);
  });

  it('does not report a provider as registered when discovery still says it is not', async () => {
    const providers = [{ name: 'CUDAExecutionProvider', isRegistered: false }];
    const manager = {
      discoverEps: () => providers,
      downloadAndRegisterEps: async () => ({
        success: true,
        status: 'Requested EPs registered',
        registeredEps: ['CUDAExecutionProvider'],
        failedEps: [],
      }),
    };

    const result = await registerDiscoveredExecutionProviders(manager);
    expect(result.registeredEps).toEqual([]);
    expect(result.failedEps).toEqual(['CUDAExecutionProvider']);
    expect(result.success).toBe(false);
    expect(result.status).toContain('runtime did not confirm registration');
  });

  it('does not download a provider discovery already marks registered', async () => {
    const providers = [
      { name: 'CPUExecutionProvider', isRegistered: true },
      { name: 'CUDAExecutionProvider', isRegistered: false },
    ];
    const manager = {
      discoverEps: () => providers,
      downloadAndRegisterEps: vi.fn(async ([name]) => {
        providers.find((provider) => provider.name === name).isRegistered = true;
        return { success: true, registeredEps: [name], failedEps: [] };
      }),
    };

    const result = await registerDiscoveredExecutionProviders(manager);
    expect(manager.downloadAndRegisterEps.mock.calls.map(([names]) => names)).toEqual([
      ['CUDAExecutionProvider'],
    ]);
    expect(result.registeredEps).toEqual(['CPUExecutionProvider', 'CUDAExecutionProvider']);
  });
});

describe('createCatalogRegistrationGate', () => {
  it('runs one registration for concurrent readers and keeps the result', async () => {
    let release;
    const register = vi.fn(() => new Promise((resolve) => {
      release = resolve;
    }));
    const gate = createCatalogRegistrationGate(register);
    const first = gate.ensure();
    const second = gate.ensure();
    expect(register).toHaveBeenCalledTimes(1);
    release({ registeredEps: ['CUDAExecutionProvider'] });
    await expect(first).resolves.toEqual({ registeredEps: ['CUDAExecutionProvider'] });
    await expect(second).resolves.toEqual({ registeredEps: ['CUDAExecutionProvider'] });
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('lets a later caller hear progress and retries after a throw', async () => {
    const seen = [];
    let emit;
    const register = vi.fn((onProgress) => new Promise((resolve, reject) => {
      emit = onProgress;
      if (register.mock.calls.length === 1) {
        queueMicrotask(() => reject(new Error('package unavailable')));
        return;
      }
      queueMicrotask(() => {
        emit('CUDAExecutionProvider', 40);
        resolve('ok');
      });
    }));
    const gate = createCatalogRegistrationGate(register);
    await expect(gate.ensure(() => seen.push('first'))).rejects.toThrow('package unavailable');
    await expect(gate.ensure((name) => seen.push(name))).resolves.toBe('ok');
    expect(seen).toEqual(['CUDAExecutionProvider']);
    expect(register).toHaveBeenCalledTimes(2);
  });
});
