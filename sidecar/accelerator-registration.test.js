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

  it('marks a failed legacy fallback for one bounded retry', async () => {
    const fallback = {
      success: false,
      status: 'provider package unavailable',
      registeredEps: [],
      failedEps: ['CUDAExecutionProvider'],
    };
    const manager = {
      downloadAndRegisterEps: vi.fn().mockResolvedValue(fallback),
    };

    await expect(registerDiscoveredExecutionProviders(manager)).resolves.toEqual({
      ...fallback,
      retry: true,
    });
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
    const trackedPoolRead = source.indexOf(
      'readCatalogTelemetry(() => manager.catalog.getLoadedModels())',
      poolRead,
    );
    const loadedModels = source.indexOf('manager.catalog.getLoadedModels()', poolStatus);
    const listModels = source.indexOf("} else if (cmd === 'listModels') {");
    const listGate = source.indexOf('readCatalog(', listModels);
    const listProgress = source.indexOf('reportCatalogProgress', listGate);
    const listRead = source.indexOf('manager.catalog.getModels()', listModels);
    const gatewayFallback = source.indexOf('Gateway could not read the catalog');
    const gatewayFallbackEnd = source.indexOf('} catch (lookupError)', gatewayFallback);
    const gatewayFallbackFlow = source.slice(gatewayFallback, gatewayFallbackEnd);
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
    expect(trackedPoolRead).toBeGreaterThan(poolRead);
    expect(poolRead).toBeLessThan(loadedModels);
    expect(listModels).toBeGreaterThan(-1);
    expect(listGate).toBeGreaterThan(listModels);
    expect(listRead).toBeGreaterThan(listGate);
    expect(listProgress).toBeGreaterThan(listRead);
    expect(gatewayFallback).toBeGreaterThan(-1);
    expect(gatewayFallbackEnd).toBeGreaterThan(gatewayFallback);
    expect(gatewayFallbackFlow).not.toContain('await beforeCatalogRead();');
    expect(gatewayFallbackFlow).toContain('readUnconfirmedCatalog(');
    expect(gatewayFallbackFlow).not.toContain('readCatalog(');
    expect(gatewayFallbackFlow).toContain('manager.catalog.getCachedModels()');
    for (const cmd of ['getSTTModels', 'getVisionModels']) {
      const at = source.indexOf(`} else if (cmd === '${cmd}') {`);
      const trackedRead = source.indexOf('readCatalog(', at);
      const nativeRead = source.indexOf('manager.catalog.getModels()', at);
      const progress = source.indexOf('reportCatalogProgress', trackedRead);
      expect(trackedRead, cmd).toBeGreaterThan(at);
      expect(nativeRead, cmd).toBeGreaterThan(trackedRead);
      expect(progress, cmd).toBeGreaterThan(nativeRead);
    }
    const download = source.indexOf("} else if (cmd === 'download') {");
    const downloadRead = source.indexOf('readUnconfirmedCatalog(', download);
    const downloadVariant = source.indexOf('manager.catalog.getModelVariant(payload.variantId)', download);
    const downloadAlias = source.indexOf('manager.catalog.getModel(payload.alias)', download);
    const downloadPreflight = source.indexOf('beforeCatalogRead(reportCatalogProgress', download);
    expect(downloadPreflight).toBeGreaterThan(download);
    expect(downloadPreflight).toBeLessThan(downloadRead);
    expect(downloadRead).toBeGreaterThan(download);
    expect(downloadRead).toBeLessThan(downloadVariant);
    expect(downloadRead).toBeLessThan(downloadAlias);
    const deleteModel = source.indexOf("} else if (cmd === 'deleteModel') {");
    const deleteMutation = source.indexOf('runCatalogMutation(', deleteModel);
    const deleteVariant = source.indexOf('manager.catalog.getModelVariant(variantId)', deleteModel);
    const deleteAlias = source.indexOf('manager.catalog.getModel(payload.alias)', deleteModel);
    const deleteEnd = source.indexOf("} else if (cmd === 'inspectModelFolder')", deleteModel);
    const deleteFlow = source.slice(deleteModel, deleteEnd);
    expect(deleteMutation).toBeGreaterThan(deleteModel);
    expect(deleteMutation).toBeLessThan(deleteVariant);
    expect(deleteMutation).toBeLessThan(deleteAlias);
    expect(deleteEnd).toBeGreaterThan(deleteModel);
    expect(deleteFlow).toContain('catalogEntryRemoved:');
    expect(deleteFlow).toContain('isLocalCatalogEntry(');
    expect(deleteFlow).toContain('catalogEntryRemoved && catalogRefreshRequiresRestart');
    expect(deleteFlow).toContain('catalogReadBeforeMutation: true');
    const load = source.indexOf("} else if (cmd === 'load') {");
    const ensureModel = source.indexOf('async function ensureModelLocked(');
    const ensureModelEnd = source.indexOf(
      'async function applyPreferredExecutionProvider',
      ensureModel,
    );
    const ensureModelFlow = source.slice(ensureModel, ensureModelEnd);
    expect(ensureModel).toBeGreaterThan(-1);
    expect(ensureModelEnd).toBeGreaterThan(ensureModel);
    expect(ensureModelFlow).toContain('readUnconfirmedCatalog(');
    expect(ensureModelFlow).not.toContain('readCatalog(');
    expect(ensureModelFlow).toContain('manager.catalog.getModel(alias)');
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
  it('keeps the post-commit writer lane behind a mutation crossing confirmation', () => {
    const source = readFileSync(
      join(process.cwd(), 'sidecar', 'accelerator-registration.js'),
      'utf8',
    );
    const start = source.indexOf('function enqueuePostCommitWrite(task)');
    const end = source.indexOf('function publishPostCommitWrite(run)', start);
    const flow = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(flow).toContain('const priorMutations = mutationBarrier');
    expect(flow).toContain('const priorWrites = postCommitWriteBarrier');
    expect(flow).toContain('Promise.all([');
    expect(flow).toContain('priorMutations');
    expect(flow).toContain('priorWrites');
  });

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

  it('does not block confirmed telemetry behind post-commit registration', async () => {
    let releaseRegistration = () => {};
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseRegistration = () => resolve({
          success: true,
          registeredEps: ['CUDAExecutionProvider'],
        });
      }));
    const readCatalog = vi.fn().mockResolvedValue(['cpu-model']);
    const telemetry = vi.fn().mockResolvedValue(['loaded-model']);
    const gate = createCatalogRegistrationGate(register, readCatalog);

    await gate.commit();
    expect(readCatalog).toHaveBeenCalledTimes(1);
    expect(gate.isCommitConfirmed()).toBe(true);

    const rerun = gate.rerun();
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    const telemetryRead = gate.read(telemetry);
    await expect(telemetryRead).resolves.toEqual(['loaded-model']);
    expect(telemetry).toHaveBeenCalledTimes(1);

    releaseRegistration();
    await expect(rerun).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      catalogRefreshRequiresRestart: true,
    });
  });

  it('keeps confirmed catalog reads ordered behind a mutation queued after registration', async () => {
    let releaseRegistration = () => {};
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseRegistration = () => resolve({
          success: true,
          registeredEps: ['CUDAExecutionProvider'],
        });
      }));
    const gate = createCatalogRegistrationGate(register, vi.fn(async () => []));
    await gate.commit();

    const rerun = gate.rerun();
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    const mutation = gate.mutateAndCommit(async () => 'updated', () => {});
    const telemetry = gate.read(async () => ['loaded-model']);
    let mutationSettled = false;
    void mutation.then(() => {
      mutationSettled = true;
    });
    await Promise.resolve();
    expect(mutationSettled).toBe(false);

    releaseRegistration();
    await expect(rerun).resolves.toMatchObject({
      registeredEps: ['CPUExecutionProvider', 'CUDAExecutionProvider'],
      catalogRefreshRequiresRestart: true,
    });
    await expect(mutation).resolves.toEqual({
      result: 'updated',
      catalogRefreshRequiresRestart: true,
    });
    await expect(telemetry).resolves.toEqual(['loaded-model']);
  });

  it('serializes post-commit registration and catalog mutations without blocking telemetry', async () => {
    let releaseRegistration = () => {};
    const events = [];
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockImplementationOnce(() => new Promise((resolve) => {
        events.push('registration');
        releaseRegistration = () => {
          events.push('registration done');
          resolve({
            success: true,
            registeredEps: ['CUDAExecutionProvider'],
          });
        };
      }));
    const gate = createCatalogRegistrationGate(register, vi.fn(async () => []));
    await gate.commit();

    const rerun = gate.rerun();
    await vi.waitFor(() => expect(events).toEqual(['registration']));
    const mutation = gate.mutateAndCommit(async () => {
      events.push('mutation');
      return 'updated';
    }, () => {});
    const telemetry = gate.readTelemetry(async () => {
      events.push('telemetry');
      return ['loaded-model'];
    });

    await expect(telemetry).resolves.toEqual(['loaded-model']);
    expect(events).toEqual(['registration', 'telemetry']);

    releaseRegistration();
    await rerun;
    await expect(mutation).resolves.toEqual({
      result: 'updated',
      catalogRefreshRequiresRestart: true,
    });
    expect(events).toEqual([
      'registration',
      'telemetry',
      'registration done',
      'mutation',
    ]);
  });

  it('holds telemetry only while a catalog mutation is actively running', async () => {
    let releaseMutation = () => {};
    const events = [];
    const gate = createCatalogRegistrationGate(
      vi.fn().mockResolvedValue({ success: true, registeredEps: ['CPUExecutionProvider'] }),
      vi.fn(async () => []),
    );
    await gate.commit();

    const mutation = gate.mutateAndCommit(
      () => new Promise((resolve) => {
        events.push('mutation');
        releaseMutation = () => {
          events.push('mutation done');
          resolve('updated');
        };
      }),
      () => {},
    );
    await vi.waitFor(() => expect(events).toEqual(['mutation']));
    const telemetry = gate.readTelemetry(async () => {
      events.push('telemetry');
      return ['loaded-model'];
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['mutation']);

    releaseMutation();
    await mutation;
    await expect(telemetry).resolves.toEqual(['loaded-model']);
    expect(events).toEqual(['mutation', 'mutation done', 'telemetry']);
  });

  it('keeps provider-sensitive lookups behind post-commit registration', async () => {
    let releaseRegistration = () => {};
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseRegistration = () => resolve({
          success: true,
          registeredEps: ['CUDAExecutionProvider'],
        });
      }));
    const gate = createCatalogRegistrationGate(register, vi.fn(async () => []));
    await gate.commit();

    const events = [];
    const rerun = gate.rerun();
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    const lookup = gate.readUnconfirmed(async () => {
      events.push('lookup');
      return 'model';
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([]);

    releaseRegistration();
    await rerun;
    await expect(lookup).resolves.toBe('model');
    expect(events).toEqual(['lookup']);
  });

  it('keeps lookups behind a rerun queued before commit confirmation', async () => {
    let releaseCommit = () => {};
    let releaseRegistration = () => {};
    const register = vi.fn()
      .mockResolvedValueOnce({ success: true, registeredEps: ['CPUExecutionProvider'] })
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseRegistration = () => resolve({
          success: true,
          registeredEps: ['CUDAExecutionProvider'],
        });
      }));
    const commitCatalog = vi.fn(() => new Promise((resolve) => {
      releaseCommit = () => resolve(['cpu-model']);
    }));
    const gate = createCatalogRegistrationGate(register, commitCatalog);

    const commit = gate.commit();
    await vi.waitFor(() => expect(commitCatalog).toHaveBeenCalledTimes(1));
    const rerun = gate.rerun();
    releaseCommit();
    await commit;
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2));

    const events = [];
    const lookup = gate.readUnconfirmed(async () => {
      events.push('lookup');
      return 'model';
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([]);

    releaseRegistration();
    await rerun;
    await expect(lookup).resolves.toBe('model');
    expect(events).toEqual(['lookup']);
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

  it('restart-bounds a first mutation whose callback reads the catalog before changing it', async () => {
    const gate = createCatalogRegistrationGate(
      vi.fn(async () => ({ success: true, registeredEps: [], failedEps: [] })),
      vi.fn(async () => []),
    );

    await expect(gate.mutateAndCommit(
      async () => 'deleted',
      () => {},
      undefined,
      { catalogReadBeforeMutation: true },
    )).resolves.toEqual({
      result: 'deleted',
      catalogRefreshRequiresRestart: true,
    });
    expect(gate.isCommitConfirmed()).toBe(true);
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
      failedEps: [],
    });
    expect(partial).toHaveBeenCalledTimes(2);
    await partialGate.ensure();
    expect(partial).toHaveBeenCalledTimes(2);
  });

  it('preserves providers confirmed by an earlier retry attempt', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        retry: true,
        registeredEps: ['CUDAExecutionProvider'],
        failedEps: ['WebGpuExecutionProvider'],
      })
      .mockResolvedValueOnce({
        success: true,
        registeredEps: ['WebGpuExecutionProvider'],
        failedEps: [],
      });
    const gate = createCatalogRegistrationGate(register);

    await expect(gate.ensure()).resolves.toEqual({
      success: true,
      registeredEps: ['CUDAExecutionProvider', 'WebGpuExecutionProvider'],
      failedEps: [],
    });
  });

  it('lets a later explicit failure override an earlier registration', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        retry: true,
        registeredEps: ['CUDAExecutionProvider'],
        failedEps: [],
      })
      .mockResolvedValueOnce({
        success: false,
        registeredEps: ['WebGpuExecutionProvider'],
        failedEps: ['CUDAExecutionProvider'],
      });
    const gate = createCatalogRegistrationGate(register);

    await expect(gate.ensure()).resolves.toEqual({
      success: false,
      registeredEps: ['WebGpuExecutionProvider'],
      failedEps: ['CUDAExecutionProvider'],
    });
  });

  it('keeps prior registration state across a transient null result', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        retry: true,
        registeredEps: ['CUDAExecutionProvider'],
        failedEps: [],
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        success: true,
        registeredEps: ['WebGpuExecutionProvider'],
        failedEps: [],
      });
    const gate = createCatalogRegistrationGate(register);

    await expect(gate.ensure()).resolves.toEqual({
      success: true,
      registeredEps: ['CUDAExecutionProvider', 'WebGpuExecutionProvider'],
      failedEps: [],
    });
    expect(register).toHaveBeenCalledTimes(3);
  });

  it('updates registration status after preserving an earlier provider', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        status: 'Registered 1; failed 1: WebGpuExecutionProvider (temporary failure)',
        retry: true,
        registeredEps: ['CUDAExecutionProvider'],
        failedEps: ['WebGpuExecutionProvider'],
      })
      .mockResolvedValueOnce({
        success: true,
        status: 'Registered 1 execution provider',
        registeredEps: ['WebGpuExecutionProvider'],
        failedEps: [],
      });
    const gate = createCatalogRegistrationGate(register);

    await expect(gate.ensure()).resolves.toEqual({
      success: true,
      status: 'Registered 2 execution providers',
      registeredEps: ['CUDAExecutionProvider', 'WebGpuExecutionProvider'],
      failedEps: [],
    });
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
      failedEps: [],
    });
    expect(register.mock.calls.map(([, options]) => options.allowLegacyFallback)).toEqual([
      false,
      false,
      true,
    ]);
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(3);
  });

  it('retries a failed one-provider fallback once before keeping the result', async () => {
    const manager = {
      discoverEps: vi.fn(() => []),
      downloadAndRegisterEps: vi.fn()
        .mockResolvedValueOnce({
          success: false,
          registeredEps: [],
          failedEps: ['CUDAExecutionProvider'],
        })
        .mockResolvedValueOnce({
          success: true,
          registeredEps: ['CUDAExecutionProvider'],
          failedEps: [],
        }),
    };
    const register = vi.fn((onProgress, options) => (
      registerDiscoveredExecutionProviders(manager, onProgress, options)
    ));
    const gate = createCatalogRegistrationGate(register);

    await expect(gate.ensure()).resolves.toEqual({
      success: true,
      registeredEps: ['CUDAExecutionProvider'],
      failedEps: [],
    });
    expect(register.mock.calls.map(([, options]) => options.allowLegacyFallback)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(manager.downloadAndRegisterEps).toHaveBeenCalledTimes(2);
  });

  it('retries providers whose first explicit registration follows the fallback', async () => {
    let discovered = [];
    let explicitAttempts = 0;
    const manager = {
      discoverEps: vi.fn(() => discovered),
      downloadAndRegisterEps: vi.fn(async (names) => {
        if (!Array.isArray(names)) {
          discovered = [{ name: 'CUDAExecutionProvider', isRegistered: false }];
          return { success: true, registeredEps: [], failedEps: [] };
        }
        explicitAttempts++;
        if (explicitAttempts === 2) {
          discovered = [{ name: 'CUDAExecutionProvider', isRegistered: true }];
        }
        return {
          success: explicitAttempts === 2,
          registeredEps: explicitAttempts === 2 ? ['CUDAExecutionProvider'] : [],
          failedEps: explicitAttempts === 2 ? [] : ['CUDAExecutionProvider'],
        };
      }),
    };
    const register = vi.fn((onProgress, options) => (
      registerDiscoveredExecutionProviders(manager, onProgress, options)
    ));
    const gate = createCatalogRegistrationGate(register);

    await expect(gate.ensure()).resolves.toMatchObject({
      success: true,
      registeredEps: ['CUDAExecutionProvider'],
      failedEps: [],
    });
    expect(register).toHaveBeenCalledTimes(4);
    expect(manager.downloadAndRegisterEps.mock.calls.map(([names]) => names)).toEqual([
      expect.any(Function),
      ['CUDAExecutionProvider'],
      ['CUDAExecutionProvider'],
    ]);
  });

  it('retries once when the delayed fallback throws', async () => {
    const manager = {
      discoverEps: vi.fn(() => []),
      downloadAndRegisterEps: vi.fn()
        .mockRejectedValueOnce(new Error('temporary fallback failure'))
        .mockResolvedValueOnce({
          success: true,
          registeredEps: ['CUDAExecutionProvider'],
          failedEps: [],
        }),
    };
    const register = vi.fn((onProgress, options) => (
      registerDiscoveredExecutionProviders(manager, onProgress, options)
    ));
    const gate = createCatalogRegistrationGate(register);

    await expect(gate.ensure()).resolves.toEqual({
      success: true,
      registeredEps: ['CUDAExecutionProvider'],
      failedEps: [],
    });
    expect(register).toHaveBeenCalledTimes(4);
    expect(manager.downloadAndRegisterEps).toHaveBeenCalledTimes(2);
  });

  it('keeps a second failed fallback without retrying later readers', async () => {
    const manager = {
      discoverEps: vi.fn(() => []),
      downloadAndRegisterEps: vi.fn()
        .mockResolvedValueOnce({
          success: false,
          registeredEps: ['CPUExecutionProvider'],
          failedEps: ['CUDAExecutionProvider'],
        })
        .mockResolvedValueOnce({
          success: false,
          registeredEps: [],
          failedEps: ['CUDAExecutionProvider'],
        }),
    };
    const register = vi.fn((onProgress, options) => (
      registerDiscoveredExecutionProviders(manager, onProgress, options)
    ));
    const gate = createCatalogRegistrationGate(register);

    const first = await gate.ensure();
    await expect(gate.ensure()).resolves.toBe(first);
    expect(first).toMatchObject({
      success: false,
      registeredEps: ['CPUExecutionProvider'],
      failedEps: ['CUDAExecutionProvider'],
    });
    expect(register).toHaveBeenCalledTimes(4);
    expect(manager.downloadAndRegisterEps).toHaveBeenCalledTimes(2);
  });

  it('keeps partial fallback results when the bounded retry throws', async () => {
    const manager = {
      discoverEps: vi.fn(() => []),
      downloadAndRegisterEps: vi.fn()
        .mockResolvedValueOnce({
          success: false,
          registeredEps: ['CPUExecutionProvider'],
          failedEps: ['CUDAExecutionProvider'],
        })
        .mockRejectedValueOnce(new Error('fallback retry failed')),
    };
    const register = vi.fn((onProgress, options) => (
      registerDiscoveredExecutionProviders(manager, onProgress, options)
    ));
    const gate = createCatalogRegistrationGate(register);

    await expect(gate.ensure()).resolves.toEqual({
      success: false,
      status: 'Registered 1; last attempt failed: fallback retry failed',
      registeredEps: ['CPUExecutionProvider'],
      failedEps: ['CUDAExecutionProvider'],
    });
    expect(register).toHaveBeenCalledTimes(4);
    expect(manager.downloadAndRegisterEps).toHaveBeenCalledTimes(2);
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
    expect(register).toHaveBeenCalledTimes(4);
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(4);
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
    expect(register).toHaveBeenCalledTimes(4);
    await gate.ensure();
    expect(register).toHaveBeenCalledTimes(4);
  });

  it('settles a falsy terminal registration result instead of reopening retries', async () => {
    const register = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(null);
    const gate = createCatalogRegistrationGate(register);

    await expect(gate.ensure()).resolves.toBeNull();
    await expect(gate.ensure()).resolves.toBeNull();
    expect(register).toHaveBeenCalledTimes(4);
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

  it('does not serialize catalog operations after the snapshot is confirmed', async () => {
    const gate = createCatalogRegistrationGate(
      vi.fn(async () => ({ success: true, registeredEps: [], failedEps: [] })),
      vi.fn(async () => []),
    );
    await gate.commit();

    const started = [];
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    const first = gate.read(async () => {
      started.push('first');
      await new Promise((resolve) => { releaseFirst = resolve; });
      return 'first';
    });
    const second = gate.read(async () => {
      started.push('second');
      await new Promise((resolve) => { releaseSecond = resolve; });
      return 'second';
    });

    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);
    releaseFirst();
    releaseSecond();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
  });

  it('serializes the first catalog operation behind registration and confirms it', async () => {
    const events = [];
    let releaseRegistration = () => {};
    const gate = createCatalogRegistrationGate(
      vi.fn(() => new Promise((resolve) => {
        events.push('registration');
        releaseRegistration = () => resolve({
          success: true,
          registeredEps: ['CUDAExecutionProvider'],
          failedEps: [],
        });
      })),
      vi.fn(),
    );

    const read = gate.read(async () => {
      events.push('read');
      return 'model';
    });
    await Promise.resolve();
    expect(events).toEqual(['registration']);
    releaseRegistration();
    await expect(read).resolves.toBe('model');
    expect(events).toEqual(['registration', 'read']);
    expect(gate.isCommitConfirmed()).toBe(true);
  });

  it('keeps readers queued before the first commit ordered ahead of later mutations', async () => {
    const gate = createCatalogRegistrationGate(
      vi.fn(async () => ({ success: true, registeredEps: [], failedEps: [] })),
      vi.fn(),
    );
    const events = [];
    let releaseFirst = () => {};
    let releaseSecond = () => {};

    const first = gate.read(async () => {
      events.push('first');
      await new Promise((resolve) => { releaseFirst = resolve; });
      return 'first';
    });
    const second = gate.read(async () => {
      events.push('second');
      await new Promise((resolve) => { releaseSecond = resolve; });
      return 'second';
    });
    const mutation = gate.mutateAndCommit(
      async () => {
        events.push('mutation');
        return 'updated';
      },
      () => {},
    );

    await vi.waitFor(() => expect(events).toEqual(['first']));
    releaseFirst();
    await vi.waitFor(() => expect(events).toEqual(['first', 'second']));
    await Promise.resolve();
    expect(events).toEqual(['first', 'second']);

    releaseSecond();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    await expect(mutation).resolves.toEqual({
      result: 'updated',
      catalogRefreshRequiresRestart: true,
    });
    expect(events).toEqual(['first', 'second', 'mutation']);
  });

  it('does not confirm the catalog from an unconfirmed read after a failed snapshot read', async () => {
    const register = vi.fn(async () => ({
      success: true,
      registeredEps: ['CPUExecutionProvider'],
      failedEps: [],
    }));
    const gate = createCatalogRegistrationGate(
      register,
      vi.fn(async () => { throw new Error('catalog unavailable'); }),
    );

    await expect(gate.commit()).rejects.toThrow('catalog unavailable');
    await expect(gate.readUnconfirmed(async () => ['cached-model'])).resolves.toEqual(['cached-model']);
    expect(gate.isCommitConfirmed()).toBe(false);
    await expect(gate.rerun()).resolves.toMatchObject({
      registrationDeferredUntilRestart: true,
      catalogRefreshRequiresRestart: true,
    });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('treats a successful model lookup as uncertain and defers provider updates', async () => {
    const register = vi.fn(async () => ({
      success: true,
      registeredEps: ['CPUExecutionProvider'],
      failedEps: [],
    }));
    const gate = createCatalogRegistrationGate(register, vi.fn());

    await expect(gate.readUnconfirmed(async () => ({ alias: 'cached-model' }))).resolves.toEqual({
      alias: 'cached-model',
    });
    expect(gate.isCommitConfirmed()).toBe(false);
    await expect(gate.rerun()).resolves.toMatchObject({
      registrationDeferredUntilRestart: true,
      catalogRefreshRequiresRestart: true,
    });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('lets unconfirmed lookup operations remain concurrent after snapshot confirmation', async () => {
    const gate = createCatalogRegistrationGate(
      vi.fn(async () => ({ success: true, registeredEps: [], failedEps: [] })),
      vi.fn(async () => []),
    );
    await gate.commit();

    const events = [];
    let releaseFirst = () => {};
    const first = gate.readUnconfirmed(async () => {
      events.push('first');
      await new Promise((resolve) => { releaseFirst = resolve; });
      return 'first';
    });
    const second = gate.readUnconfirmed(async () => {
      events.push('second');
      return 'second';
    });

    await vi.waitFor(() => expect(events).toEqual(['first', 'second']));
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
  });

  it('orders confirmed reads behind an in-flight catalog mutation', async () => {
    const gate = createCatalogRegistrationGate(
      vi.fn(async () => ({ success: true, registeredEps: [], failedEps: [] })),
      vi.fn(async () => []),
    );
    await gate.commit();

    const events = [];
    let releaseMutation = () => {};
    const mutation = gate.mutateAndCommit(
      async () => {
        events.push('mutation');
        await new Promise((resolve) => { releaseMutation = resolve; });
        return 'updated';
      },
      () => {},
    );
    const read = gate.read(async () => {
      events.push('read');
      return 'model';
    });

    await vi.waitFor(() => expect(events).toEqual(['mutation']));
    releaseMutation();
    await expect(mutation).resolves.toEqual({ result: 'updated', catalogRefreshRequiresRestart: true });
    await expect(read).resolves.toBe('model');
    expect(events).toEqual(['mutation', 'read']);
  });

  it('orders a local mutation behind already-active confirmed reads', async () => {
    const gate = createCatalogRegistrationGate(
      vi.fn(async () => ({ success: true, registeredEps: [], failedEps: [] })),
      vi.fn(async () => []),
    );
    await gate.commit();

    const events = [];
    let releaseRead = () => {};
    const read = gate.read(async () => {
      events.push('read');
      await new Promise((resolve) => { releaseRead = resolve; });
      return 'model';
    });
    await vi.waitFor(() => expect(events).toEqual(['read']));

    const mutation = gate.mutateAndCommit(
      async () => {
        events.push('mutation');
        return 'updated';
      },
      () => {},
    );
    await Promise.resolve();
    expect(events).toEqual(['read']);

    releaseRead();
    await expect(read).resolves.toBe('model');
    await expect(mutation).resolves.toEqual({
      result: 'updated',
      catalogRefreshRequiresRestart: true,
    });
    expect(events).toEqual(['read', 'mutation']);
  });

  it('rejects a non-function catalog operation', async () => {
    const gate = createCatalogRegistrationGate(vi.fn(), vi.fn());
    await expect(gate.read(null)).rejects.toThrow('read requires a catalog operation');
    await expect(gate.readUnconfirmed(null)).rejects.toThrow(
      'readUnconfirmed requires a catalog operation',
    );
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

  it('keeps transition readers queued until they finish', async () => {
    const gate = createCatalogRegistrationGate(
      vi.fn(async () => ({ success: true, registeredEps: [], failedEps: [] })),
      vi.fn(async () => []),
    );
    const events = [];
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    const first = gate.read(async () => {
      events.push('first-read');
      await new Promise((resolve) => { releaseFirst = resolve; });
      return 'first';
    });
    const second = gate.read(async () => {
      events.push('second-read');
      await new Promise((resolve) => { releaseSecond = resolve; });
      return 'second';
    });
    const mutation = gate.mutateAndCommit(
      async () => {
        events.push('mutation');
        return 'updated';
      },
      () => {},
    );

    await vi.waitFor(() => expect(events).toEqual(['first-read']));
    releaseFirst();
    await vi.waitFor(() => expect(events).toEqual(['first-read', 'second-read']));
    await Promise.resolve();
    expect(events).toEqual(['first-read', 'second-read']);
    releaseSecond();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    await expect(mutation).resolves.toEqual({
      result: 'updated',
      catalogRefreshRequiresRestart: true,
    });
    expect(events).toEqual(['first-read', 'second-read', 'mutation']);
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

  it('preserves a thrown post-commit update reason while keeping prior providers', async () => {
    const register = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        status: 'Registered 1 execution provider',
        registeredEps: ['CUDAExecutionProvider'],
        failedEps: [],
      })
      .mockRejectedValue(new Error('network down'));
    const gate = createCatalogRegistrationGate(register, vi.fn());

    await gate.commit();
    await expect(gate.rerun()).resolves.toEqual({
      success: false,
      status: 'network down',
      registeredEps: ['CUDAExecutionProvider'],
      failedEps: [],
      catalogRefreshRequiresRestart: true,
    });
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
