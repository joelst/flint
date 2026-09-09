import { describe, expect, it, vi } from 'vitest';
import {
  createSingleFlight,
  createStartupAuthorization,
  prepareHydratedRuntime,
} from './startup-sequence';

describe('prepareHydratedRuntime', () => {
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
      expect(run).toHaveBeenCalledOnce();
      release();
      await expect(first).resolves.toBe(1);

      const retry = singleFlight();
      expect(run).toHaveBeenCalledTimes(2);
      release();
      await expect(retry).resolves.toBe(2);
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

  it('does not require HTTP autostart', async () => {
    const order: string[] = [];

    await prepareHydratedRuntime({
      applyMemorySettings: async () => { order.push('memory'); },
      prepareAccelerators: async () => { order.push('accelerators'); },
    });

    expect(order).toEqual(['memory', 'accelerators']);
  });
});
