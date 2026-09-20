import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteBenchmarkSuite,
  getBenchmarkSuite,
  listBenchmarkSuites,
  putBenchmarkSuite,
} from './benchmark-repository';
import type { BenchmarkSuite } from './benchmark-suite';

const suite = (over: Partial<BenchmarkSuite> = {}): BenchmarkSuite => ({
  id: 'suite-1',
  name: 'Arithmetic',
  createdAt: 1700000000000,
  targets: [{ alias: 'model-a', variantId: null }],
  cases: [{ id: 'c1', prompt: 'What is 2+2?' }],
  warmupCount: 1,
  repeatCount: 1,
  ...over,
});

/** Each test gets a clean database: fake-indexeddb persists across tests in the same process
 * otherwise, since it's an in-memory singleton keyed by database name. */
async function resetDatabase() {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('flint-benchmarks');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  await resetDatabase();
});

describe('benchmark-repository', () => {
  it('round-trips a suite through put/get/list', async () => {
    const put = await putBenchmarkSuite(suite());
    expect(put).toEqual({ ok: true, value: undefined });

    const got = await getBenchmarkSuite('suite-1');
    expect(got.ok).toBe(true);
    expect(got.value).toEqual(suite());

    const listed = await listBenchmarkSuites();
    expect(listed.ok).toBe(true);
    expect(listed.value).toEqual([suite()]);
  });

  it('returns null (not an error) for a suite id that does not exist', async () => {
    const got = await getBenchmarkSuite('does-not-exist');
    expect(got).toEqual({ ok: true, value: null });
  });

  it('returns an empty list when the store is empty', async () => {
    const listed = await listBenchmarkSuites();
    expect(listed).toEqual({ ok: true, value: [] });
  });

  it('put overwrites an existing suite with the same id', async () => {
    await putBenchmarkSuite(suite({ name: 'Original' }));
    await putBenchmarkSuite(suite({ name: 'Renamed' }));
    const got = await getBenchmarkSuite('suite-1');
    expect(got.value?.name).toBe('Renamed');
    const listed = await listBenchmarkSuites();
    expect(listed.value).toHaveLength(1);
  });

  it('deletes a suite', async () => {
    await putBenchmarkSuite(suite());
    const del = await deleteBenchmarkSuite('suite-1');
    expect(del).toEqual({ ok: true, value: undefined });
    const got = await getBenchmarkSuite('suite-1');
    expect(got.value).toBeNull();
  });

  it('deleting a suite that does not exist is not an error', async () => {
    const del = await deleteBenchmarkSuite('does-not-exist');
    expect(del.ok).toBe(true);
  });

  it('excludes a row that fails shape validation from list, rather than erroring the whole read', async () => {
    // Reach past the module's own validation to simulate corrupt/foreign data already in the
    // store (e.g. written by a future incompatible schema version).
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('flint-benchmarks', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('suites', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('suites', 'readwrite');
        tx.objectStore('suites').put({ id: 'corrupt', not: 'a valid suite' });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      req.onerror = () => reject(req.error);
    });
    await putBenchmarkSuite(suite());

    const listed = await listBenchmarkSuites();
    expect(listed.ok).toBe(true);
    expect(listed.value).toHaveLength(1);
    expect(listed.value?.[0].id).toBe('suite-1');

    // The one row that failed validation is excluded from list, but get() still says it isn't
    // a usable suite too, rather than returning the raw corrupt object.
    const got = await getBenchmarkSuite('corrupt');
    expect(got).toEqual({ ok: true, value: null });
  });

  it('a transaction that is explicitly aborted mid-write leaves the previously stored suite unchanged', async () => {
    await putBenchmarkSuite(suite({ name: 'Original' }));

    // Proof gate: this exercises IndexedDB's own transactional guarantee directly (not this
    // module's wrapper, which never deliberately aborts) — the property a future runner's
    // checkpoint writes will depend on.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('flint-benchmarks', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('suites', 'readwrite');
        tx.objectStore('suites').put(suite({ name: 'Never Committed' }));
        tx.onabort = () => { db.close(); resolve(); };
        tx.oncomplete = () => { db.close(); reject(new Error('transaction unexpectedly completed instead of aborting')); };
        tx.abort();
      };
      req.onerror = () => reject(req.error);
    });

    const got = await getBenchmarkSuite('suite-1');
    expect(got.value?.name).toBe('Original');
  });

  it('reports failure rather than throwing when indexedDB.open itself errors', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', {
      open: () => {
        const listeners: Record<string, ((ev?: unknown) => void) | undefined> = {};
        const fakeRequest: Record<string, unknown> = {
          error: new Error('simulated open failure'),
          set onupgradeneeded(fn: (ev?: unknown) => void) { listeners.onupgradeneeded = fn; },
          set onsuccess(fn: (ev?: unknown) => void) { listeners.onsuccess = fn; },
          set onerror(fn: (ev?: unknown) => void) { listeners.onerror = fn; fn(); },
          set onblocked(fn: (ev?: unknown) => void) { listeners.onblocked = fn; },
        };
        return fakeRequest;
      },
    });
    try {
      const result = await listBenchmarkSuites();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/simulated open failure/);
    } finally {
      vi.stubGlobal('indexedDB', originalIndexedDB);
    }
  });

  it('reports failure with a fallback message when indexedDB.open throws a non-Error value synchronously', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', {
      open: () => {
        // Some environments/mocks throw a bare string or plain object rather than an Error.
        throw 'boom';
      },
    });
    try {
      const result = await listBenchmarkSuites();
      expect(result).toEqual({ ok: false, error: 'Could not open the benchmark database' });
    } finally {
      vi.stubGlobal('indexedDB', originalIndexedDB);
    }
  });

  it('reports failure when the database open is blocked by another connection', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', {
      open: () => {
        const fakeRequest: Record<string, unknown> = {
          set onupgradeneeded(_fn: unknown) { /* not invoked in this scenario */ },
          set onsuccess(_fn: unknown) { /* not invoked in this scenario */ },
          set onerror(_fn: unknown) { /* not invoked in this scenario */ },
          set onblocked(fn: () => void) { fn(); },
        };
        return fakeRequest;
      },
    });
    try {
      const result = await listBenchmarkSuites();
      expect(result).toEqual({ ok: false, error: 'The benchmark database is blocked by another open connection' });
    } finally {
      vi.stubGlobal('indexedDB', originalIndexedDB);
    }
  });

  /** A minimal fake `indexedDB` whose `open()` succeeds immediately and whose `transaction()`
   * returns a fully test-controlled transaction/store pair, so the withStore wrapper's own
   * event-handling logic (settle-once, oncomplete-not-onsuccess, error vs. abort) can be driven
   * directly without depending on which real IndexedDB operations happen to fail. */
  function stubOpenSuccess(makeStore: () => { get: () => unknown; getAll: () => unknown; put: () => unknown; delete: () => unknown }) {
    const txListeners: Record<string, (() => void) | undefined> = {};
    const fakeTx = {
      set oncomplete(fn: () => void) { txListeners.oncomplete = fn; },
      set onerror(fn: () => void) { txListeners.onerror = fn; },
      set onabort(fn: () => void) { txListeners.onabort = fn; },
      objectStore: () => makeStore(),
    };
    vi.stubGlobal('indexedDB', {
      open: () => {
        const fakeRequest: Record<string, unknown> = {
          result: { transaction: () => fakeTx, close: () => {} },
          set onupgradeneeded(_fn: unknown) { /* no upgrade in these scenarios */ },
          set onsuccess(fn: () => void) { fn(); },
          set onerror(_fn: unknown) { /* not invoked */ },
          set onblocked(_fn: unknown) { /* not invoked */ },
        };
        return fakeRequest;
      },
    });
    return txListeners;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports failure when the store method itself throws synchronously', async () => {
    stubOpenSuccess(() => ({
      get: () => { throw new Error('store method threw'); },
      getAll: () => { throw new Error('store method threw'); },
      put: () => { throw new Error('store method threw'); },
      delete: () => { throw new Error('store method threw'); },
    }));
    const result = await getBenchmarkSuite('x');
    expect(result).toEqual({ ok: false, error: 'store method threw' });
  });

  it('propagates a put failure the same way a get failure is propagated', async () => {
    stubOpenSuccess(() => ({
      get: () => undefined,
      getAll: () => undefined,
      put: () => { throw new Error('put failed'); },
      delete: () => undefined,
    }));
    const result = await putBenchmarkSuite(suite());
    expect(result).toEqual({ ok: false, error: 'put failed' });
  });

  it('propagates a delete failure the same way a get failure is propagated', async () => {
    stubOpenSuccess(() => ({
      get: () => undefined,
      getAll: () => undefined,
      put: () => undefined,
      delete: () => { throw new Error('delete failed'); },
    }));
    const result = await deleteBenchmarkSuite('x');
    expect(result).toEqual({ ok: false, error: 'delete failed' });
  });

  it('ignores a request error that arrives after the transaction already settled', async () => {
    let request: { onsuccess?: () => void; onerror?: () => void; error?: Error } = {};
    const txListeners = stubOpenSuccess(() => ({
      get: () => { request = { error: new Error('too late') }; return request; },
      getAll: () => request,
      put: () => request,
      delete: () => request,
    }));
    const resultPromise = getBenchmarkSuite('x');
    await Promise.resolve();
    // The transaction completes first (e.g. the request itself already succeeded)...
    txListeners.oncomplete?.();
    // ...so a subsequently (redundantly) firing request error must be a no-op, not overwrite
    // the already-settled result.
    request.onerror?.();
    const result = await resultPromise;
    expect(result).toEqual({ ok: true, value: null });
  });

  it('ignores a duplicate transaction-complete event that arrives after settling', async () => {
    const txListeners = stubOpenSuccess(() => ({
      get: () => undefined,
      getAll: () => undefined,
      put: () => undefined,
      delete: () => undefined,
    }));
    const resultPromise = getBenchmarkSuite('x');
    await Promise.resolve();
    txListeners.oncomplete?.();
    txListeners.oncomplete?.();
    const result = await resultPromise;
    expect(result).toEqual({ ok: true, value: null });
  });

  it('ignores a duplicate transaction-error event that arrives after settling', async () => {
    const txListeners = stubOpenSuccess(() => ({
      get: () => undefined,
      getAll: () => undefined,
      put: () => undefined,
      delete: () => undefined,
    }));
    const resultPromise = getBenchmarkSuite('x');
    await Promise.resolve();
    txListeners.oncomplete?.();
    txListeners.onerror?.();
    const result = await resultPromise;
    expect(result).toEqual({ ok: true, value: null });
  });

  it('reports failure when the request itself errors, before the transaction settles', async () => {
    let request: { onsuccess?: () => void; onerror?: () => void; error?: Error } = {};
    const txListeners = stubOpenSuccess(() => ({
      get: () => {
        request = { error: new Error('request failed') };
        // Simulate the request erroring on a later microtask, the same as a real IndexedDB.
        queueMicrotask(() => request.onerror?.());
        return request;
      },
      getAll: () => request,
      put: () => request,
      delete: () => request,
    }));
    const resultPromise = getBenchmarkSuite('x');
    await Promise.resolve();
    await Promise.resolve();
    // A real transaction always aborts after an unhandled request error; withStore must have
    // already settled from the request's own onerror, so this later onabort must be a no-op.
    txListeners.onabort?.();
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, error: 'request failed' });
  });

  it('reports failure when the transaction itself errors with no request in flight', async () => {
    const txListeners = stubOpenSuccess(() => ({
      get: () => undefined,
      getAll: () => undefined,
      put: () => undefined,
      delete: () => undefined,
    }));
    const resultPromise = getBenchmarkSuite('x');
    await Promise.resolve();
    txListeners.onerror?.();
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/transaction failed/);
  });

  it('reports failure when the transaction aborts with no prior request error', async () => {
    const txListeners = stubOpenSuccess(() => ({
      get: () => undefined,
      getAll: () => undefined,
      put: () => undefined,
      delete: () => undefined,
    }));
    const resultPromise = getBenchmarkSuite('x');
    await Promise.resolve();
    txListeners.onabort?.();
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/transaction was aborted/);
  });
});
