/**
 * Benchmark Preview storage: IndexedDB, not `localStorage`.
 *
 * Quick Compare's history (`comparison-history.ts`) fits comfortably in a single localStorage
 * key because it is a small, atomically-replaced blob. A benchmark run's attempt journal does
 * not: a runner checkpoints potentially hundreds of independently-completing attempts, and
 * re-serializing the whole run on every single checkpoint is the wrong write primitive for that.
 * This module committed to IndexedDB from the first PR for exactly this reason — so this v2
 * migration adds object stores to an already-proven transactional database rather than
 * migrating storage backends mid-feature.
 *
 * v2 adds `runs` and `attempts`. v3 adds `attemptSummaries` so live polling can read progress
 * without structured-cloning full response bodies.
 *
 * No UI reads any of this yet.
 */

import { isStoredBenchmarkSuite, validateBenchmarkSuite, type BenchmarkSuite } from './benchmark-suite';
import { isBenchmarkAttempt, isBenchmarkRun, type BenchmarkAttempt, type BenchmarkRun, type RunStatus } from './benchmark-run';
import { summarizeAttempt, type AttemptSummary } from './benchmark-progress';

const DATABASE_NAME = 'flint-benchmarks';
const DATABASE_VERSION = 3;
const SUITES_STORE = 'suites';
const RUNS_STORE = 'runs';
const ATTEMPTS_STORE = 'attempts';
const ATTEMPT_SUMMARIES_STORE = 'attemptSummaries';
const RUNS_BY_SUITE_INDEX = 'bySuiteId';
const ATTEMPTS_BY_RUN_INDEX = 'byRunId';
const ATTEMPTS_BY_RUN_STATUS_INDEX = 'byRunStatus';
const ATTEMPT_SUMMARIES_BY_RUN_INDEX = 'byRunId';

/** Idempotent schema setup: each version bump only adds what is missing, so upgrading from any
 * earlier version (including a fresh v1 database) never drops existing stores or data. */
export function upgradeBenchmarkDatabase(db: IDBDatabase, tx: IDBTransaction | null = null): void {
  if (!db.objectStoreNames.contains(SUITES_STORE)) {
    db.createObjectStore(SUITES_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(RUNS_STORE)) {
    const runs = db.createObjectStore(RUNS_STORE, { keyPath: 'id' });
    runs.createIndex(RUNS_BY_SUITE_INDEX, 'suiteId');
  }
  if (!db.objectStoreNames.contains(ATTEMPTS_STORE)) {
    const attempts = db.createObjectStore(ATTEMPTS_STORE, { keyPath: 'id' });
    attempts.createIndex(ATTEMPTS_BY_RUN_INDEX, 'runId');
    attempts.createIndex(ATTEMPTS_BY_RUN_STATUS_INDEX, ['runId', 'status']);
  }
  if (!db.objectStoreNames.contains(ATTEMPT_SUMMARIES_STORE)) {
    const summaries = db.createObjectStore(ATTEMPT_SUMMARIES_STORE, { keyPath: 'id' });
    summaries.createIndex(ATTEMPT_SUMMARIES_BY_RUN_INDEX, 'runId');
    if (tx && db.objectStoreNames.contains(ATTEMPTS_STORE)) {
      // Cursor, not getAll(): a v2 store can hold every historical response body, and
      // materializing them all at once during upgrade can stall or exhaust memory.
      const cursorReq = tx.objectStore(ATTEMPTS_STORE).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const row = cursor.value;
        if (isBenchmarkAttempt(row)) summaries.put(summarizeAttempt(row));
        cursor.continue();
      };
    }
  }
}

export interface RepositoryResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function okResult<T>(value: T): RepositoryResult<T> {
  return { ok: true, value };
}

function failResult<T>(error: string): RepositoryResult<T> {
  return { ok: false, error };
}

function describeDomException(e: unknown, fallback: string): string {
  if (typeof e === 'string' && e.trim()) return e;
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    const message = (e as { message: string }).message.trim();
    if (message) return message;
  }
  return fallback;
}

/**
 * Opens (and upgrades, if needed) the benchmark database. Rejects rather than falling back to
 * any other storage — a caller that cannot open this database has no suite persistence this
 * session, and must be told that plainly rather than silently losing durability guarantees.
 */
export function openBenchmarkDatabase(version = DATABASE_VERSION): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, version);
    } catch (e) {
      reject(new Error(describeDomException(e, 'Could not open the benchmark database')));
      return;
    }
    request.onupgradeneeded = () => {
      upgradeBenchmarkDatabase(request.result, request.transaction);
    };
    request.onsuccess = () => {
      if (settled) {
        // A rejected (e.g. blocked) open whose request later succeeds anyway must not leak
        // this now-unwanted connection.
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error(describeDomException(request.error, 'Could not open the benchmark database')));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error('The benchmark database is blocked by another open connection'));
    };
  });
}

/** Runs `body` against one or more stores inside a single transaction, resolving only when the
 * transaction itself reaches a terminal state (`complete` or `abort`) — a request can succeed
 * while the surrounding transaction still fails or is aborted afterward, so a request's own
 * `onsuccess`/`onerror` is never itself the settling event; only the transaction's terminal
 * event is. `body` may issue more than one request (e.g. a read-then-write) and returns the
 * value to resolve with directly, rather than relying on a single request's result — this is
 * what lets attempt updates (get existing row, then put the merged one) share one transaction. */
async function withStores<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  body: (
    tx: IDBTransaction,
    trackRequest: (request: IDBRequest) => void,
  ) => T | Promise<T>,
): Promise<RepositoryResult<T>> {
  let db: IDBDatabase;
  try {
    db = await openBenchmarkDatabase();
  } catch (e) {
    return failResult((e as Error).message);
  }
  try {
    return await new Promise((resolve) => {
      let settled = false;
      let requestErrorMessage: string | undefined;
      const resultBox: { value?: T } = {};
      let tx: IDBTransaction;
      try {
        tx = db.transaction(storeNames, mode);
      } catch (e) {
        resolve(failResult(describeDomException(e, 'Could not start a benchmark database transaction')));
        return;
      }
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(okResult(resultBox.value as T));
      };
      tx.onerror = () => {
        // Not terminal: an unhandled request error bubbles here before the transaction aborts.
        requestErrorMessage = requestErrorMessage
          ?? describeDomException(tx.error, 'Benchmark database transaction failed');
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        resolve(failResult(
          requestErrorMessage ?? describeDomException(tx.error, 'Benchmark database transaction was aborted'),
        ));
      };
      const trackRequest = (request: IDBRequest) => {
        request.onerror = () => {
          // Do not settle here: an unhandled request error always aborts the transaction, and
          // `onabort` above is the true terminal signal — settling here would report success
          // or failure before the transaction's own outcome is actually known.
          requestErrorMessage = describeDomException(request.error, 'Benchmark database request failed');
        };
      };
      // Invoked synchronously (not after an extra microtask hop) so `body`'s first IDBRequest
      // is made in the same task that created the transaction — required for the transaction
      // to still be active when that request is issued.
      let bodyResult: T | Promise<T>;
      try {
        bodyResult = body(tx, trackRequest);
      } catch (e) {
        requestErrorMessage = describeDomException(e, 'Benchmark database request failed');
        try { tx.abort(); } catch { /* already inactive/aborted */ }
        return;
      }
      Promise.resolve(bodyResult)
        .then((value) => { resultBox.value = value; })
        .catch((e) => {
          // A rejected `body` (e.g. a chained request's own error) does not itself abort the
          // transaction, so record it and explicitly abort — the handlers above (already
          // attached) then report it.
          requestErrorMessage = describeDomException(e, 'Benchmark database request failed');
          try { tx.abort(); } catch { /* already inactive/aborted */ }
        });
    });
  } finally {
    db.close();
  }
}

/** Wraps a single IDBRequest as a promise, tracking it so its error (if any) is attributed
 * correctly by `withStores` while still leaving the transaction's own terminal event as the
 * only thing that settles the outer promise. */
function requestAsPromise<T>(
  request: IDBRequest<T>,
  trackRequest: (request: IDBRequest) => void,
): Promise<T> {
  trackRequest(request);
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    // No separate onerror settling here: a request error aborts the transaction, and
    // `withStores` resolves the outer promise from that abort, never from this request alone.
  });
}

/** Issues `getRequest`, and — synchronously from within its own `onsuccess` handler, with no
 * intervening `await`/microtask hop — hands the result to `next` to build and issue a follow-up
 * request in the *same* transaction. `await`ing a get and only then calling `store.put(...)`
 * would insert a microtask gap between the two requests; some IndexedDB implementations treat a
 * transaction as inactive by the time that continuation runs, throwing `TransactionInactiveError`
 * even though nothing else touched the transaction in between. Chaining inside the success
 * handler itself keeps both requests unambiguously within the transaction's active window on
 * every implementation, not just ones that special-case microtask continuations. `next` may
 * throw (e.g. validation failure) or return `undefined` to reject without issuing a follow-up
 * request at all. */
function chainFromSuccess<TGet, TNext>(
  getRequest: IDBRequest<TGet>,
  trackRequest: (request: IDBRequest) => void,
  next: (result: TGet) => IDBRequest<TNext> | never,
): Promise<TNext> {
  trackRequest(getRequest);
  return new Promise((resolve, reject) => {
    getRequest.onsuccess = () => {
      let nextRequest: IDBRequest<TNext>;
      try {
        nextRequest = next(getRequest.result);
      } catch (e) {
        reject(e);
        return;
      }
      trackRequest(nextRequest);
      nextRequest.onsuccess = () => resolve(nextRequest.result);
    };
  });
}

/** Back-compat single-store single-request helper used by the original suite CRUD below. */
async function withStore<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<RepositoryResult<T | undefined>> {
  return withStores<T | undefined>(SUITES_STORE, mode, (tx, trackRequest) => {
    const store = tx.objectStore(SUITES_STORE);
    const request = body(store);
    if (!request) return undefined;
    return requestAsPromise(request, trackRequest);
  });
}

/** Suites that fail shape validation are treated as a repository-level error, not silently
 * dropped — matching `comparison-history.ts`'s stance that one corrupt entry invalidates the
 * whole read rather than quietly returning a partial (and therefore misleading) result. Because
 * `putBenchmarkSuite` validates before writing, a corrupt row here can only come from a future
 * incompatible schema version or data written outside this module, and callers need to know
 * that happened rather than be told nothing exists. */
export async function listBenchmarkSuites(): Promise<RepositoryResult<BenchmarkSuite[]>> {
  const result = await withStore<BenchmarkSuite[]>('readonly', (store) => store.getAll() as IDBRequest<BenchmarkSuite[]>);
  if (!result.ok) return failResult(result.error!);
  const rows = result.value ?? [];
  const invalidIndex = rows.findIndex((row) => !isStoredBenchmarkSuite(row));
  if (invalidIndex !== -1) {
    return failResult(`stored benchmark suite at index ${invalidIndex} failed validation`);
  }
  return okResult(rows);
}

function suiteIdKey(id: string): string {
  return id.trim();
}

export async function getBenchmarkSuite(id: string): Promise<RepositoryResult<BenchmarkSuite | null>> {
  const result = await withStore<BenchmarkSuite>('readonly', (store) => store.get(suiteIdKey(id)) as IDBRequest<BenchmarkSuite>);
  if (!result.ok) return failResult(result.error!);
  if (result.value === undefined) return okResult(null);
  if (!isStoredBenchmarkSuite(result.value)) return failResult(`stored benchmark suite "${id}" failed validation`);
  return okResult(result.value);
}

/** Upserts a suite, keyed by `suite.id`. Validates and normalizes before writing — this is the
 * only write path, so a corrupt stored row can only come from a future incompatible schema
 * version or data written outside this module. Resolves only once the write transaction has
 * genuinely committed — never merely queued. */
export async function putBenchmarkSuite(suite: BenchmarkSuite): Promise<RepositoryResult<void>> {
  const validated = validateBenchmarkSuite(suite);
  if (!validated.ok) return failResult(validated.errors.join('; '));
  const result = await withStore<IDBValidKey>('readwrite', (store) => store.put(validated.value));
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}

export async function deleteBenchmarkSuite(id: string): Promise<RepositoryResult<void>> {
  const result = await withStore<undefined>('readwrite', (store) => store.delete(suiteIdKey(id)));
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}

/**
 * Guarded upsert: rejects (inside the same transaction as the count check, so a concurrently
 * created run cannot race past it) if the suite already has any runs. Editing a suite with run
 * history would silently change what an already-frozen run snapshot appears to represent, so
 * this is the only path the UI's suite editor should use once it stops treating "zero runs" as
 * a merely advisory, staleness-prone check.
 */
export async function putBenchmarkSuiteIfNoRuns(suite: BenchmarkSuite): Promise<RepositoryResult<void>> {
  const validated = validateBenchmarkSuite(suite);
  if (!validated.ok) return failResult(validated.errors.join('; '));
  const suiteId = validated.value!.id;
  const result = await withStores<void>([SUITES_STORE, RUNS_STORE], 'readwrite', (tx, trackRequest) => {
    const runsIndex = tx.objectStore(RUNS_STORE).index(RUNS_BY_SUITE_INDEX);
    const countRequest = runsIndex.count(suiteId) as IDBRequest<number>;
    return chainFromSuccess(countRequest, trackRequest, (count) => {
      if (count > 0) throw new Error(`suite "${suiteId}" has ${count} run(s) and can no longer be edited`);
      return tx.objectStore(SUITES_STORE).put(validated.value) as IDBRequest<IDBValidKey>;
    }).then(() => undefined);
  });
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}

/** Guarded delete counterpart to `putBenchmarkSuiteIfNoRuns` — see its docstring. */
export async function deleteBenchmarkSuiteIfNoRuns(id: string): Promise<RepositoryResult<void>> {
  const key = suiteIdKey(id);
  const result = await withStores<void>([SUITES_STORE, RUNS_STORE], 'readwrite', (tx, trackRequest) => {
    const runsIndex = tx.objectStore(RUNS_STORE).index(RUNS_BY_SUITE_INDEX);
    const countRequest = runsIndex.count(key) as IDBRequest<number>;
    return chainFromSuccess(countRequest, trackRequest, (count) => {
      if (count > 0) throw new Error(`suite "${key}" has ${count} run(s) and cannot be deleted`);
      return tx.objectStore(SUITES_STORE).delete(key) as IDBRequest<undefined>;
    }).then(() => undefined);
  });
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}

// --- Runs and attempts -------------------------------------------------------------------
//
// A run's suite snapshot is frozen at creation and never re-validated against the live
// `suites` store — editing or deleting a suite must never affect a run already created from
// it. Attempts are journaled one row per execution; recovery/resume logic (which execution to
// treat as uncertain, which logical position to retry) lives in `benchmark-run.ts`, not here —
// this module only durably persists whatever it is asked to write and reads it back honestly.

/** Creates a run, keyed by `run.id`. The caller is responsible for freezing the suite snapshot
 * before calling this — this function does not re-fetch or re-validate against `suites`. */
export async function createBenchmarkRun(run: BenchmarkRun): Promise<RepositoryResult<void>> {
  if (!isBenchmarkRun(run)) return failResult('run failed shape validation');
  const result = await withStores<void>([RUNS_STORE, SUITES_STORE], 'readwrite', (tx, trackRequest) => {
    const getSuite = tx.objectStore(SUITES_STORE).get(run.suiteId) as IDBRequest<BenchmarkSuite | undefined>;
    return chainFromSuccess(getSuite, trackRequest, (suite) => {
      if (suite === undefined) {
        throw new Error(`suite "${run.suiteId}" does not exist; refusing to create an orphaned run`);
      }
      return tx.objectStore(RUNS_STORE).add(run) as IDBRequest<IDBValidKey>;
    }).then(() => undefined);
  });
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}

export async function getBenchmarkRun(id: string): Promise<RepositoryResult<BenchmarkRun | null>> {
  const result = await withStores<BenchmarkRun | undefined>(RUNS_STORE, 'readonly', (tx, trackRequest) => {
    const store = tx.objectStore(RUNS_STORE);
    return requestAsPromise(store.get(id) as IDBRequest<BenchmarkRun | undefined>, trackRequest);
  });
  if (!result.ok) return failResult(result.error!);
  if (result.value === undefined) return okResult(null);
  if (!isBenchmarkRun(result.value, { allowDuplicateAliases: true })) return failResult(`stored benchmark run "${id}" failed validation`);
  return okResult(result.value);
}

export async function listBenchmarkRunsForSuite(suiteId: string): Promise<RepositoryResult<BenchmarkRun[]>> {
  const result = await withStores<BenchmarkRun[]>(RUNS_STORE, 'readonly', (tx, trackRequest) => {
    const index = tx.objectStore(RUNS_STORE).index(RUNS_BY_SUITE_INDEX);
    return requestAsPromise(index.getAll(suiteId) as IDBRequest<BenchmarkRun[]>, trackRequest);
  });
  if (!result.ok) return failResult(result.error!);
  const rows = result.value ?? [];
  const invalidIndex = rows.findIndex((row) => !isBenchmarkRun(row, { allowDuplicateAliases: true }));
  if (invalidIndex !== -1) return failResult(`stored benchmark run at index ${invalidIndex} failed validation`);
  return okResult(rows);
}

/** Updates only a run's status/timestamps — never its embedded suite snapshot, which is
 * write-once at creation. `patch` fields are merged onto the existing stored row so a caller
 * setting `status` does not have to re-supply fields it did not change. */
export async function updateBenchmarkRunStatus(
  id: string,
  status: RunStatus,
  patch: Partial<Pick<BenchmarkRun, 'startedAt' | 'finalizedAt'>> = {},
): Promise<RepositoryResult<void>> {
  const result = await withStores<void>(RUNS_STORE, 'readwrite', (tx, trackRequest) => {
    const store = tx.objectStore(RUNS_STORE);
    const getRequest = store.get(id) as IDBRequest<BenchmarkRun | undefined>;
    return chainFromSuccess(getRequest, trackRequest, (existing) => {
      if (existing === undefined) throw new Error(`no benchmark run "${id}" to update`);
      // This re-persists the existing (write-once) suite snapshot unchanged, so a legacy
      // duplicate-alias shape here is being carried forward, not newly authored — tolerate it.
      if (!isBenchmarkRun(existing, { allowDuplicateAliases: true })) throw new Error(`stored benchmark run "${id}" failed validation`);
      const updated: BenchmarkRun = { ...existing, ...patch, status };
      return store.put(updated) as IDBRequest<IDBValidKey>;
    }).then(() => undefined);
  });
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}

/** Write-ahead intent: durably records that `attempt` (status `'dispatched'`) is about to be
 * sent, *before* the chat call is made. If this write itself fails, the caller must not make
 * the chat call at all — an intent that was never recorded cannot later be told apart from one
 * that succeeded silently. */
export async function recordAttemptDispatched(attempt: BenchmarkAttempt): Promise<RepositoryResult<void>> {
  if (attempt.status !== 'dispatched') return failResult('recordAttemptDispatched requires status "dispatched"');
  if (!isBenchmarkAttempt(attempt)) return failResult('attempt failed shape validation');
  const result = await withStores<void>([ATTEMPTS_STORE, ATTEMPT_SUMMARIES_STORE], 'readwrite', (tx, trackRequest) => {
    const addAttempt = tx.objectStore(ATTEMPTS_STORE).add(attempt) as IDBRequest<IDBValidKey>;
    return chainFromSuccess(addAttempt, trackRequest, () => (
      tx.objectStore(ATTEMPT_SUMMARIES_STORE).put(summarizeAttempt(attempt)) as IDBRequest<IDBValidKey>
    )).then(() => undefined);
  });
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}

/** Terminal commit: merges a success/failure outcome onto an already-dispatched attempt row.
 * Reads the existing row and writes the merged one in the same transaction so a concurrent
 * read never observes a half-updated attempt. If this write fails, the attempt stays
 * `dispatched` (uncertain) forever — by design; the caller (the runner) must treat that as
 * fatal to the run rather than retrying silently or misreporting the outcome. */
export async function recordAttemptTerminal(
  id: string,
  patch: Omit<Partial<BenchmarkAttempt>, 'id' | 'runId' | 'logicalAttemptId' | 'sequence'> & {
    status: 'succeeded' | 'failed';
    settledAt: number;
  },
): Promise<RepositoryResult<void>> {
  const result = await withStores<void>([ATTEMPTS_STORE, ATTEMPT_SUMMARIES_STORE], 'readwrite', (tx, trackRequest) => {
    const store = tx.objectStore(ATTEMPTS_STORE);
    const getRequest = store.get(id) as IDBRequest<BenchmarkAttempt | undefined>;
    trackRequest(getRequest);
    return new Promise<void>((resolve, reject) => {
      getRequest.onsuccess = () => {
        try {
          const existing = getRequest.result;
          if (existing === undefined) throw new Error(`no benchmark attempt "${id}" to update`);
          if (existing.status !== 'dispatched') {
            throw new Error(`benchmark attempt "${id}" is already terminal (status "${existing.status}"); refusing to overwrite`);
          }
          const updated: BenchmarkAttempt = { ...existing, ...patch };
          if (!isBenchmarkAttempt(updated)) throw new Error(`updated benchmark attempt "${id}" failed validation`);
          const putAttempt = store.put(updated) as IDBRequest<IDBValidKey>;
          trackRequest(putAttempt);
          putAttempt.onsuccess = () => {
            const putSummary = tx.objectStore(ATTEMPT_SUMMARIES_STORE).put(summarizeAttempt(updated)) as IDBRequest<IDBValidKey>;
            trackRequest(putSummary);
            putSummary.onsuccess = () => resolve();
          };
        } catch (e) {
          reject(e);
        }
      };
    });
  });
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}

export async function listAttemptsForRun(runId: string): Promise<RepositoryResult<BenchmarkAttempt[]>> {
  const result = await withStores<BenchmarkAttempt[]>(ATTEMPTS_STORE, 'readonly', (tx, trackRequest) => {
    const index = tx.objectStore(ATTEMPTS_STORE).index(ATTEMPTS_BY_RUN_INDEX);
    return requestAsPromise(index.getAll(runId) as IDBRequest<BenchmarkAttempt[]>, trackRequest);
  });
  if (!result.ok) return failResult(result.error!);
  const rows = result.value ?? [];
  const invalidIndex = rows.findIndex((row) => !isBenchmarkAttempt(row));
  if (invalidIndex !== -1) return failResult(`stored benchmark attempt at index ${invalidIndex} failed validation`);
  return okResult(rows);
}

/**
 * Lightweight projection of a run's attempts (no `responseText`/`usage`/`errorMessage`) for a
 * live-polling progress view. Reads the dedicated `attemptSummaries` store so a 1.5s poll never
 * structured-clones full response bodies.
 */
export async function listAttemptSummariesForRun(runId: string): Promise<RepositoryResult<AttemptSummary[]>> {
  const result = await withStores<AttemptSummary[]>(ATTEMPT_SUMMARIES_STORE, 'readonly', (tx, trackRequest) => {
    const index = tx.objectStore(ATTEMPT_SUMMARIES_STORE).index(ATTEMPT_SUMMARIES_BY_RUN_INDEX);
    return requestAsPromise(index.getAll(runId) as IDBRequest<AttemptSummary[]>, trackRequest);
  });
  if (!result.ok) return failResult(result.error!);
  return okResult(result.value ?? []);
}

/** The uncertain set for a run: attempts still `dispatched` (no terminal row exists for that
 * execution). Uses the compound `byRunStatus` index so this never scans a whole run's history
 * just to find what still needs attention. */
export async function listDispatchedAttemptsForRun(runId: string): Promise<RepositoryResult<BenchmarkAttempt[]>> {
  const result = await withStores<BenchmarkAttempt[]>(ATTEMPTS_STORE, 'readonly', (tx, trackRequest) => {
    const index = tx.objectStore(ATTEMPTS_STORE).index(ATTEMPTS_BY_RUN_STATUS_INDEX);
    const range = IDBKeyRange.only([runId, 'dispatched']);
    return requestAsPromise(index.getAll(range) as IDBRequest<BenchmarkAttempt[]>, trackRequest);
  });
  if (!result.ok) return failResult(result.error!);
  const rows = result.value ?? [];
  const invalidIndex = rows.findIndex((row) => !isBenchmarkAttempt(row));
  if (invalidIndex !== -1) return failResult(`stored benchmark attempt at index ${invalidIndex} failed validation`);
  return okResult(rows);
}
