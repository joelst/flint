import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBenchmarkRun,
  deleteBenchmarkSuite,
  deleteBenchmarkSuiteIfNoRuns,
  countBenchmarkRunsForSuite,
  getBenchmarkRun,
  getBenchmarkRunWithAttempts,
  getBenchmarkSuite,
  listAttemptsForRun,
  listAttemptSummariesForRun,
  listBenchmarkRunsForSuite,
  listBenchmarkSuites,
  listDispatchedAttemptsForRun,
  openBenchmarkDatabase,
  putBenchmarkSuite,
  putBenchmarkSuiteIfNoRuns,
  recordAttemptDispatched,
  recordAttemptTerminal,
  updateBenchmarkRunStatus,
} from './benchmark-repository';
import type { BenchmarkAttempt, BenchmarkRun } from './benchmark-run';
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

const run = (over: Partial<BenchmarkRun> = {}): BenchmarkRun => ({
  id: 'run-1',
  suiteId: 'suite-1',
  suite: suite(),
  createdAt: 1700000000000,
  status: 'running',
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
  it('can rerun suites-store setup when the database version increases', async () => {
    expect((await putBenchmarkSuite(suite())).ok).toBe(true);
    const db = await openBenchmarkDatabase();
    try {
      expect(Array.from(db.objectStoreNames)).toContain('suites');
    } finally {
      db.close();
    }
  });

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

  it('putBenchmarkSuiteIfNoRuns saves a suite with zero runs', async () => {
    const result = await putBenchmarkSuiteIfNoRuns(suite());
    expect(result).toEqual({ ok: true, value: undefined });
    const got = await getBenchmarkSuite('suite-1');
    expect(got.value).toEqual(suite());
  });

  it('putBenchmarkSuiteIfNoRuns rejects once the suite has any runs, atomically with the write', async () => {
    await putBenchmarkSuite(suite());
    await createBenchmarkRun(run());
    const result = await putBenchmarkSuiteIfNoRuns(suite({ name: 'Renamed' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/run\(s\) and can no longer be edited/);
    // The rejected write must not have landed — this is what makes it a real invariant rather
    // than an advisory check the caller could race past.
    const got = await getBenchmarkSuite('suite-1');
    expect(got.value?.name).toBe('Arithmetic');
  });

  it('deleteBenchmarkSuiteIfNoRuns deletes a suite with zero runs', async () => {
    await putBenchmarkSuite(suite());
    const result = await deleteBenchmarkSuiteIfNoRuns('suite-1');
    expect(result).toEqual({ ok: true, value: undefined });
    const got = await getBenchmarkSuite('suite-1');
    expect(got.value).toBeNull();
  });

  it('deleteBenchmarkSuiteIfNoRuns refuses to delete once the suite has any runs', async () => {
    await putBenchmarkSuite(suite());
    await createBenchmarkRun(run());
    const result = await deleteBenchmarkSuiteIfNoRuns('suite-1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/run\(s\) and cannot be deleted/);
    const got = await getBenchmarkSuite('suite-1');
    expect(got.value).not.toBeNull();
  });

  it('reports a stored corrupt row as an error, rather than silently excluding it', async () => {
    // Reach past the module's own validation to simulate corrupt/foreign data already in the
    // store (e.g. written by a future incompatible schema version) — putBenchmarkSuite itself
    // now validates before writing, so this can only happen from outside this module.
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

    const listed = await listBenchmarkSuites();
    expect(listed.ok).toBe(false);
    expect(listed.error).toMatch(/failed validation/);

    const got = await getBenchmarkSuite('corrupt');
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/failed validation/);
  });

  it('stores the normalized suite so a padded id is retrievable without padding', async () => {
    const padded = suite({ id: ' suite-1 ' });
    const put = await putBenchmarkSuite(padded);
    expect(put.ok).toBe(true);
    const got = await getBenchmarkSuite(padded.id);
    expect(got.ok).toBe(true);
    expect(got.value?.id).toBe('suite-1');
  });

  it('deletes a suite using the original padded id', async () => {
    const padded = suite({ id: ' suite-1 ' });
    expect((await putBenchmarkSuite(padded)).ok).toBe(true);
    const del = await deleteBenchmarkSuite(padded.id);
    expect(del.ok).toBe(true);
    const got = await getBenchmarkSuite('suite-1');
    expect(got).toEqual({ ok: true, value: null });
  });

  it('rejects an invalid suite without writing anything', async () => {
    const invalid = { ...suite(), name: '' };
    const put = await putBenchmarkSuite(invalid);
    expect(put.ok).toBe(false);
    expect(put.error).toMatch(/name must be a non-empty string/);

    const got = await getBenchmarkSuite('suite-1');
    expect(got).toEqual({ ok: true, value: null });
  });

  it('a transaction that is explicitly aborted mid-write leaves the previously stored suite unchanged', async () => {
    await putBenchmarkSuite(suite({ name: 'Original' }));

    // Proof gate: this exercises IndexedDB's own transactional guarantee directly (not this
    // module's wrapper, which never deliberately aborts on a normal write) — the property a
    // future runner's checkpoint writes will depend on.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('flint-benchmarks');
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

  it('preserves a non-Error diagnostic when indexedDB.open throws a string synchronously', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', {
      open: () => {
        // Some environments/mocks throw a bare string or plain object rather than an Error.
        throw 'boom';
      },
    });
    try {
      const result = await listBenchmarkSuites();
      expect(result).toEqual({ ok: false, error: 'boom' });
    } finally {
      vi.stubGlobal('indexedDB', originalIndexedDB);
    }
  });

  it('preserves a message property when indexedDB.open throws a plain object', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw { message: 'quota exceeded' };
      },
    });
    try {
      const result = await listBenchmarkSuites();
      expect(result).toEqual({ ok: false, error: 'quota exceeded' });
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

  it('closes a connection whose open succeeds after already having been rejected as blocked', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    let closed = false;
    vi.stubGlobal('indexedDB', {
      open: () => {
        let onblockedFn: (() => void) | undefined;
        let onsuccessFn: (() => void) | undefined;
        const fakeRequest: Record<string, unknown> = {
          result: { close: () => { closed = true; } },
          set onupgradeneeded(_fn: unknown) { /* not invoked */ },
          set onsuccess(fn: () => void) { onsuccessFn = fn; },
          set onerror(_fn: unknown) { /* not invoked */ },
          set onblocked(fn: () => void) {
            onblockedFn = fn;
            // Real IndexedDB can fire `blocked` and later `success` for the same request once
            // the blocking connection closes; simulate that ordering here.
            onblockedFn?.();
            onsuccessFn?.();
          },
        };
        return fakeRequest;
      },
    });
    try {
      const result = await listBenchmarkSuites();
      expect(result.ok).toBe(false);
      expect(closed).toBe(true);
    } finally {
      vi.stubGlobal('indexedDB', originalIndexedDB);
    }
  });

  /** A minimal fake `indexedDB` whose `open()` succeeds immediately and whose `transaction()`
   * returns a fully test-controlled transaction/store pair, so withStore's own event-handling
   * logic (settle-once, terminal-event-only, request-error-does-not-itself-settle) can be
   * driven directly. `abort()` synchronously fires `onabort`, matching how this module always
   * uses it: to react to a request that already threw before any request event could fire. */
  function stubOpenSuccess(makeStore: () => { get: () => unknown; getAll: () => unknown; put: () => unknown; delete: () => unknown }) {
    const txListeners: Record<string, (() => void) | undefined> = {};
    const fakeTx = {
      set oncomplete(fn: () => void) { txListeners.oncomplete = fn; },
      set onerror(fn: () => void) { txListeners.onerror = fn; },
      set onabort(fn: () => void) { txListeners.onabort = fn; },
      objectStore: () => makeStore(),
      abort: () => txListeners.onabort?.(),
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

  it('reports failure when the store method itself throws synchronously (and aborts the transaction)', async () => {
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

  it('reports failure using the request error once the transaction aborts after an unhandled request error', async () => {
    let request: { onsuccess?: () => void; onerror?: () => void; error?: Error } = {};
    const txListeners = stubOpenSuccess(() => ({
      get: () => { request = { error: new Error('request failed') }; return request; },
      getAll: () => request,
      put: () => request,
      delete: () => request,
    }));
    const resultPromise = getBenchmarkSuite('x');
    await Promise.resolve();
    let settled = false;
    void resultPromise.then(() => { settled = true; });
    // A real transaction always aborts after an unhandled request error; the request's own
    // onerror only records the message, it must not settle the promise by itself.
    request.onerror?.();
    await Promise.resolve();
    expect(settled).toBe(false);
    txListeners.onabort?.();
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, error: 'request failed' });
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
    txListeners.onabort?.();
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

describe('benchmark-repository: runs and attempts (v2)', () => {
  const testSuite = suite();
  beforeEach(async () => {
    await putBenchmarkSuite(testSuite);
  });
  const testRun = (over: Partial<BenchmarkRun> = {}): BenchmarkRun => ({
    id: 'run-1',
    suiteId: testSuite.id,
    suite: testSuite,
    createdAt: 1700000000000,
    status: 'running',
    ...over,
  });
  const testAttempt = (over: Partial<BenchmarkAttempt> = {}): BenchmarkAttempt => ({
    id: 'exec-1',
    runId: 'run-1',
    logicalAttemptId: 't0:c0:r0',
    targetIndex: 0,
    phase: 'measured',
    caseIndex: 0,
    repeatIndex: 0,
    sequence: 0,
    status: 'dispatched',
    alias: 'model-a',
    requestedVariantId: null,
    intentCommittedAt: 1700000001000,
    ...over,
  });

  it('migrating a database that already has suites (v1) preserves them once upgraded to v2', async () => {
    // Simulates an existing v1 install: create only the `suites` store and one row, exactly as
    // the original PR3 schema would have left on disk, before this module ever runs its own v2
    // upgrade path. Nested beforeEach already opened v3, so wipe first.
    await resetDatabase();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('flint-benchmarks', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('suites', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('suites', 'readwrite');
        tx.objectStore('suites').put(testSuite);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      req.onerror = () => reject(req.error);
    });

    const listed = await listBenchmarkSuites();
    expect(listed).toEqual({ ok: true, value: [testSuite] });

    const db = await openBenchmarkDatabase();
    try {
      expect(Array.from(db.objectStoreNames).sort()).toEqual(['attemptSummaries', 'attempts', 'runs', 'suites']);
    } finally {
      db.close();
    }
  });

  it('backfills attemptSummaries from existing v2 attempt rows on upgrade to v3', async () => {
    await resetDatabase();
    const seeded = testAttempt({
      status: 'succeeded',
      responseText: 'a full response that must not appear on the summary',
      settledAt: 1700000002000,
    });
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('flint-benchmarks', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('suites', { keyPath: 'id' });
        const runs = db.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('bySuiteId', 'suiteId');
        const attempts = db.createObjectStore('attempts', { keyPath: 'id' });
        attempts.createIndex('byRunId', 'runId');
        attempts.createIndex('byRunStatus', ['runId', 'status']);
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['suites', 'runs', 'attempts'], 'readwrite');
        tx.objectStore('suites').put(testSuite);
        tx.objectStore('runs').put(testRun());
        tx.objectStore('attempts').put(seeded);
        tx.objectStore('attempts').put(testAttempt({
          id: 'exec-2',
          logicalAttemptId: 't0:c0:r1',
          repeatIndex: 1,
          sequence: 1,
          status: 'succeeded',
          responseText: 'a second full response that must also not appear on the summary',
          settledAt: 1700000003000,
        }));
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      req.onerror = () => reject(req.error);
    });

    const summaries = await listAttemptSummariesForRun('run-1');
    expect(summaries.ok).toBe(true);
    expect(summaries.value).toHaveLength(2);
    expect(summaries.value).toEqual(expect.arrayContaining([
      {
        id: 'exec-1',
        runId: 'run-1',
        logicalAttemptId: 't0:c0:r0',
        targetIndex: 0,
        phase: 'measured',
        caseIndex: 0,
        repeatIndex: 0,
        sequence: 0,
        status: 'succeeded',
      },
      {
        id: 'exec-2',
        runId: 'run-1',
        logicalAttemptId: 't0:c0:r1',
        targetIndex: 0,
        phase: 'measured',
        caseIndex: 0,
        repeatIndex: 1,
        sequence: 1,
        status: 'succeeded',
      },
    ]));
    expect(summaries.value!.every((row) => !('responseText' in row))).toBe(true);
  });

  it('refuses to create a run whose frozen snapshot no longer matches the stored suite', async () => {
    await putBenchmarkSuite(testSuite);
    const stale = testRun({
      suite: { ...testSuite, cases: [{ id: 'c-edited', prompt: 'changed' }] },
    });
    const result = await createBenchmarkRun(stale);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stale snapshot/);
    expect(await getBenchmarkRun('run-1')).toEqual({ ok: true, value: null });
  });

  it('refuses to create a run whose suite row no longer exists', async () => {
    await deleteBenchmarkSuite(testSuite.id);
    const result = await createBenchmarkRun(testRun());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not exist/);
    expect(await getBenchmarkRun('run-1')).toEqual({ ok: true, value: null });
  });

  it('round-trips a run through create/get, and lists it by suite', async () => {
    expect(await createBenchmarkRun(testRun())).toEqual({ ok: true, value: undefined });
    expect(await getBenchmarkRun('run-1')).toEqual({ ok: true, value: testRun() });
    expect(await listBenchmarkRunsForSuite(testSuite.id)).toEqual({ ok: true, value: [testRun()] });
  });

  it('countBenchmarkRunsForSuite matches listBenchmarkRunsForSuite length without reading full rows', async () => {
    expect(await countBenchmarkRunsForSuite(testSuite.id)).toEqual({ ok: true, value: 0 });
    await createBenchmarkRun(testRun());
    await createBenchmarkRun(testRun({ id: 'run-2' }));
    expect(await countBenchmarkRunsForSuite(testSuite.id)).toEqual({ ok: true, value: 2 });
    expect(await countBenchmarkRunsForSuite('no-such-suite')).toEqual({ ok: true, value: 0 });
  });

  it('getBenchmarkRunWithAttempts returns null for a run id that does not exist', async () => {
    expect(await getBenchmarkRunWithAttempts('missing')).toEqual({ ok: true, value: null });
  });

  it('getBenchmarkRunWithAttempts reads the run and its full attempt history together', async () => {
    await createBenchmarkRun(testRun());
    await recordAttemptDispatched(testAttempt());
    await recordAttemptTerminal('exec-1', { status: 'succeeded', responseText: 'hi', settledAt: 42 });
    const result = await getBenchmarkRunWithAttempts('run-1');
    expect(result.ok).toBe(true);
    expect(result.value!.run).toEqual(testRun());
    expect(result.value!.attempts).toHaveLength(1);
    expect(result.value!.attempts[0]).toMatchObject({ id: 'exec-1', status: 'succeeded', responseText: 'hi' });
  });

  it('returns null (not an error) for a run id that does not exist', async () => {
    expect(await getBenchmarkRun('missing')).toEqual({ ok: true, value: null });
  });

  it('rejects a malformed run without writing anything', async () => {
    const result = await createBenchmarkRun({ ...testRun(), status: 'bogus' as never });
    expect(result.ok).toBe(false);
    expect(await getBenchmarkRun('run-1')).toEqual({ ok: true, value: null });
  });

  it('updateBenchmarkRunStatus merges onto the existing row without touching the suite snapshot', async () => {
    await createBenchmarkRun(testRun());
    const update = await updateBenchmarkRunStatus('run-1', 'completed', { startedAt: 5, finalizedAt: 9 });
    expect(update).toEqual({ ok: true, value: undefined });
    const got = await getBenchmarkRun('run-1');
    expect(got.value).toEqual(testRun({ status: 'completed', startedAt: 5, finalizedAt: 9 }));
  });

  it('updateBenchmarkRunStatus fails when the run does not exist', async () => {
    const result = await updateBenchmarkRunStatus('missing', 'stopped');
    expect(result.ok).toBe(false);
  });

  it('writes a dispatched attempt as the write-ahead intent, before any terminal outcome exists', async () => {
    const result = await recordAttemptDispatched(testAttempt());
    expect(result).toEqual({ ok: true, value: undefined });
    const listed = await listAttemptsForRun('run-1');
    expect(listed).toEqual({ ok: true, value: [testAttempt()] });
  });

  it('reads attempt summaries from the projection store, not full attempt bodies', async () => {
    await recordAttemptDispatched(testAttempt());
    const summaries = await listAttemptSummariesForRun('run-1');
    expect(summaries.ok).toBe(true);
    expect(summaries.value).toEqual([{
      id: 'exec-1',
      runId: 'run-1',
      logicalAttemptId: 't0:c0:r0',
      targetIndex: 0,
      phase: 'measured',
      caseIndex: 0,
      repeatIndex: 0,
      sequence: 0,
      status: 'dispatched',
    }]);
  });

  it('rejects recordAttemptDispatched for a non-dispatched status, matching the write-ahead-only contract', async () => {
    const result = await recordAttemptDispatched(testAttempt({ status: 'succeeded', responseText: 'ok', settledAt: 2 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dispatched/);
  });

  it('recordAttemptTerminal merges a success outcome onto the dispatched row in the same transaction', async () => {
    await recordAttemptDispatched(testAttempt());
    const terminal = await recordAttemptTerminal('exec-1', {
      status: 'succeeded',
      responseText: 'four',
      settledAt: 2000,
      sdkCallStartedAt: 1500,
    });
    expect(terminal).toEqual({ ok: true, value: undefined });
    const listed = await listAttemptsForRun('run-1');
    expect(listed.value).toEqual([testAttempt({
      status: 'succeeded',
      responseText: 'four',
      settledAt: 2000,
      sdkCallStartedAt: 1500,
    })]);
  });

  it('recordAttemptTerminal fails (and leaves nothing changed) when the attempt does not exist', async () => {
    const result = await recordAttemptTerminal('missing', { status: 'failed', errorMessage: 'x', settledAt: 1 });
    expect(result.ok).toBe(false);
    expect(await listAttemptsForRun('run-1')).toEqual({ ok: true, value: [] });
  });

  it('recordAttemptTerminal refuses to overwrite an attempt that is already terminal', async () => {
    await recordAttemptDispatched(testAttempt());
    const first = await recordAttemptTerminal('exec-1', { status: 'succeeded', responseText: 'four', settledAt: 2 });
    expect(first.ok).toBe(true);

    const second = await recordAttemptTerminal('exec-1', { status: 'failed', errorMessage: 'retried', settledAt: 3 });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already terminal/);

    // The original terminal outcome must be untouched by the rejected second write.
    const listed = await listAttemptsForRun('run-1');
    expect(listed.value).toEqual([testAttempt({ status: 'succeeded', responseText: 'four', settledAt: 2 })]);
  });

  it('listDispatchedAttemptsForRun finds only still-uncertain attempts via the byRunStatus index', async () => {
    await recordAttemptDispatched(testAttempt({ id: 'exec-1', logicalAttemptId: 't0:c0:r0' }));
    await recordAttemptDispatched(testAttempt({ id: 'exec-2', logicalAttemptId: 't0:c0:r1' }));
    await recordAttemptTerminal('exec-2', { status: 'succeeded', responseText: 'ok', settledAt: 2 });

    const dispatched = await listDispatchedAttemptsForRun('run-1');
    expect(dispatched.ok).toBe(true);
    expect(dispatched.value?.map((a) => a.id)).toEqual(['exec-1']);
  });

  it('listDispatchedAttemptsForRun does not cross runs', async () => {
    await createBenchmarkRun(testRun({ id: 'run-2' }));
    await recordAttemptDispatched(testAttempt({ id: 'exec-1', runId: 'run-1' }));
    await recordAttemptDispatched(testAttempt({ id: 'exec-2', runId: 'run-2', logicalAttemptId: 't0:c0:r0' }));
    const forRun1 = await listDispatchedAttemptsForRun('run-1');
    expect(forRun1.value?.map((a) => a.id)).toEqual(['exec-1']);
  });

  it('listAttemptSummariesForRun projects out response/usage/error fields, keeping only what progress polling needs', async () => {
    await recordAttemptDispatched(testAttempt({ id: 'exec-1', logicalAttemptId: 't0:c0:r0' }));
    await recordAttemptTerminal('exec-1', { status: 'succeeded', responseText: 'a long response body', settledAt: 2 });

    const summaries = await listAttemptSummariesForRun('run-1');
    expect(summaries).toEqual({
      ok: true,
      value: [{
        id: 'exec-1',
        runId: 'run-1',
        logicalAttemptId: 't0:c0:r0',
        targetIndex: 0,
        phase: 'measured',
        caseIndex: 0,
        repeatIndex: 0,
        sequence: 0,
        status: 'succeeded',
      }],
    });
    // No response text, usage, or timestamps leak through into the lightweight projection.
    expect(summaries.value![0]).not.toHaveProperty('responseText');
    expect(summaries.value![0]).not.toHaveProperty('usage');
    expect(summaries.value![0]).not.toHaveProperty('errorMessage');
  });

  it('reports a stored corrupt attempt row as an error rather than silently excluding it', async () => {
    const db = await openBenchmarkDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('attempts', 'readwrite');
      tx.objectStore('attempts').put({ id: 'corrupt', runId: 'run-1', not: 'valid' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const listed = await listAttemptsForRun('run-1');
    expect(listed.ok).toBe(false);
    expect(listed.error).toMatch(/failed validation/);
  });

  it('reports a stored corrupt attempt summary row as an error rather than silently misplacing it', async () => {
    const db = await openBenchmarkDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('attemptSummaries', 'readwrite');
      tx.objectStore('attemptSummaries').put({ id: 'corrupt', runId: 'run-1', not: 'valid' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const listed = await listAttemptSummariesForRun('run-1');
    expect(listed.ok).toBe(false);
    expect(listed.error).toMatch(/failed validation/);
  });

  it('reports failure when starting a multi-store transaction itself throws synchronously', async () => {
    const originalIndexedDB = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', {
      open: () => {
        const fakeRequest: Record<string, unknown> = {
          result: {
            transaction: () => { throw new Error('transaction() threw'); },
            close: () => {},
          },
          set onupgradeneeded(_fn: unknown) { /* not invoked */ },
          set onsuccess(fn: () => void) { fn(); },
          set onerror(_fn: unknown) { /* not invoked */ },
          set onblocked(_fn: unknown) { /* not invoked */ },
        };
        return fakeRequest;
      },
    });
    try {
      const result = await getBenchmarkRun('x');
      expect(result).toEqual({ ok: false, error: 'transaction() threw' });
    } finally {
      vi.stubGlobal('indexedDB', originalIndexedDB);
    }
  });
});
