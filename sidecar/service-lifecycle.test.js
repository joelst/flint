import { describe, expect, it, vi } from 'vitest';
import {
  createOperationAdmission,
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

describe('createOperationAdmission', () => {
  it('atomically fences new work and reports operations already in flight', () => {
    const admission = createOperationAdmission();
    expect(admission.admit(1, 'load')).toBe(true);
    expect(admission.beginDrain()).toEqual([{ id: 1, command: 'load' }]);
    expect(admission.admit(2, 'download')).toBe(false);
    expect(admission.snapshot()).toEqual([{ id: 1, command: 'load' }]);
  });

  it('resolves a drain only after every admitted operation completes', async () => {
    const admission = createOperationAdmission();
    admission.admit(1, 'load');
    admission.admit(2, 'chatCompletion');
    admission.beginDrain();

    const drained = admission.waitForDrain(100);
    admission.complete(1);
    await Promise.resolve();
    let settled = false;
    drained.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    admission.complete(2);
    await expect(drained).resolves.toBe(true);
  });

  it('reports a bounded drain timeout without forgetting active work', async () => {
    vi.useFakeTimers();
    const admission = createOperationAdmission();
    admission.admit(7, 'transcribeAudio');
    admission.beginDrain();

    const drained = admission.waitForDrain(50);
    await vi.advanceTimersByTimeAsync(49);
    let settled = false;
    drained.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(drained).resolves.toBe(false);
    expect(admission.snapshot()).toEqual([{ id: 7, command: 'transcribeAudio' }]);
  });

  it('can resume admission after a non-terminal drain', () => {
    const admission = createOperationAdmission();
    admission.beginDrain();
    expect(admission.admit(1, 'load')).toBe(false);
    admission.resume();
    expect(admission.admit(1, 'load')).toBe(true);
  });

  it('never reopens admission after a terminal drain begins', () => {
    const admission = createOperationAdmission();
    admission.beginDrain();
    admission.beginDrain({ terminal: true });
    admission.resume();
    expect(admission.admit(1, 'load')).toBe(false);
  });
});
