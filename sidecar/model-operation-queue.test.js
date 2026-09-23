import { describe, expect, it, vi } from 'vitest';
import { createModelOperationQueue } from './model-operation-queue.js';

describe('createModelOperationQueue', () => {
  it('serializes operations for one alias and passes the preceding result', async () => {
    const queue = createModelOperationQueue();
    const events = [];
    let release = () => {};
    const first = queue.run('model-a', ['residency'], async ({ waited }) => {
      events.push('first');
      expect(waited).toBe(false);
      await new Promise((resolve) => {
        release = resolve;
      });
      return { loadedNow: true };
    });
    const second = queue.run('model-a', ['residency'], async ({ waited, previousResult }) => {
      events.push('second');
      expect(waited).toBe(true);
      expect(previousResult).toEqual({ loadedNow: true });
      return 'deleted';
    });

    await vi.waitFor(() => expect(events).toEqual(['first']));
    release();
    await expect(first).resolves.toEqual({ loadedNow: true });
    await expect(second).resolves.toBe('deleted');
    expect(events).toEqual(['first', 'second']);
  });

  it('allows independent aliases to run concurrently', async () => {
    const queue = createModelOperationQueue();
    const events = [];
    let releaseA = () => {};
    let releaseB = () => {};
    const first = queue.run('model-a', ['residency'], async () => {
      events.push('a');
      await new Promise((resolve) => {
        releaseA = resolve;
      });
    });
    const second = queue.run('model-b', ['residency'], async () => {
      events.push('b');
      await new Promise((resolve) => {
        releaseB = resolve;
      });
    });

    await vi.waitFor(() => expect(events).toEqual(['a', 'b']));
    releaseA();
    releaseB();
    await Promise.all([first, second]);
  });

  it('continues after a rejected operation', async () => {
    const queue = createModelOperationQueue();
    const first = queue.run('model-a', ['residency'], async () => {
      throw new Error('load failed');
    });
    const second = queue.run('model-a', ['residency'], async ({ waited, previousResult }) => {
      expect(waited).toBe(true);
      expect(previousResult).toBeUndefined();
      return 'recovered';
    });

    await expect(first).rejects.toThrow('load failed');
    await expect(second).resolves.toBe('recovered');
  });

  it('rejects invalid keys and operations', async () => {
    const queue = createModelOperationQueue();
    await expect(queue.run('', ['residency'], () => {})).rejects.toThrow('non-empty string');
    await expect(queue.run('model-a', [], () => {})).rejects.toThrow('scopes');
    await expect(queue.run('model-a', ['residency'], null)).rejects.toThrow('must be a function');
  });

  it('blocks delete on cache and residency without blocking residency on download', async () => {
    const queue = createModelOperationQueue();
    const events = [];
    let releaseDownload = () => {};
    const download = queue.run('model-a', ['cache'], async () => {
      events.push('download');
      await new Promise((resolve) => {
        releaseDownload = resolve;
      });
    });
    const load = queue.run('model-a', ['residency'], async () => {
      events.push('load');
    });
    const deletion = queue.run('model-a', ['cache', 'residency'], async () => {
      events.push('delete');
    });

    await vi.waitFor(() => expect(events).toEqual(['download', 'load']));
    await load;
    releaseDownload();
    await Promise.all([download, deletion]);
    expect(events).toEqual(['download', 'load', 'delete']);
  });
});
