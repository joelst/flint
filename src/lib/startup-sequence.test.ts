import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSingleFlight,
  createStartupAuthorization,
  prepareHydratedRuntime,
} from './startup-sequence';

describe('prepareHydratedRuntime', () => {
  it('keeps the page wiring from discarding accelerator readiness', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'routes', '+page.svelte'),
      'utf8',
    );
    const startupStart = source.indexOf('const init = createSingleFlight(performAppInit);');
    const startupEnd = source.indexOf('async function loadModels()');
    expect(startupStart, 'startup sequence start marker not found').toBeGreaterThan(-1);
    expect(startupEnd, 'startup sequence end marker not found').toBeGreaterThan(startupStart);
    const startup = source.slice(startupStart, startupEnd);

    const prepareStart = startup.indexOf('prepareAccelerators:');
    const prepareEnd = startup.indexOf('validateAccelerators:');
    expect(prepareStart, 'accelerator stage marker not found').toBeGreaterThan(-1);
    expect(prepareEnd, 'accelerator validator marker not found').toBeGreaterThan(prepareStart);
    const prepareAccelerators = startup.slice(prepareStart, prepareEnd);
    expect(prepareAccelerators).toContain('return');
    expect(prepareAccelerators).toContain('ensureHardwareAccel({');
    expect(prepareAccelerators).toContain('refreshCatalog: false');

    const fenceStart = startup.indexOf('startupInterrupted ||');
    const fenceEnd = startup.indexOf('if (startupLoaded > 0)');
    expect(fenceStart, 'startup summary fence marker not found').toBeGreaterThan(-1);
    expect(fenceEnd, 'startup summary marker not found').toBeGreaterThan(fenceStart);
    const summaryFence = startup.slice(fenceStart, fenceEnd);
    expect(summaryFence).toContain(
      '!isAcceleratorReadinessCurrent(acceleratorReadiness)',
    );
    expect(summaryFence).toContain('return;');
  });

  it('applies memory policy, then accelerators, then optional service startup', async () => {
    const order: string[] = [];
    let releaseMemory!: () => void;
    let releaseAccelerators!: () => void;
    let releaseService!: () => void;

    const startup = prepareHydratedRuntime({
      applyMemorySettings: () => new Promise<void>((resolve) => {
        order.push('memory');
        releaseMemory = resolve;
      }),
      prepareAccelerators: () => new Promise<void>((resolve) => {
        order.push('accelerators');
        releaseAccelerators = resolve;
      }),
      startService: () => new Promise<void>((resolve) => {
        order.push('service');
        releaseService = resolve;
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['memory']);
    releaseMemory();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['memory', 'accelerators']);
    releaseAccelerators();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['memory', 'accelerators', 'service']);
    let completed = false;
    void startup.then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    releaseService();
    await startup;
  });

  describe('createSingleFlight', () => {
    it('shares one in-flight run and permits a later retry', async () => {
      let release!: () => void;
      const run = vi.fn(() => new Promise<number>((resolve) => {
        release = () => resolve(run.mock.calls.length);
      }));
      const singleFlight = createSingleFlight(run);

      const first = singleFlight();
      const second = singleFlight();
      expect(first).toBe(second);
      expect(run).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(run).toHaveBeenCalledOnce();
      release();
      await expect(first).resolves.toBe(1);

      const retry = singleFlight();
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(2);
      release();
      await expect(retry).resolves.toBe(2);
    });

    it('shares a synchronous failure and permits a later retry', async () => {
      const run = vi.fn<() => Promise<number>>();
      run.mockImplementationOnce(() => {
        throw new Error('synchronous startup failure');
      });
      run.mockResolvedValueOnce(2);
      const singleFlight = createSingleFlight(run);

      const first = singleFlight();
      const second = singleFlight();
      expect(first).toBe(second);
      expect(run).not.toHaveBeenCalled();
      await expect(first).rejects.toThrow('synchronous startup failure');
      expect(run).toHaveBeenCalledOnce();

      await expect(singleFlight()).resolves.toBe(2);
      expect(run).toHaveBeenCalledTimes(2);
    });

    describe('createStartupAuthorization', () => {
      it('invalidates work captured before an explicit Stop', () => {
        const authorization = createStartupAuthorization();
        const captured = authorization.capture();
        expect(authorization.isCurrent(captured)).toBe(true);
        authorization.invalidate();
        expect(authorization.isCurrent(captured)).toBe(false);
      });
    });
  });

  it('does not start later stages when a prerequisite fails', async () => {
    const prepareAccelerators = vi.fn();
    const startService = vi.fn();

    await expect(prepareHydratedRuntime({
      applyMemorySettings: async () => { throw new Error('memory policy rejected'); },
      prepareAccelerators,
      startService,
    })).rejects.toThrow('memory policy rejected');

    expect(prepareAccelerators).not.toHaveBeenCalled();
    expect(startService).not.toHaveBeenCalled();
  });

  it('validates accelerator ownership before service startup', async () => {
    const startService = vi.fn();

    await expect(prepareHydratedRuntime({
      applyMemorySettings: async () => {},
      prepareAccelerators: async () => ({ generation: 1 }),
      validateAccelerators: () => {
        throw new Error('accelerator readiness is stale');
      },
      startService,
    })).rejects.toThrow('accelerator readiness is stale');

    expect(startService).not.toHaveBeenCalled();
  });

  it('does not require HTTP autostart', async () => {
    const order: string[] = [];

    const readiness = await prepareHydratedRuntime({
      applyMemorySettings: async () => { order.push('memory'); },
      prepareAccelerators: async () => {
        order.push('accelerators');
        return { generation: 1, success: false, registeredEps: ['QNN'], failedEps: ['CUDA'] };
      },
    });

    expect(order).toEqual(['memory', 'accelerators']);
    expect(readiness).toEqual({
      generation: 1,
      success: false,
      registeredEps: ['QNN'],
      failedEps: ['CUDA'],
    });
  });
});
