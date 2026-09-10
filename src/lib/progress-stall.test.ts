import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROGRESS_STALL_MS,
  createProgressStallWatchdog,
} from './progress-stall';

afterEach(() => {
  vi.useRealTimers();
});

describe('createProgressStallWatchdog', () => {
  it('does not report a stall before the operation starts', () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    createProgressStallWatchdog(onStall);

    vi.advanceTimersByTime(DEFAULT_PROGRESS_STALL_MS);

    expect(onStall).not.toHaveBeenCalled();
  });

  it('reports one stall after the configured quiet period', () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createProgressStallWatchdog(onStall, 100);

    watchdog.start();
    vi.advanceTimersByTime(99);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('restarts the quiet period when progress resumes', () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createProgressStallWatchdog(onStall, 100);

    watchdog.start();
    vi.advanceTimersByTime(100);
    watchdog.progress();
    vi.advanceTimersByTime(99);
    expect(onStall).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(2);
  });

  it('retires the timer when the operation settles', () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createProgressStallWatchdog(onStall, 100);

    watchdog.start();
    watchdog.stop();
    vi.advanceTimersByTime(100);

    expect(onStall).not.toHaveBeenCalled();
  });
});
