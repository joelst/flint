import { describe, expect, it } from 'vitest';
import { createAsyncLogWriter } from './async-log-writer.js';

describe('createAsyncLogWriter', () => {
  it('defers append work until the scheduler runs', async () => {
    const scheduled: Array<() => void> = [];
    const writes: string[] = [];
    const writer = createAsyncLogWriter({
      append: async (chunk) => writes.push(chunk),
      schedule: (callback) => scheduled.push(callback),
    });

    expect(writer.write('one\n')).toBe(true);
    expect(writes).toEqual([]);
    scheduled.shift()?.();
    await writer.flush();
    expect(writes).toEqual(['one\n']);
  });

  it('bounds the queue and reports dropped entries', () => {
    const writer = createAsyncLogWriter({
      append: async () => {},
      schedule: () => {},
      maxQueue: 2,
    });

    expect(writer.write('one\n')).toBe(true);
    expect(writer.write('two\n')).toBe(true);
    expect(writer.write('three\n')).toBe(false);
    expect(writer.pending).toBe(2);
    expect(writer.dropped).toBe(1);
  });

  it('writes queued entries in order and drains entries added during a write', async () => {
    const writes: string[] = [];
    let resolveFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const writer = createAsyncLogWriter({
      append: async (chunk) => {
        writes.push(chunk);
        if (writes.length === 1) await firstWrite;
      },
      schedule: (callback) => queueMicrotask(callback),
    });

    writer.write('one\n');
    await Promise.resolve();
    writer.write('two\n');
    resolveFirst();
    await writer.flush();
    expect(writes).toEqual(['one\n', 'two\n']);
  });

  it('surfaces append failures without rejecting the scheduled drain', async () => {
    const errors: unknown[] = [];
    const writer = createAsyncLogWriter({
      append: async () => { throw new Error('disk full'); },
      onError: (error) => errors.push(error),
      schedule: (callback) => queueMicrotask(callback),
    });

    writer.write('one\n');
    await writer.flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('disk full');
  });
});
