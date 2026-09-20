import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStopController,
  resumeBenchmarkRun,
  startBenchmarkRun,
  type AttemptTransport,
  type AttemptTransportResult,
} from './benchmark-runner';
import { listAttemptsForRun, listBenchmarkRunsForSuite } from './benchmark-repository';
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
});

afterEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});

describe('startBenchmarkRun', () => {
  it('dispatches every logical position in order and records a completed run', async () => {
    const s = suite();
    const outcome = await startBenchmarkRun(s, succeedingTransport());
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ status: 'completed' });

    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.ok).toBe(true);
    // 1 warm-up + 2 cases * 1 repeat = 3 attempts for the single target.
    expect(attempts.value).toHaveLength(3);
    expect(attempts.value!.every((a) => a.status === 'succeeded')).toBe(true);
  });

  it('freezes a snapshot of the suite at call time, immune to later mutation of the caller\'s object', async () => {
    const s = suite();
    const outcome = await startBenchmarkRun(s, succeedingTransport());
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
    const outcome = await startBenchmarkRun(s, transport);
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
    const outcome = await startBenchmarkRun(s, transport);
    expect(outcome.result).toEqual({ status: 'completed' });
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value!.find((a) => a.phase === 'warmup')?.status).toBe('failed');
    expect(attempts.value!.find((a) => a.phase === 'measured')?.status).toBe('succeeded');
  });

  it('a transport that throws is recorded as a failed attempt, not an unhandled rejection', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const transport: AttemptTransport = async () => { throw new Error('network exploded'); };
    const outcome = await startBenchmarkRun(s, transport);
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
    await startBenchmarkRun(s, async () => {
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
    const outcome = await startBenchmarkRun(s, succeedingTransport());
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
    const outcome = await startBenchmarkRun(s, async () => { transportCalled = true; return { ok: true, responseText: 'x' }; });
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
    const outcome = await startBenchmarkRun(s, async () => { transportCalled = true; return { ok: true, responseText: 'x' }; }, stopController);
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
    const outcome = await startBenchmarkRun(s, transport);
    const attempts = await listAttemptsForRun(outcome.run!.id);
    expect(attempts.value![0]).toEqual(expect.objectContaining({ status: 'failed', errorMessage: 'Benchmark transport failed' }));
  });

  it('falls back to a non-crypto id generator when crypto.randomUUID is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);
    try {
      const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
      const outcome = await startBenchmarkRun(s, succeedingTransport());
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
    const outcome = await startBenchmarkRun(s, succeedingTransport());
    spy.mockRestore();

    // The runner wanted to report 'completed', but since that status write itself failed, it
    // must downgrade to the more conservative 'recovery_required' rather than claim a status
    // IndexedDB never actually recorded.
    expect(outcome.result?.status).toBe('recovery_required');
    expect(outcome.result?.haltedError).toMatch(/store closed/);
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
    const outcome = await startBenchmarkRun(s, transport, stopController);
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
    const outcome = await startBenchmarkRun(s, async () => { transportCalled = true; return { ok: true, responseText: 'x' }; }, stopController);
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
    const started = await startBenchmarkRun(s, transport, stopController);
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
    const started = await startBenchmarkRun(s, succeedingTransport(), stopController);
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
    const started = await startBenchmarkRun(s, succeedingTransport());
    let called = false;
    const resumed = await resumeBenchmarkRun(started.run!.id, async () => { called = true; return { ok: true, responseText: 'x' }; });
    expect(resumed.result).toEqual({ status: 'completed' });
    expect(called).toBe(false);
  });

  it('fails cleanly when resuming a run id that does not exist', async () => {
    const resumed = await resumeBenchmarkRun('missing', succeedingTransport());
    expect(resumed.ok).toBe(false);
  });

  it('proof gate: rejects a second concurrent resume of the same run id instead of duplicating dispatches', async () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const stopController = createStopController();
    stopController.stop();
    const started = await startBenchmarkRun(s, succeedingTransport(), stopController);
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
