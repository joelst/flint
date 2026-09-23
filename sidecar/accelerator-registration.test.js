import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    expect(result.retry).toBe(true);
    expect(result.status).toContain('runtime did not confirm registration');
  });

  it('registers providers that become visible after the one-provider fallback', async () => {
    let discovered = [];
    const manager = {
      discoverEps: () => discovered,
      downloadAndRegisterEps: vi.fn(async (names) => {
        if (!Array.isArray(names)) {
          discovered = [
            { name: 'CPUExecutionProvider', isRegistered: true },
            { name: 'CUDAExecutionProvider', isRegistered: false },
          ];
          return { success: true, status: 'All providers registered', registeredEps: [], failedEps: [] };
        }
        const name = names[0];
        discovered = discovered.map((provider) =>
          provider.name === name ? { ...provider, isRegistered: true } : provider,
        );
        return { success: true, registeredEps: [name], failedEps: [] };
      }),
    };

    const result = await registerDiscoveredExecutionProviders(manager, undefined, {
      allowLegacyFallback: true,
    });
    expect(manager.downloadAndRegisterEps.mock.calls.map(([names]) => names)).toEqual([
      undefined,
      ['CUDAExecutionProvider'],
    ]);
    expect(result).toMatchObject({
      success: true,
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      failedEps: [],
    });
    expect(result.retry).toBeUndefined();
  });

  it('does not take the one-provider fallback while discovery can be tried again', async () => {
    const manager = {
      discoverEps: () => [],
      downloadAndRegisterEps: vi.fn(),
    };
    const result = await registerDiscoveredExecutionProviders(manager, undefined, {
      allowLegacyFallback: false,
    });
    expect(manager.downloadAndRegisterEps).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      retry: true,
      registeredEps: [],
      failedEps: [],
    });
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

describe('native service startup', () => {
  it('registers providers before startWebService can answer /v1/models', () => {
    const source = readFileSync(join(process.cwd(), 'sidecar', 'foundry-sidecar-main.js'), 'utf8');
    const gateStart = source.indexOf('catalogRegistrationGate = createCatalogRegistrationGate(');
    const forcedRead = source.indexOf('return catalog.getModels();', gateStart);
    const start = source.indexOf("} else if (cmd === 'startService') {");
    const deferredRead = source.indexOf('payload.deferCatalogRead', start);
    const sealed = source.indexOf('seal: true', deferredRead);
    const gate = source.indexOf('commit: true', start);
    const web = source.indexOf('manager.startWebService()', start);
    const setup = source.indexOf("} else if (cmd === 'ensureAccelerators') {");
    const rerun = source.indexOf('rerunAcceleratorRegistration(', setup);
    const poolStatus = source.indexOf("} else if (cmd === 'poolStatus') {");
    const poolRead = source.indexOf('catalogReadConfirmed()', poolStatus);
    const loadedModels = source.indexOf('manager.catalog.getLoadedModels()', poolStatus);
    const listModels = source.indexOf("} else if (cmd === 'listModels') {");
    const listProgress = source.indexOf('beforeCatalogRead(reportCatalogProgress', listModels);
    const listRead = source.indexOf('manager.catalog.getModels()', listModels);
    expect(gateStart).toBeGreaterThan(-1);
    expect(forcedRead).toBeGreaterThan(gateStart);
    expect(start).toBeGreaterThan(-1);
    expect(deferredRead).toBeGreaterThan(start);
    expect(sealed).toBeGreaterThan(deferredRead);
    expect(gate).toBeGreaterThan(start);
    expect(gate).toBeGreaterThan(sealed);
    expect(web).toBeGreaterThan(gate);
    expect(setup).toBeGreaterThan(-1);
    expect(rerun).toBeGreaterThan(setup);
    expect(poolStatus).toBeGreaterThan(-1);
    expect(poolRead).toBeGreaterThan(poolStatus);
    expect(poolRead).toBeLessThan(loadedModels);
    expect(listModels).toBeGreaterThan(-1);
    expect(listProgress).toBeGreaterThan(listModels);
    expect(listProgress).toBeLessThan(listRead);
    for (const cmd of ['getSTTModels', 'getVisionModels', 'download']) {
      const at = source.indexOf(`} else if (cmd === '${cmd}') {`);
      const progress = source.indexOf('beforeCatalogRead(reportCatalogProgress', at);
      expect(progress, cmd).toBeGreaterThan(at);
    }
    const load = source.indexOf("} else if (cmd === 'load') {");
    expect(source.indexOf('ensureModel(payload.alias, payload.variantId, reportCatalogProgress)', load))
      .toBeGreaterThan(load);
    for (const cmd of ['importModelFolder', 'linkModelFolder', 'setModelTemplate']) {
      const at = source.indexOf(`} else if (cmd === '${cmd}') {`);
      const atomicMutation = source.indexOf('runCatalogMutation(', at);
      const call = source.indexOf(`${cmd}(`, atomicMutation);
      expect(at, cmd).toBeGreaterThan(-1);
      expect(atomicMutation, cmd).toBeGreaterThan(-1);
      expect(atomicMutation, cmd).toBeGreaterThan(at);
      expect(call, cmd).toBeGreaterThan(atomicMutation);
    }
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
    await Promise.resolve();
    expect(register).toHaveBeenCalledTimes(1);
    release({ registeredEps: ['CUDAExecutionProvider'] });
    await expect(first).resolves.toEqual({ registeredEps: ['CUDAExecutionProvider'] });
    await expect(second).resolves.toEqual({ registeredEps: ['CUDAExecutionProvider'] });
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('does not commit the catalog during registration-only ensure calls', async () => {
    const readCatalog = vi.fn();
    const gate = createCatalogRegistrationGate(
      vi.fn().mockResolvedValue({ registeredEps: ['CUDAExecutionProvider'] }),
      readCatalog,
    );

    await gate.ensure();
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('defers later provider updates after listener exposure until a catalog read is confirmed', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockResolvedValueOnce({ success: true, registeredEps: ['CUDAExecutionProvider'] });
    const readCatalog = vi.fn();
    const gate = createCatalogRegistrationGate(register, readCatalog);

    await gate.seal();
    expect(readCatalog).not.toHaveBeenCalled();
    await expect(gate.rerun()).resolves.toMatchObject({
      catalogRefreshRequiresRestart: true,
      registrationDeferredUntilRestart: true,
    });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('serializes the first confirmed catalog read after a listener-only seal', async () => {
    let releaseCatalog = () => {};
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockResolvedValueOnce({ success: true, registeredEps: ['CUDAExecutionProvider'] });
    const readCatalog = vi.fn(() => new Promise((resolve) => {
      releaseCatalog = () => resolve(['cpu-model']);
    }));
    const gate = createCatalogRegistrationGate(register, readCatalog);

    await gate.seal();
    const commit = gate.commit();
    await vi.waitFor(() => expect(readCatalog).toHaveBeenCalledTimes(1));
    const rerun = gate.rerun();
    await Promise.resolve();
    expect(register).toHaveBeenCalledTimes(1);

    releaseCatalog();
    await commit;
    await expect(rerun).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      catalogRefreshRequiresRestart: true,
    });
  });

  it('exposes confirmed catalog state without queueing telemetry or preventing retries', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockResolvedValueOnce({ success: true, registeredEps: ['CUDAExecutionProvider'] })
      .mockResolvedValueOnce({ success: true, registeredEps: ['CUDAExecutionProvider'] });
    const readCatalog = vi.fn().mockResolvedValue(['cpu-model']);
    const telemetry = vi.fn().mockResolvedValue(['loaded-model']);
    const gate = createCatalogRegistrationGate(register, readCatalog);

    await gate.ensure();
    expect(gate.isCommitConfirmed()).toBe(false);
    expect(telemetry).not.toHaveBeenCalled();
    await expect(gate.rerun()).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
    });
    await gate.commit();
    expect(readCatalog).toHaveBeenCalledTimes(1);
    expect(gate.isCommitConfirmed()).toBe(true);
    await expect(telemetry()).resolves.toEqual(['loaded-model']);
    await expect(gate.rerun()).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      catalogRefreshRequiresRestart: true,
    });
  });

  it('keeps a local mutation and the first catalog read atomic against other readers', async () => {
    let releaseMutation = () => {};
    const order = [];
    const readCatalog = vi.fn(async () => {
      order.push('read');
      return [];
    });
    const gate = createCatalogRegistrationGate(
      vi.fn().mockResolvedValue({ success: true, registeredEps: ['CPUExecutionProvider'] }),
      readCatalog,
    );

    const mutation = gate.mutateAndCommit(
      () => new Promise((resolve) => {
        order.push('mutate');
        releaseMutation = () => resolve('imported');
      }),
      vi.fn(),
    );
    await vi.waitFor(() => expect(order).toEqual(['mutate']));
    const reader = gate.commit();
    await Promise.resolve();
    expect(readCatalog).not.toHaveBeenCalled();

    releaseMutation();
    await expect(mutation).resolves.toEqual({ result: 'imported' });
    await reader;
    expect(order).toEqual(['mutate', 'read']);
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });

  it('reports a failed post-mutation catalog read without hiding the mutation result', async () => {
    const catalogError = new Error('catalog unavailable');
    const onCommitError = vi.fn();
    const gate = createCatalogRegistrationGate(
      vi.fn().mockResolvedValue({ success: true, registeredEps: ['CPUExecutionProvider'] }),
      vi.fn().mockRejectedValue(catalogError),
    );

    await expect(gate.mutateAndCommit(() => 'imported', onCommitError)).resolves.toEqual({
      result: 'imported',
      catalogRefreshRequiresRestart: true,
    });
    expect(onCommitError).toHaveBeenCalledWith(catalogError);

    const mutation = vi.fn(() => 'linked');
    await expect(gate.mutateAndCommit(mutation)).rejects.toThrow(
      'mutateAndCommit requires an onCommitError handler',
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it('restart-bounds a local mutation after the catalog was already committed', async () => {
    const gate = createCatalogRegistrationGate(
      vi.fn().mockResolvedValue({ success: true, registeredEps: ['CPUExecutionProvider'] }),
      vi.fn().mockResolvedValue(['cpu-model']),
    );

    await gate.commit();
    await expect(gate.mutateAndCommit(async () => 'imported', vi.fn())).resolves.toEqual({
      result: 'imported',
      catalogRefreshRequiresRestart: true,
    });
  });

  it('does not read or commit the catalog when the local mutation fails', async () => {
    const readCatalog = vi.fn();
    const gate = createCatalogRegistrationGate(
      vi.fn().mockResolvedValue({ success: true, registeredEps: ['CPUExecutionProvider'] }),
      readCatalog,
    );
    await expect(gate.mutateAndCommit(async () => {
      throw new Error('copy failed');
    }, vi.fn())).rejects.toThrow('copy failed');
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('retries a thrown registration and a partial failure before the catalog is read', async () => {
    const seen = [];
    const throwing = vi.fn((onProgress) => {
      if (throwing.mock.calls.length === 1) return Promise.reject(new Error('package unavailable'));
      onProgress('CUDAExecutionProvider', 40);
      return Promise.resolve('ok');
    });
    const throwingGate = createCatalogRegistrationGate(throwing);
    await expect(throwingGate.ensure((name) => seen.push(name))).resolves.toBe('ok');
    expect(seen).toEqual(['CUDAExecutionProvider']);
    expect(throwing).toHaveBeenCalledTimes(2);
    await throwingGate.ensure();
    expect(throwing).toHaveBeenCalledTimes(2);

    const partial = vi.fn(async () => {
      if (partial.mock.calls.length === 1) {
        return { success: false, failedEps: ['CUDAExecutionProvider'], retry: true };
      }
      return { success: true, registeredEps: ['CUDAExecutionProvider'] };
    });
    const partialGate = createCatalogRegistrationGate(partial);
    await expect(partialGate.ensure()).resolves.toEqual({
      success: true,
      registeredEps: ['CUDAExecutionProvider'],
    });
    expect(partial).toHaveBeenCalledTimes(2);
    await partialGate.ensure();
    expect(partial).toHaveBeenCalledTimes(2);
  });

  it('uses the one-provider fallback only on the last attempt, then keeps that result', async () => {
    const register = vi.fn(async (_onProgress, options) => {
      if (!options.allowLegacyFallback) return { success: false, retry: true, registeredEps: [], failedEps: [] };
      return { success: true, registeredEps: ['CPUExecutionProvider'] };
    });
    const gate = createCatalogRegistrationGate(register);
    await expect(gate.ensure()).resolves.toEqual({
      success: true,
      registeredEps: ['CPUExecutionProvider'],
    });
    expect(register.mock.calls.map(([, options]) => options.allowLegacyFallback)).toEqual([
      false,
      false,
      true,
    ]);
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(3);
  });

  it('keeps a terminal failure when the last attempt throws, including providers from an earlier attempt', async () => {
    const register = vi.fn(async () => {
      if (register.mock.calls.length === 1) {
        return {
          success: false,
          retry: true,
          registeredEps: ['CUDAExecutionProvider'],
          failedEps: ['WebGpuExecutionProvider'],
        };
      }
      throw new Error('offline');
    });
    const gate = createCatalogRegistrationGate(register);
    await expect(gate.ensure()).resolves.toEqual({
      success: false,
      status: 'Registered 1; last attempt failed: offline',
      registeredEps: ['CUDAExecutionProvider'],
      failedEps: ['WebGpuExecutionProvider'],
    });
    expect(register).toHaveBeenCalledTimes(3);
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(3);
  });

  it('does not make later catalog readers repeat a registration that only throws', async () => {
    const register = vi.fn(async () => {
      throw new Error('offline');
    });
    const gate = createCatalogRegistrationGate(register);
    await expect(gate.ensure()).resolves.toEqual({
      success: false,
      status: 'offline',
      registeredEps: [],
      failedEps: [],
    });
    expect(register).toHaveBeenCalledTimes(3);
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(3);
  });

  it('reports progress to the attempt that is running, not to a caller still waiting', async () => {
    let emit = () => {};
    let release = () => {};
    const register = vi.fn((onProgress) => {
      if (register.mock.calls.length === 1) {
        emit = onProgress;
        return new Promise((resolve) => {
          release = () => resolve({ success: true, registeredEps: ['CUDAExecutionProvider'] });
        });
      }
      onProgress('WebGpuExecutionProvider', 5);
      return Promise.resolve({ success: true, registeredEps: ['WebGpuExecutionProvider'] });
    });
    const seen = [];
    const gate = createCatalogRegistrationGate(register);
    const first = gate.rerun((name) => seen.push(`first:${name}`));
    await Promise.resolve();
    const second = gate.rerun((name) => seen.push(`second:${name}`));
    emit('CUDAExecutionProvider', 40);
    release();
    await first;
    await second;
    expect(seen).toEqual(['first:CUDAExecutionProvider', 'second:WebGpuExecutionProvider']);
  });

  it('runs an explicit accelerator update after the catalog is committed', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockResolvedValueOnce({ success: true, registeredEps: ['CUDAExecutionProvider'] });
    const gate = createCatalogRegistrationGate(register, vi.fn());

    await gate.commit();
    await expect(gate.rerun()).resolves.toEqual({
      success: true,
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      failedEps: [],
      catalogRefreshRequiresRestart: true,
    });
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('detects catalog commitment inside the queue before an explicit update runs', async () => {
    let release = () => {};
    const register = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        release = () => resolve({ success: true, registeredEps: ['CPUExecutionProvider'] });
      }))
      .mockResolvedValueOnce({ success: true, registeredEps: ['CUDAExecutionProvider'] });
    const gate = createCatalogRegistrationGate(register, vi.fn());

    const commit = gate.commit();
    await Promise.resolve();
    const rerun = gate.rerun();
    release();
    await commit;
    await expect(rerun).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      catalogRefreshRequiresRestart: true,
    });
  });

  it('keeps a queued update behind the actual first catalog read', async () => {
    let releaseCatalog = () => {};
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockResolvedValueOnce({ success: true, registeredEps: ['CUDAExecutionProvider'] });
    const readCatalog = vi.fn(() => new Promise((resolve) => {
      releaseCatalog = () => resolve(['cpu-model']);
    }));
    const gate = createCatalogRegistrationGate(register, readCatalog);

    const commit = gate.commit();
    await vi.waitFor(() => expect(readCatalog).toHaveBeenCalledTimes(1));
    const rerun = gate.rerun();
    await Promise.resolve();
    expect(register).toHaveBeenCalledTimes(1);

    releaseCatalog();
    await commit;
    await expect(rerun).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      catalogRefreshRequiresRestart: true,
    });
    expect(register).toHaveBeenCalledTimes(2);
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });

  it('defers updates after a rejected catalog read until a later read confirms the snapshot', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockResolvedValueOnce({ success: true, registeredEps: ['CUDAExecutionProvider'] });
    const readCatalog = vi.fn()
      .mockRejectedValueOnce(new Error('catalog failed'))
      .mockResolvedValueOnce(['cpu-model', 'cuda-model']);
    const gate = createCatalogRegistrationGate(
      register,
      readCatalog,
    );

    await expect(gate.commit()).rejects.toThrow('catalog failed');
    await expect(gate.rerun()).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider'],
      catalogRefreshRequiresRestart: true,
      registrationDeferredUntilRestart: true,
    });
    await expect(gate.commit()).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider'],
    });
    await expect(gate.rerun()).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      catalogRefreshRequiresRestart: true,
    });
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });

  it('preserves confirmed providers when a post-commit update fails', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
        failedEps: [],
      })
      .mockRejectedValue(new Error('offline'));
    const gate = createCatalogRegistrationGate(register, vi.fn());

    await gate.commit();
    await expect(gate.rerun()).resolves.toMatchObject({
      success: false,
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      catalogRefreshRequiresRestart: true,
    });
  });

  it('lets explicit setup retry before and after the catalog is read', async () => {
    let calls = 0;
    const register = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { success: false, retry: true, registeredEps: [], failedEps: ['CUDAExecutionProvider'] }
        : { success: true, registeredEps: ['CUDAExecutionProvider'], failedEps: [] };
    });
    const gate = createCatalogRegistrationGate(register, vi.fn());
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(2);
    await expect(gate.rerun()).resolves.toMatchObject({
      success: true,
      registeredEps: ['CUDAExecutionProvider'],
    });
    expect(register).toHaveBeenCalledTimes(3);
    await gate.commit();
    await gate.rerun();
    expect(register).toHaveBeenCalledTimes(4);
  });

  it('stops retrying a provider that keeps failing so the catalog read is not blocked', async () => {
    const register = vi.fn(async () => ({
      success: false,
      retry: true,
      failedEps: ['CUDAExecutionProvider'],
    }));
    const gate = createCatalogRegistrationGate(register);
    await expect(gate.ensure()).resolves.toMatchObject({
      success: false,
      retry: true,
      failedEps: ['CUDAExecutionProvider'],
    });
    expect(register).toHaveBeenCalledTimes(3);
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(3);
  });
});
