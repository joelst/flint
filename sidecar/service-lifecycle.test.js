import { describe, expect, it, vi } from 'vitest';
import {
  createServiceTransitionLock,
  stopPartiallyStartedService,
} from './service-lifecycle.js';

describe('stopPartiallyStartedService', () => {
  it('stops the gateway before the native service and clears published state', async () => {
    const steps = [];

    await stopPartiallyStartedService({
      stopGateway: async () => { steps.push('gateway'); },
      stopNativeService: () => { steps.push('native'); },
      clearPublishedService: () => { steps.push('state'); },
      log: vi.fn(),
    });

    expect(steps).toEqual(['gateway', 'native', 'state']);
  });

  it('clears published state when stopping the native service fails', async () => {
    const log = vi.fn();
    const clearPublishedService = vi.fn();

    await stopPartiallyStartedService({
      stopGateway: vi.fn(),
      stopNativeService: () => { throw new Error('native stop failed'); },
      clearPublishedService,
      log,
    });

    expect(clearPublishedService).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('native stop failed'),
    );
  });

  it('awaits asynchronous teardown before clearing published state', async () => {
    const steps = [];
    let releaseNative;
    const stopping = stopPartiallyStartedService({
      stopGateway: async () => { steps.push('gateway'); },
      stopNativeService: () => new Promise((resolve) => {
        releaseNative = () => {
          steps.push('native');
          resolve();
        };
      }),
      clearPublishedService: () => { steps.push('state'); },
      log: vi.fn(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steps).toEqual(['gateway']);
    releaseNative();
    await stopping;
    expect(steps).toEqual(['gateway', 'native', 'state']);
  });

  it('clears published state after an asynchronous native-stop failure', async () => {
    const log = vi.fn();
    const clearPublishedService = vi.fn();

    await stopPartiallyStartedService({
      stopGateway: vi.fn(),
      stopNativeService: () => Promise.reject(new Error('async native stop failed')),
      clearPublishedService,
      log,
    });

    expect(clearPublishedService).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('async native stop failed'),
    );
  });
});

describe('createServiceTransitionLock', () => {
  it('does not admit a later transition before the current one releases', async () => {
    const acquire = createServiceTransitionLock();
    const firstRelease = await acquire();
    let secondEntered = false;
    const second = acquire().then((release) => {
      secondEntered = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondEntered).toBe(false);
    firstRelease();
    const secondRelease = await second;
    expect(secondEntered).toBe(true);
    secondRelease();
  });
});
