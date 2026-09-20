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

import { isBenchmarkSuite, type BenchmarkSuite } from './benchmark-suite';

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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      reject(new Error(describeDomException(request.error, 'Could not open the benchmark database')));
    };
    request.onblocked = () => {
      reject(new Error('The benchmark database is blocked by another open connection'));
    };
  });
}

/** Runs `body` against a store inside a transaction, resolving only when the transaction
 * itself completes (not merely when the request inside it succeeds) — a request can succeed
 * and the surrounding transaction can still fail or be aborted afterward. */
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
      let requestResult: T | undefined;
      const tx = db.transaction(SUITES_STORE, mode);
      const store = tx.objectStore(SUITES_STORE);
      let request: IDBRequest<T> | void;
      try {
        request = body(store);
      } catch (e) {
        settled = true;
        resolve(failResult(describeDomException(e, 'Benchmark database request failed')));
        return;
      }
      if (request) {
        request.onsuccess = () => { requestResult = request!.result; };
        request.onerror = () => {
          if (settled) return;
          settled = true;
          resolve(failResult(describeDomException(request!.error, 'Benchmark database request failed')));
        };
      }
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(okResult(requestResult));
      };
      tx.onerror = () => {
        if (settled) return;
        settled = true;
        resolve(failResult(describeDomException(tx.error, 'Benchmark database transaction failed')));
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        resolve(failResult(describeDomException(tx.error, 'Benchmark database transaction was aborted')));
      };
    });
  } finally {
    db.close();
  }
}

/** Suites that fail shape validation are silently excluded rather than surfaced as an error —
 * they are defense against future schema drift, not something this session wrote, so there is
 * nothing actionable for a caller to do about one bad row among otherwise-valid suites. */
export async function listBenchmarkSuites(): Promise<RepositoryResult<BenchmarkSuite[]>> {
  const result = await withStore<BenchmarkSuite[]>('readonly', (store) => store.getAll() as IDBRequest<BenchmarkSuite[]>);
  if (!result.ok) return failResult(result.error!);
  const rows = (result.value ?? []).filter(isBenchmarkSuite);
  return okResult(rows);
}

export async function getBenchmarkSuite(id: string): Promise<RepositoryResult<BenchmarkSuite | null>> {
  const result = await withStore<BenchmarkSuite>('readonly', (store) => store.get(id) as IDBRequest<BenchmarkSuite>);
  if (!result.ok) return failResult(result.error!);
  if (result.value === undefined) return okResult(null);
  if (!isBenchmarkSuite(result.value)) return okResult(null);
  return okResult(result.value);
}

/** Upserts a suite, keyed by `suite.id`. Resolves only once the write transaction has
 * genuinely committed — never merely queued. */
export async function putBenchmarkSuite(suite: BenchmarkSuite): Promise<RepositoryResult<void>> {
  const result = await withStore<IDBValidKey>('readwrite', (store) => store.put(suite));
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}

export async function deleteBenchmarkSuite(id: string): Promise<RepositoryResult<void>> {
  const result = await withStore<undefined>('readwrite', (store) => store.delete(id));
  if (!result.ok) return failResult(result.error!);
  return okResult(undefined);
}
