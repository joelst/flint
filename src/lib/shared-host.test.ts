import { describe, expect, it } from 'vitest';
import {
  SHARED_HOST_KEY,
  initPayloadForSharedHost,
  readSharedHost,
  writeSharedHost,
} from './shared-host';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe('shared host preference', () => {
  it('stays off when nothing has been saved', () => {
    expect(readSharedHost(memoryStorage())).toBe(false);
    expect(readSharedHost(null)).toBe(false);
  });

  it('saves an explicit opt-in and clears it when turned off', () => {
    const storage = memoryStorage();
    expect(writeSharedHost(storage, true)).toBe(true);
    expect(storage.getItem(SHARED_HOST_KEY)).toBe('1');
    expect(readSharedHost(storage)).toBe(true);
    expect(writeSharedHost(storage, false)).toBe(true);
    expect(storage.getItem(SHARED_HOST_KEY)).toBeNull();
    expect(readSharedHost(storage)).toBe(false);
  });

  it('reports a failed save', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(writeSharedHost(storage, true)).toBe(false);
    expect(readSharedHost({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
      removeItem: () => {},
    })).toBe(false);
  });

  it('omits useSharedHost unless the next runtime should join the host', () => {
    const payload = { appName: 'flint', logLevel: 'info', useSharedHost: true };
    expect(initPayloadForSharedHost(payload, false)).toEqual({
      appName: 'flint',
      logLevel: 'info',
    });
    expect(initPayloadForSharedHost({ appName: 'flint', logLevel: 'info' }, true)).toEqual({
      appName: 'flint',
      logLevel: 'info',
      useSharedHost: true,
    });
  });
});
