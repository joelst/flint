import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStopController,
  prepareBenchmarkRun,
  resumeBenchmarkRun,
  startBenchmarkRun,
  type AttemptTransport,
  type AttemptTransportResult,
} from './benchmark-runner';
import { getBenchmarkRun, listAttemptsForRun, listBenchmarkRunsForSuite, openBenchmarkDatabase, putBenchmarkSuite } from './benchmark-repository';
import type { BenchmarkSuite } from './benchmark-suite';

function suite(over: Partial<BenchmarkSuite> = {}): BenchmarkSuite {
  return {
    id: 'suite-1',
    name: 'Arithmetic',
    createdAt: 1700000000000,
    targets: [{ alias: 'model-a', variantId: null }],
    cases: [
      { id: 'c1', prompt: 'What is 2+2?' },
      { id: 'c2', prompt: 'What is 3+3?' },
    ],
    warmupCount: 1,
    repeatCount: 1,
    ...over,
  };
}

/** A transport that always succeeds, echoing a fixed response. */
function succeedingTransport(): AttemptTransport {
  return async () => ({ ok: true, responseText: 'four' });
}

/** Persist the suite under test before starting: createBenchmarkRun refuses a snapshot that
 * no longer matches the stored row (the same check that rejects a concurrent editor save). */
async function startStored(
  s: BenchmarkSuite,
  transport: AttemptTransport,
  stopController?: ReturnType<typeof createStopController>,
) {
  const put = await putBenchmarkSuite(s);
  expect(put.ok).toBe(true);
  return startBenchmarkRun(s, transport, stopController);
}

/** A transport whose per-call outcome is driven by a queue, so tests can script exact
 * success/failure sequences (e.g. "the second call fails, everything else succeeds"). */
function scriptedTransport(results: AttemptTransportResult[]): { transport: AttemptTransport; calls: number } {
  const state = { calls: 0 };
  const transport: AttemptTransport = async () => {
    const result = results[state.calls] ?? results[results.length - 1];
    state.calls++;
    return result;
  };
  return { transport, calls: 0 };
}

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
  await putBenchmarkSuite(suite());
});

afterEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});

describe('startBenchmarkRun', () => {
  it('dispatches every logical position in order and records a completed run', async () => {
    const s = suite();
    const outcome = await startStored(s, succeedingTransport());
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ status: 'completed' });

    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.ok).toBe(true);
    // 1 warm-up + 2 cases * 1 repeat = 3 attempts for the single target.
    expect(attempts.value).toHaveLength(3);
    expect(attempts.value!.every((a) => a.status === 'succeeded')).toBe(true);
  });

  it('accepts a semantically-identical but differently-formatted suite instead of rejecting it as a stale snapshot', async () => {
    // The stored row (via putBenchmarkSuite) is normalized: trimmed strings, deduped tags.
    // A caller's own in-memory suite object need not be byte-identical to what was normalized
    // on write -- e.g. surrounding whitespace on an alias/prompt -- to be the same suite.
    const s = suite();
    const put = await putBenchmarkSuite(s);
    expect(put.ok).toBe(true);
    const padded: BenchmarkSuite = {
      ...s,
      name: `  ${s.name}  `,
      targets: s.targets.map((t) => ({ ...t, alias: `  ${t.alias}  ` })),
      cases: s.cases.map((c) => ({ ...c, prompt: c.prompt ? `  ${c.prompt}  ` : c.prompt })),
    };
    const outcome = await startBenchmarkRun(padded, succeedingTransport());
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ status: 'completed' });
  });

  it('rejects an explicitly-passed preparedRun whose in-memory suite was tampered after prepare, instead of scheduling it unchecked', async () => {
    // `startBenchmarkRun` is exported and callable directly, not only via `startBenchmarkSession`
    // (which always builds `preparedRun` through `prepareBenchmarkRun`) -- a directly-supplied
    // `preparedRun` must not bypass validation just because it looks pre-validated. The run is
    // re-read from storage and this tampered copy disagrees with what was actually reserved.
    const s = suite();
    const prepared = await prepareBenchmarkRun(s);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('unreachable');
    const tamperedRun = {
      ...prepared.run,
      suite: { ...prepared.run.suite, targets: [{ alias: 'model-b', variantId: null }] },
    };
    const outcome = await startBenchmarkRun(s, succeedingTransport(), undefined, tamperedRun);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/does not match/);
  });

  it('rejects an explicitly-passed preparedRun whose id has no reservation in storage', async () => {
    const s = suite();
    const prepared = await prepareBenchmarkRun(s);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('unreachable');
    const unpersistedRun = { ...prepared.run, id: 'never-persisted' };
    let called = false;
    const outcome = await startBenchmarkRun(s, async () => {
      called = true;
      return { ok: true, responseText: 'x' };
    }, undefined, unpersistedRun);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no reservation found in storage/);
    expect(called).toBe(false);
  });

  it('rejects an explicitly-passed preparedRun whose stored reservation is a legacy duplicate-alias run', async () => {
    // A tampered/forged `preparedRun.id` could point at a real, pre-1.0 stored row this rule
    // would reject if it were ever (re-)created — execution must still refuse it, not just
    // shape-check the caller's in-memory object and let a legacy row's alias-order transport
    // dispatch run.
    const legacySuite = suite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
      ],
    });
    const db = await openBenchmarkDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('runs', 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
        tx.objectStore('runs').put({
          id: 'legacy-dup-alias-start',
          suiteId: 'suite-1',
          suite: legacySuite,
          createdAt: Date.now(),
          status: 'running',
        });
      });
    } finally {
      db.close();
    }
    let called = false;
    const outcome = await startBenchmarkRun(
      legacySuite,
      async () => { called = true; return { ok: true, responseText: 'x' }; },
      undefined,
      { id: 'legacy-dup-alias-start', suiteId: 'suite-1', suite: legacySuite, createdAt: Date.now(), status: 'running' },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/duplicate target aliases/);
    expect(called).toBe(false);
  });

  it('rejects an explicitly-passed preparedRun whose stored reservation already has recorded attempts', async () => {
    // This branch always executes with an empty prior-attempts list. A reservation that already
    // has attempt rows (already started, resumed, or completed by someone else) must not be
    // re-dispatched from scratch through this path -- that would duplicate real inference calls
    // against positions that already have a terminal outcome recorded.
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const putSuite = await putBenchmarkSuite(s);
    expect(putSuite.ok).toBe(true);
    const prepared = await prepareBenchmarkRun(s);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('unreachable');
    // Run it to completion once, recording a real attempt against this same reservation.
    const first = await startBenchmarkRun(s, succeedingTransport(), undefined, prepared.run);
    expect(first.ok).toBe(true);
    let called = false;
    const outcome = await startBenchmarkRun(s, async () => {
      called = true;
      return { ok: true, responseText: 'x' };
    }, undefined, prepared.run);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/already has recorded attempts/);
    expect(called).toBe(false);
  });

  it('rejects an explicitly-passed preparedRun whose reservation was stopped before its first dispatch', async () => {
    // A run stopped before its very first dispatch has zero attempt rows -- the same as a
    // never-touched reservation -- but its persisted status is `stopped`, not `running`. The
    // "zero attempts" check alone would let this path re-execute it from scratch, dispatching
    // real inference while the stored row stays `stopped` until finalization, and bypassing the
    // required Resume path entirely. Only a reservation still recorded as `running` may go
    // through this from-scratch path.
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const putSuite = await putBenchmarkSuite(s);
    expect(putSuite.ok).toBe(true);
    const prepared = await prepareBenchmarkRun(s);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('unreachable');
    const preStoppedController = createStopController();
    preStoppedController.stop();
    let firstCalled = false;
    const first = await startBenchmarkRun(s, async () => {
      firstCalled = true;
      return { ok: true, responseText: 'x' };
    }, preStoppedController, prepared.run);
    expect(first.ok).toBe(true);
    expect(first.result?.status).toBe('stopped');
    expect(firstCalled).toBe(false);
    const attempts = await listAttemptsForRun(prepared.run.id);
    expect(attempts.value).toHaveLength(0);
    const stored = await getBenchmarkRun(prepared.run.id);
    expect(stored.value!.status).toBe('stopped');

    let secondCalled = false;
    const outcome = await startBenchmarkRun(s, async () => {
      secondCalled = true;
      return { ok: true, responseText: 'x' };
    }, undefined, prepared.run);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/not in a fresh running state/);
    expect(secondCalled).toBe(false);
  });

  it('rejects an explicitly-passed preparedRun with a structurally invalid suite without throwing', async () => {
    const s = suite();
    const putSuite = await putBenchmarkSuite(s);
    expect(putSuite.ok).toBe(true);
    const prepared = await prepareBenchmarkRun(s);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('unreachable');
    const malformedRun = { ...prepared.run, suite: null as unknown as BenchmarkSuite };
    let called = false;
    const outcome = await startBenchmarkRun(s, async () => {
      called = true;
      return { ok: true, responseText: 'x' };
    }, undefined, malformedRun);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/duplicate target aliases/);
    expect(called).toBe(false);
  });

  it('returns a run snapshot reflecting the status executePositions actually committed, not the stale pre-execution one', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const outcome = await startStored(s, succeedingTransport());
    expect(outcome.result).toEqual({ status: 'completed' });
    // The returned run must agree with what's durably persisted -- not silently still read
    // 'running', which is what the caller passed into executePositions before it settled.
    expect(outcome.run!.status).toBe('completed');
    expect(outcome.run!.finalizedAt).toEqual(expect.any(Number));

    const stored = await getBenchmarkRun(outcome.run!.id);
    expect(stored.value!.status).toBe('completed');
    expect(outcome.run).toEqual(stored.value);
  });

  it('returns a stopped run snapshot when Stop halts execution mid-schedule', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }, { id: 'c2', prompt: 'y' }] });
    const stopController = createStopController();
    const transport: AttemptTransport = async () => {
      stopController.stop();
      return { ok: true, responseText: 'ok' };
    };
    const outcome = await startStored(s, transport, stopController);
    expect(outcome.result?.status).toBe('stopped');
    expect(outcome.run!.status).toBe('stopped');
  });

  it('halts as stopped without recording a failed attempt when the transport reports haltRun', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }, { id: 'c2', prompt: 'y' }] });
    const transport: AttemptTransport = async () => ({
      ok: false,
      errorMessage: 'Runtime is draining',
      haltRun: 'stopped',
    });
    const outcome = await startStored(s, transport);
    expect(outcome.result?.status).toBe('stopped');
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value).toHaveLength(1);
    expect(attempts.value![0].status).toBe('dispatched');
  });

  it('freezes a snapshot of the suite at call time, immune to later mutation of the caller\'s object', async () => {
    const s = suite();
    const outcome = await startStored(s, succeedingTransport());
    // Mutate the caller's own suite object after the call returns (but the schedule/persistence
    // already used a snapshot taken before the first await) — this must never be reflected.
    s.cases[0].prompt = 'MUTATED';
    s.targets[0].alias = 'mutated-model';
    const runs = await listBenchmarkRunsForSuite(s.id);
    expect(runs.value).toHaveLength(1);
    expect(runs.value![0].suite.cases[0].prompt).toBe('What is 2+2?');
    expect(runs.value![0].suite.targets[0].alias).toBe('model-a');
    expect(outcome.run!.suite.cases[0].prompt).toBe('What is 2+2?');
  });

  it('records a failed attempt without halting the run when the transport reports failure', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const { transport } = scriptedTransport([{ ok: false, errorMessage: 'model unavailable' }]);
    const outcome = await startStored(s, transport);
    expect(outcome.result).toEqual({ status: 'completed' });
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value).toEqual([
      expect.objectContaining({ status: 'failed', errorMessage: 'model unavailable' }),
    ]);
  });

  it('a warm-up failure does not block that target\'s measured attempts', async () => {
    const s = suite({ warmupCount: 1, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const { transport } = scriptedTransport([
      { ok: false, errorMessage: 'warmup failed' },
      { ok: true, responseText: 'measured ok' },
    ]);
    const outcome = await startStored(s, transport);
    expect(outcome.result).toEqual({ status: 'completed' });
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value!.find((a) => a.phase === 'warmup')?.status).toBe('failed');
    expect(attempts.value!.find((a) => a.phase === 'measured')?.status).toBe('succeeded');
  });

  it('a transport that throws is recorded as a failed attempt, not an unhandled rejection', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const transport: AttemptTransport = async () => { throw new Error('network exploded'); };
    const outcome = await startStored(s, transport);
    expect(outcome.result).toEqual({ status: 'completed' });
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value).toEqual([
      expect.objectContaining({ status: 'failed', errorMessage: 'network exploded' }),
    ]);
  });

  // --- Proof gate: write-ahead ordering -------------------------------------------------
  it('proof gate: the dispatch intent is durably recorded before the transport is ever called', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    let checkedInsideTransport = false;
    await startStored(s, async () => {
      // The run row (and thus its id) is only knowable from inside the transport call itself —
      // look it up by suite id rather than depending on `startBenchmarkRun`'s return value,
      // which does not exist yet at this point in the call.
      const runs = await listBenchmarkRunsForSuite(s.id);
      expect(runs.ok).toBe(true);
      expect(runs.value).toHaveLength(1);
      const attempts = await listAttemptsForRun(runs.value![0].id);
      expect(attempts.ok).toBe(true);
      expect(attempts.value).toHaveLength(1);
      expect(attempts.value![0].status).toBe('dispatched');
      checkedInsideTransport = true;
      return { ok: true, responseText: 'ok' };
    });
    expect(checkedInsideTransport).toBe(true);
  });

  // --- Proof gate: terminal-write failure halts the run ------------------------------------
  it('proof gate: a terminal-write failure halts the run and leaves the attempt uncertain (dispatched)', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }, { id: 'c2', prompt: 'y' }] });
    const repo = await import('./benchmark-repository');
    const spy = vi.spyOn(repo, 'recordAttemptTerminal').mockResolvedValueOnce({ ok: false, error: 'disk full' });
    const outcome = await startStored(s, succeedingTransport());
    spy.mockRestore();

    expect(outcome.result?.status).toBe('recovery_required');
    expect(outcome.result?.haltedError).toMatch(/disk full/);

    const attempts = await listAttemptsForRun(outcome.run!.id);
    // Only the first position was attempted; the second case was never dispatched.
    expect(attempts.value).toHaveLength(1);
    expect(attempts.value![0].status).toBe('dispatched');

    const runs = await listBenchmarkRunsForSuite(s.id);
    expect(runs.value![0].status).toBe('recovery_required');
  });

  it('an intent-write failure halts the run before the transport is ever called', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const repo = await import('./benchmark-repository');
    const spy = vi.spyOn(repo, 'recordAttemptDispatched').mockResolvedValueOnce({ ok: false, error: 'quota exceeded' });
    let transportCalled = false;
    const outcome = await startStored(s, async () => { transportCalled = true; return { ok: true, responseText: 'x' }; });
    spy.mockRestore();

    expect(transportCalled).toBe(false);
    expect(outcome.result?.status).toBe('recovery_required');
    expect(outcome.result?.haltedError).toMatch(/quota exceeded/);
  });

  it('proof gate: Stop landing between intent-commit and the transport call leaves the attempt dispatched (uncertain) and never calls the transport', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const stopController = createStopController();
    const repo = await import('./benchmark-repository');
    const original = repo.recordAttemptDispatched;
    const spy = vi.spyOn(repo, 'recordAttemptDispatched').mockImplementation(async (attempt) => {
      const result = await original(attempt);
      // Simulate an operator clicking Stop in the narrow window right after the intent commits
      // but before the transport call is made — the runner's second admission check must catch it.
      stopController.stop();
      return result;
    });
    let transportCalled = false;
    const outcome = await startStored(s, async () => { transportCalled = true; return { ok: true, responseText: 'x' }; }, stopController);
    spy.mockRestore();

    expect(transportCalled).toBe(false);
    expect(outcome.result?.status).toBe('stopped');
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value).toHaveLength(1);
    expect(attempts.value![0].status).toBe('dispatched');
  });

  it('records the transport\'s own message when it throws a non-Error value', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const transport: AttemptTransport = async () => { throw 'a bare string throw'; };
    const outcome = await startStored(s, transport);
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value![0]).toEqual(expect.objectContaining({ status: 'failed', errorMessage: 'Benchmark transport failed' }));
  });

  it('an empty successful response text is recorded as a genuine success, not a recovery failure', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const transport: AttemptTransport = async () => ({ ok: true, responseText: '' });
    const outcome = await startStored(s, transport);
    expect(outcome.result).toEqual({ status: 'completed' });
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value![0]).toEqual(expect.objectContaining({ status: 'succeeded', responseText: '' }));
  });

  it('falls back to a non-crypto id generator when crypto.randomUUID is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);
    try {
      const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
      const outcome = await startStored(s, succeedingTransport());
      expect(outcome.ok).toBe(true);
      expect(outcome.run!.id).toMatch(/^run_/);
      const attempts = await listAttemptsForRun(outcome.run!.id);
      expect(attempts.value![0].id).toMatch(/^att_/);
    } finally {
      vi.stubGlobal('crypto', originalCrypto);
    }
  });

  it('proof gate: a failed status write never lets the run report a status that was not durably committed', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const repo = await import('./benchmark-repository');
    const spy = vi.spyOn(repo, 'updateBenchmarkRunStatus').mockResolvedValueOnce({ ok: false, error: 'store closed' });
    const outcome = await startStored(s, succeedingTransport());
    spy.mockRestore();

    // The runner wanted to report 'completed', but since that status write itself failed, it
    // must downgrade to the more conservative 'recovery_required' rather than claim a status
    // IndexedDB never actually recorded.
    expect(outcome.result?.status).toBe('recovery_required');
    expect(outcome.result?.haltedError).toMatch(/store closed/);
    // The returned run must reflect what storage actually has -- still 'running', since the
    // status write itself never landed -- not a claimed 'completed'/'recovery_required' the
    // repository never committed. Verify against storage directly, not just the returned value.
    expect(outcome.run!.status).toBe('running');
    const stored = await getBenchmarkRun(outcome.run!.id);
    expect(stored.value!.status).toBe('running');
    expect(outcome.run).toEqual(stored.value);
  });

  // --- Stop semantics -----------------------------------------------------------------------
  it('Stop checked before dispatch prevents any further attempts from starting', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }, { id: 'c2', prompt: 'y' }] });
    const stopController = createStopController();
    let calls = 0;
    const transport: AttemptTransport = async () => {
      calls++;
      stopController.stop(); // simulate a Stop request arriving mid-run
      return { ok: true, responseText: 'ok' };
    };
    const outcome = await startStored(s, transport, stopController);
    expect(outcome.result?.status).toBe('stopped');
    expect(calls).toBe(1); // second position never dispatched
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value).toHaveLength(1);
    expect(attempts.value![0].status).toBe('succeeded');

    const runs = await listBenchmarkRunsForSuite(s.id);
    expect(runs.value![0].status).toBe('stopped');
  });

  it('Stop requested between intent-commit and transport-call leaves that attempt dispatched (uncertain), never calling the transport', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const stopController = createStopController();
    stopController.stop(); // already stopped before the run starts
    let transportCalled = false;
    const outcome = await startStored(s, async () => { transportCalled = true; return { ok: true, responseText: 'x' }; }, stopController);
    expect(outcome.result?.status).toBe('stopped');
    expect(transportCalled).toBe(false);
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value).toHaveLength(0);
  });
});

describe('resumeBenchmarkRun', () => {
  it('re-attempts only positions with no terminal execution, leaving settled ones untouched', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }, { id: 'c2', prompt: 'y' }] });
    const stopController = createStopController();
    // Stop lands after the first position's transport call settles — the loop then checks
    // Stop before the second position's intent is even written, so it is never dispatched.
    const transport: AttemptTransport = async () => {
      stopController.stop();
      return { ok: true, responseText: 'first succeeded' };
    };
    const started = await startStored(s, transport, stopController);
    expect(started.result?.status).toBe('stopped');
    const afterFirstRun = await listAttemptsForRun(started.run!.id);
    expect(afterFirstRun.value).toHaveLength(1);
    expect(afterFirstRun.value![0].status).toBe('succeeded');

    const resumed = await resumeBenchmarkRun(started.run!.id, succeedingTransport());
    expect(resumed.result).toEqual({ status: 'completed' });

    const finalAttempts = await listAttemptsForRun(started.run!.id);
    expect(finalAttempts.value).toHaveLength(2);
    // The original succeeded attempt is untouched (still sequence 0, same response).
    const original = finalAttempts.value!.find((a) => a.responseText === 'first succeeded');
    expect(original?.sequence).toBe(0);
  });

  it('resuming re-dispatches an uncertain (dispatched-only) position as a brand-new execution, never editing the original row', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const stopController = createStopController();
    stopController.stop();
    const started = await startStored(s, succeedingTransport(), stopController);
    // Nothing dispatched yet since Stop was already set before the run started; simulate an
    // uncertain attempt directly to exercise the "was dispatched, crash before terminal" case.
    const repo = await import('./benchmark-repository');
    await repo.recordAttemptDispatched({
      id: 'crashed-exec',
      runId: started.run!.id,
      logicalAttemptId: 't0:c0:r0',
      targetIndex: 0,
      phase: 'measured',
      caseIndex: 0,
      repeatIndex: 0,
      sequence: 0,
      status: 'dispatched',
      alias: 'model-a',
      requestedVariantId: null,
      intentCommittedAt: 1,
    });

    const resumed = await resumeBenchmarkRun(started.run!.id, succeedingTransport());
    expect(resumed.result).toEqual({ status: 'completed' });
    // Resume's returned run snapshot must also reflect the committed terminal status, not the
    // stale 'stopped' one the run had going into this resume call.
    expect(resumed.run!.status).toBe('completed');

    const attempts = await listAttemptsForRun(started.run!.id);
    expect(attempts.value).toHaveLength(2);
    const crashed = attempts.value!.find((a) => a.id === 'crashed-exec');
    expect(crashed?.status).toBe('dispatched'); // untouched — never silently rewritten
    const retry = attempts.value!.find((a) => a.id !== 'crashed-exec');
    expect(retry?.sequence).toBe(1);
    expect(retry?.status).toBe('succeeded');
  });

  it('resuming a run with nothing pending marks it completed without calling the transport', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const started = await startStored(s, succeedingTransport());
    let called = false;
    const resumed = await resumeBenchmarkRun(started.run!.id, async () => { called = true; return { ok: true, responseText: 'x' }; });
    expect(resumed.result).toEqual({ status: 'completed' });
    expect(resumed.run!.status).toBe('completed');
    expect(called).toBe(false);
  });

  it('resuming a run with no recorded startedAt uses a single timestamp for both the persisted patch and the returned snapshot', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const repo = await import('./benchmark-repository');
    const runId = 'run-no-started-at';
    expect((await repo.putBenchmarkSuite(s)).ok).toBe(true);
    // Simulate a run row that was created without startedAt (e.g. an older schema or a
    // never-actually-started row) to exercise the `run.startedAt ?? Date.now()` fallback.
    await repo.createBenchmarkRun({
      id: runId,
      suiteId: s.id,
      suite: s,
      createdAt: Date.now(),
      status: 'stopped',
    });

    const resumed = await resumeBenchmarkRun(runId, succeedingTransport());
    expect(resumed.ok).toBe(true);
    expect(resumed.run!.startedAt).toBeDefined();
    const stored = await getBenchmarkRun(runId);
    // The timestamp written to storage and the one in the returned snapshot must be the exact
    // same value -- not two separate Date.now() calls that could disagree by a few ms.
    expect(resumed.run!.startedAt).toBe(stored.value!.startedAt);
  });

  it('fails cleanly when resuming a run id that does not exist', async () => {
    const resumed = await resumeBenchmarkRun('missing', succeedingTransport());
    expect(resumed.ok).toBe(false);
  });

  it('rejects resume of a legacy same-alias/different-variant run and never calls the transport', async () => {
    const legacySuite = suite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
      ],
    });
    const db = await openBenchmarkDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('runs', 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
        tx.objectStore('runs').put({
          id: 'legacy-dup-alias',
          suiteId: 'suite-1',
          suite: legacySuite,
          createdAt: Date.now(),
          status: 'stopped',
        });
      });
    } finally {
      db.close();
    }

    let called = false;
    const resumed = await resumeBenchmarkRun('legacy-dup-alias', async () => {
      called = true;
      return { ok: true, responseText: 'x' };
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/cannot be resumed: its suite snapshot has duplicate target aliases/);
    expect(called).toBe(false);
  });

  it('proof gate: rejects a second concurrent resume of the same run id instead of duplicating dispatches', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const stopController = createStopController();
    stopController.stop();
    const started = await startStored(s, succeedingTransport(), stopController);
    expect(started.result?.status).toBe('stopped');

    let releaseFirstCall: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirstCall = resolve; });
    let firstCallCount = 0;
    const firstTransport: AttemptTransport = async () => {
      firstCallCount++;
      await gate; // hold the first resume's execution open so the second can race it
      return { ok: true, responseText: 'first' };
    };

    const firstResume = resumeBenchmarkRun(started.run!.id, firstTransport);
    // Give the first resume's synchronous guard-acquisition a turn to run before racing it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondResume = await resumeBenchmarkRun(started.run!.id, succeedingTransport());

    expect(secondResume.ok).toBe(false);
    expect(secondResume.error).toMatch(/already has an execution in progress/);

    releaseFirstCall();
    const firstResult = await firstResume;
    expect(firstResult.result).toEqual({ status: 'completed' });
    expect(firstCallCount).toBe(1);

    // Exactly one execution was ever recorded for the logical position — no duplicate dispatch.
    const attempts = await listAttemptsForRun(started.run!.id);
    expect(attempts.value).toHaveLength(1);
  });
});
