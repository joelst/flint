/**
 * Benchmark Preview suite storage: IndexedDB, not `localStorage`.
 *
 * Quick Compare's history (`comparison-history.ts`) fits comfortably in a single localStorage
 * key because it is a small, atomically-replaced blob. A benchmark run's attempt journal will
 * not: a runner needs to checkpoint potentially hundreds of independently-completing attempts,
 * and re-serializing the whole run on every single checkpoint is the wrong write primitive for
 * that. This module commits to IndexedDB now — even though this PR only ever stores suite
 * definitions, never attempts — so a later runner PR adds object stores to an already-proven
 * transactional database rather than migrating storage backends mid-feature.
 *
 * This is intentionally the smallest possible slice of that commitment: one object store,
 * one key type, four operations. No UI reads this module yet.
 */

import { isBenchmarkSuite, validateBenchmarkSuite, type BenchmarkSuite } from './benchmark-suite';

const DATABASE_NAME = 'flint-benchmarks';
const DATABASE_VERSION = 1;
const SUITES_STORE = 'suites';

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
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/**
 * Opens (and upgrades, if needed) the benchmark database. Rejects rather than falling back to
 * any other storage — a caller that cannot open this database has no suite persistence this
 * session, and must be told that plainly rather than silently losing durability guarantees.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (e) {
      reject(new Error(describeDomException(e, 'Could not open the benchmark database')));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(SUITES_STORE, { keyPath: 'id' });
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

/** Runs `body` against a store inside a transaction, resolving only when the transaction
 * itself reaches a terminal state (`complete` or `abort`) — a request can succeed while the
 * surrounding transaction still fails or is aborted afterward, so a request's own `onsuccess`/
 * `onerror` is never itself the settling event; only the transaction's terminal event is. */
async function withStore<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<RepositoryResult<T | undefined>> {
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch (e) {
    return failResult((e as Error).message);
  }
  try {
    return await new Promise((resolve) => {
      let settled = false;
      let requestErrorMessage: string | undefined;
      const requestResultBox: { value?: T } = {};
      let tx: IDBTransaction;
      let store: IDBObjectStore;
      try {
        tx = db.transaction(SUITES_STORE, mode);
        store = tx.objectStore(SUITES_STORE);
      } catch (e) {
        resolve(failResult(describeDomException(e, 'Could not start a benchmark database transaction')));
        return;
      }
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(okResult(requestResultBox.value));
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
      let request: IDBRequest<T> | void;
      try {
        request = body(store);
      } catch (e) {
        // The synchronous throw itself does not abort the transaction, so record it and
        // explicitly abort — the handlers above (already attached) then report it.
        requestErrorMessage = describeDomException(e, 'Benchmark database request failed');
        tx.abort();
        return;
      }
      if (request) {
        request.onsuccess = () => { requestResultBox.value = request!.result; };
        request.onerror = () => {
          // Do not settle here: an unhandled request error always aborts the transaction, and
          // `onabort` above is the true terminal signal — settling here would report success
          // or failure before the transaction's own outcome is actually known.
          requestErrorMessage = describeDomException(request!.error, 'Benchmark database request failed');
        };
      }
    });
  } finally {
    db.close();
  }
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
  const invalidIndex = rows.findIndex((row) => !isBenchmarkSuite(row));
  if (invalidIndex !== -1) {
    return failResult(`stored benchmark suite at index ${invalidIndex} failed validation`);
  }
  return okResult(rows);
}

export async function getBenchmarkSuite(id: string): Promise<RepositoryResult<BenchmarkSuite | null>> {
  const result = await withStore<BenchmarkSuite>('readonly', (store) => store.get(id) as IDBRequest<BenchmarkSuite>);
  if (!result.ok) return failResult(result.error!);
  if (result.value === undefined) return okResult(null);
  if (!isBenchmarkSuite(result.value)) return failResult(`stored benchmark suite "${id}" failed validation`);
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
  const result = await withStore<undefined>('readwrite', (store) => store.delete(id));
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}
