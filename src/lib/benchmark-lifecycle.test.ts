import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SidecarOperationError } from './operation-outcome';
import {
  assertServedVariant,
  boundVariantIdForTarget,
  createSidecarBenchmarkTransport,
  haltPreparedRun,
  loadBenchmarkTargets,
  resumeBenchmarkSession,
  startBenchmarkSession,
  type BenchmarkLifecycleHost,
} from './benchmark-lifecycle';
import { createStopController, startBenchmarkRun } from './benchmark-runner';
import { getBenchmarkRun, listAttemptsForRun, listBenchmarkRunsForSuite, openBenchmarkDatabase, putBenchmarkSuite, recordAttemptDispatched } from './benchmark-repository';
import type { BenchmarkSuite } from './benchmark-suite';

function suite(over: Partial<BenchmarkSuite> = {}): BenchmarkSuite {
  return {
    id: 'suite-1',
    name: 'Arithmetic',
    createdAt: 1700000000000,
    targets: [{ alias: 'model-a', variantId: null }],
    cases: [{ id: 'c1', prompt: 'x' }],
    warmupCount: 0,
    repeatCount: 1,
    ...over,
  };
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
afterEach(resetDatabase);

async function putRawRun(run: object): Promise<void> {
  const db = await openBenchmarkDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('runs', 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      tx.objectStore('runs').put(run);
    });
  } finally {
    db.close();
  }
}

function fakeHost(over: Partial<BenchmarkLifecycleHost> & { order?: string[] } = {}): BenchmarkLifecycleHost & { order: string[] } {
  const order = over.order ?? [];
  return {
    order,
    loadModel: over.loadModel ?? (async (alias) => { order.push(`load:${alias}`); }),
    pinAliases: over.pinAliases ?? (async (aliases) => { order.push(`pin:${aliases.join(',')}`); }),
    unpin: over.unpin ?? (async () => { order.push('unpin'); }),
    chatCompletion: over.chatCompletion ?? (async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { input_tokens: 4, output_tokens: 2 },
    })),
  };
}

describe('loadBenchmarkTargets / pinThenLoad order', () => {
  it('pins before loading, and unpins if a later load fails', async () => {
    const host = fakeHost({
      loadModel: async (alias) => {
        host.order.push(`load:${alias}`);
        if (alias === 'model-b') throw new Error('oom');
      },
    });
    const s = suite({
      targets: [{ alias: 'model-a', variantId: null }, { alias: 'model-b', variantId: null }],
    });
    await putBenchmarkSuite(s);
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(true);
    const done = result.ok ? await result.execution.done : null;
    expect(done?.ok).toBe(false);
    expect(host.order[0]).toBe('pin:model-a,model-b');
    expect(host.order).toContain('load:model-a');
    expect(host.order).toContain('unpin');
  });

  it('resolves `done` even when the restore never settles, so the run does not hang there (pin failure path)', async () => {
    // Regression for a hang: `host.unpin()` ultimately sends `applyMemorySettings`, which has no
    // IPC deadline. If `pinThenLoad`/`finishPreparedHalt` awaited it directly, a sidecar that
    // stops answering would leave `done` -- and therefore the caller's exclusive-gateway
    // release gated on it -- unsettled forever. `unpin` here never resolves; `done` must still
    // settle promptly because the restore is fired-and-forgotten, not awaited.
    const host = fakeHost({
      pinAliases: async () => { throw new Error('pin failed'); },
      unpin: () => new Promise<void>(() => {}),
    });
    const s = suite({ targets: [{ alias: 'model-a', variantId: null }] });
    await putBenchmarkSuite(s);
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = await Promise.race([
      result.execution.done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('done did not settle in time')), 500)),
    ]);
    expect(outcome.ok).toBe(false);
  });

  it('aborts preparation when pin fails, regardless of whether any target has an explicit variant', async () => {
    const host = fakeHost({
      pinAliases: async () => { throw new Error('pin failed'); },
    });
    const s = suite({ targets: [{ alias: 'model-a', variantId: 'v1' }] });
    await putBenchmarkSuite(s);
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(true);
    const done = result.ok ? await result.execution.done : null;
    expect(done?.ok).toBe(false);
    expect(done && 'error' in done && done.error).toMatch(/Could not pin targets/);
    expect(host.order.filter((x) => x.startsWith('load:'))).toEqual([]);
    expect(host.order.filter((x) => x === 'unpin').length).toBeGreaterThanOrEqual(1);
  });

  it('aborts preparation when pin fails even though no target has an explicit variant', async () => {
    // Pin failure means the run would have no eviction protection at all -- proceeding to load
    // anyway makes results depend on eviction/reload timing instead of being measured
    // consistently, contradicting the "pinned for the run's duration" invariant regardless of
    // whether any target happens to have an explicit variant.
    const host = fakeHost({
      pinAliases: async (aliases) => {
        host.order.push(`pin:${aliases.join(',')}`);
        throw new Error('pin failed');
      },
    });
    const s = suite();
    await putBenchmarkSuite(s);
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(true);
    const done = result.ok ? await result.execution.done : null;
    expect(done?.ok).toBe(false);
    expect(done && 'error' in done && done.error).toMatch(/Could not pin targets/);
    expect(host.order[0]).toBe('pin:model-a');
    expect(host.order.filter((x) => x.startsWith('load:'))).toEqual([]);
    expect(host.order.filter((x) => x === 'unpin').length).toBeGreaterThanOrEqual(1);
  });

  it('does not pin or load a live suite with duplicate target aliases, reporting the validator\'s actual error', async () => {
    const host = fakeHost();
    const s = suite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
      ],
    });
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(false);
    // Now surfaced by prepareBenchmarkRun's validateBenchmarkSuite call (not a pre-check that
    // assumes duplicate aliases for every validation failure), so the message names the specific
    // offending target rather than a generic/possibly-wrong diagnosis.
    expect(result.ok === false && result.error).toMatch(/duplicate target alias "model-a"/);
    expect(host.order).toEqual([]);
  });

  it('reports the suite validator\'s actual error for a malformed (non-duplicate-alias) suite, instead of a misleading duplicate-alias diagnosis', async () => {
    const host = fakeHost();
    const s = suite({ cases: [] });
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/cases must be an array/);
    expect(result.ok === false && result.error).not.toMatch(/duplicate target alias/);
    expect(host.order).toEqual([]);
  });

  it('does not pin or load when the run row cannot be created', async () => {
    await resetDatabase();
    const host = fakeHost();
    const result = await startBenchmarkSession(suite(), host);
    expect(result.ok).toBe(false);
    expect(host.order).toEqual([]);
  });

  it('stops a prepared run when pin fails for explicit variants', async () => {
    const host = fakeHost({
      pinAliases: async () => { throw new Error('pin failed'); },
    });
    const s = suite({ targets: [{ alias: 'model-a', variantId: 'v1' }] });
    await putBenchmarkSuite(s);
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(true);
    const done = result.ok ? await result.execution.done : null;
    expect(done?.ok).toBe(false);
    const runs = await listBenchmarkRunsForSuite(s.id);
    expect(runs.ok).toBe(true);
    expect(runs.value).toHaveLength(1);
    expect(runs.value![0].status).toBe('stopped');
    const stored = await getBenchmarkRun(runs.value![0].id);
    expect(stored.value?.status).toBe('stopped');
  });

  it('returns a Stop controller before model loads finish', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = fakeHost({
      loadModel: async (alias) => {
        host.order.push(`load:${alias}`);
        await gate;
      },
    });
    const s = suite({
      targets: [{ alias: 'model-a', variantId: null }, { alias: 'model-b', variantId: null }],
    });
    await putBenchmarkSuite(s);
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.runId).toBeTruthy();
    while (!host.order.includes('load:model-a')) {
      await new Promise((r) => setTimeout(r, 0));
    }
    result.execution.stopController.stop();
    release();
    const done = await result.execution.done;
    expect(done.ok).toBe(true);
    expect(done.result?.status).toBe('stopped');
    expect(host.order.filter((x) => x.startsWith('load:'))).toEqual(['load:model-a']);
    const stored = await getBenchmarkRun(result.execution.runId);
    expect(stored.value?.status).toBe('stopped');
  });

  it('pin/load uses the frozen snapshot even if the caller mutates the suite during pin', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = fakeHost({
      pinAliases: async (aliases) => {
        host.order.push(`pin:${aliases.join(',')}`);
        await gate;
      },
    });
    const s = suite({ targets: [{ alias: 'model-a', variantId: null }] });
    await putBenchmarkSuite(s);
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(true);
    s.targets.push({ alias: 'model-b', variantId: null });
    release();
    const done = result.ok ? await result.execution.done : null;
    expect(done?.ok).toBe(true);
    expect(host.order[0]).toBe('pin:model-a');
    expect(host.order).not.toContain('load:model-b');
    expect(host.order.filter((x) => x.startsWith('load:'))).toEqual(['load:model-a']);
  });

  it('includes a durability failure when a prepared run cannot be marked stopped', async () => {
    const msg = await haltPreparedRun('missing-run', 'Could not pin targets');
    expect(msg).toMatch(/Could not pin targets/);
    expect(msg).toMatch(/could not mark the run stopped/);
  });
});

describe('createSidecarBenchmarkTransport', () => {
  it('reads SDK-shaped usage fields', async () => {
    const transport = createSidecarBenchmarkTransport(async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { input_tokens: 11, output_tokens: 3 },
    }));
    const result = await transport({
      alias: 'model-a',
      requestedVariantId: null,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result).toEqual({
      ok: true,
      responseText: 'ok',
      servedVariantId: null,
      usage: { promptTokens: 11, completionTokens: 3 },
    });
  });

  it('halts on cancelled certainty instead of recording a failed attempt', async () => {
    const transport = createSidecarBenchmarkTransport(async () => {
      throw new SidecarOperationError('chatCompletion', 'cancelled', 'Runtime is draining');
    });
    const result = await transport({
      alias: 'model-a',
      requestedVariantId: null,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.haltRun).toBe('stopped');
  });

  it('locks an alias-only target to the first served variant and rejects a later switch', async () => {
    let calls = 0;
    const transport = createSidecarBenchmarkTransport(async () => {
      calls += 1;
      return {
        choices: [{ message: { content: 'ok' } }],
        servedVariantId: calls === 1 ? 'v1' : 'v2',
      };
    });
    const req = { alias: 'model-a', requestedVariantId: null, messages: [{ role: 'user' as const, content: 'x' }] };
    const first = await transport(req);
    expect(first.ok).toBe(true);
    const second = await transport(req);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errorMessage).toMatch(/bound variant "v1"/);
  });

  it('fails closed when a bound variant is expected but the response omits servedVariantId', async () => {
    const transport = createSidecarBenchmarkTransport(async () => ({
      choices: [{ message: { content: 'ok' } }],
    }), new Map([['model-a', 'v1']]));
    const result = await transport({
      alias: 'model-a',
      requestedVariantId: null,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorMessage).toMatch(/did not report a served variant/);
  });
});

describe('boundVariantIdForTarget / assertServedVariant', () => {
  it('uses an explicit suite variant when nothing was recorded, or when it matches what was recorded', () => {
    expect(boundVariantIdForTarget({ variantId: 'explicit' }, 0, [])).toEqual({ ok: true, variantId: 'explicit' });
    expect(boundVariantIdForTarget({ variantId: 'explicit' }, 0, [
      { targetIndex: 0, servedVariantId: 'explicit' },
    ])).toEqual({ ok: true, variantId: 'explicit' });
    expect(boundVariantIdForTarget({ variantId: null }, 1, [
      { targetIndex: 0, servedVariantId: 'other' },
      { targetIndex: 1, servedVariantId: 'hist-v' },
    ])).toEqual({ ok: true, variantId: 'hist-v' });
    expect(boundVariantIdForTarget({ variantId: null }, 0, [])).toEqual({ ok: true, variantId: null });
  });

  it('rejects an explicit suite variant that conflicts with a variant already recorded for that target', () => {
    // An older/headless run (or a suite edited after the fact) could have bound to a different
    // build; silently loading today's explicit suite variant instead would mix measurements from
    // two variants into one target, so this must fail loudly rather than pick the suite value.
    const result = boundVariantIdForTarget({ variantId: 'explicit' }, 0, [
      { targetIndex: 0, servedVariantId: 'hist' },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/recorded variant\(s\) hist.*do not match.*explicit/);
  });

  it('checks both boundVariantId and servedVariantId independently, not just whichever is present first', () => {
    // A single attempt recording boundVariantId='explicit' but servedVariantId='hist' means the
    // load bound one variant and chat served a different one -- exactly the mid-run variant swap
    // assertServedVariant already flags as a failed attempt. Resume must see that disagreement
    // even though boundVariantId alone would otherwise match the suite's explicit variant.
    const result = boundVariantIdForTarget({ variantId: 'explicit' }, 0, [
      { targetIndex: 0, boundVariantId: 'explicit', servedVariantId: 'hist' },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/recorded variant\(s\) hist.*do not match.*explicit/);

    // Both fields present and matching the explicit variant is fine.
    expect(boundVariantIdForTarget({ variantId: 'explicit' }, 0, [
      { targetIndex: 0, boundVariantId: 'explicit', servedVariantId: 'explicit' },
    ])).toEqual({ ok: true, variantId: 'explicit' });
  });

  it('fails closed when a target has attempts but none recorded a bound or served variant', () => {
    const result = boundVariantIdForTarget({ variantId: null }, 0, [
      { targetIndex: 0, boundVariantId: undefined, servedVariantId: undefined },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/none recorded a bound or served variant/);
  });

  it('prefers a durable boundVariantId over servedVariantId, recovering an uncertain (dispatched-only) attempt that never reached servedVariantId', () => {
    // A position left `dispatched` by Stop/crash has no servedVariantId (only ever written on a
    // terminal success), but its boundVariantId was committed before dispatch. Resume must
    // recover that durable binding, not fall back to null (which would let it load a different
    // default variant than the one this run actually used).
    expect(boundVariantIdForTarget({ variantId: null }, 0, [
      { targetIndex: 0, boundVariantId: 'bound-v1', servedVariantId: undefined },
    ])).toEqual({ ok: true, variantId: 'bound-v1' });
  });

  it('falls back to servedVariantId for legacy attempt rows written before boundVariantId existed', () => {
    expect(boundVariantIdForTarget({ variantId: null }, 0, [
      { targetIndex: 0, servedVariantId: 'legacy-served' },
    ])).toEqual({ ok: true, variantId: 'legacy-served' });
  });

  it('reports a conflict instead of silently picking one, when persisted attempts for a target disagree', () => {
    // Under correct operation every attempt for one target records the same binding (a mismatch
    // aborts preparation before it can be persisted); if two rows disagree anyway, that can only
    // mean corruption or a bug elsewhere, so this must fail loudly rather than resume against an
    // arbitrarily chosen variant.
    const result = boundVariantIdForTarget({ variantId: null }, 0, [
      { targetIndex: 0, boundVariantId: 'v1' },
      { targetIndex: 0, boundVariantId: 'v2' },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Conflicting recorded variants/);
  });

  it('rejects a missing or swapped served variant when one is bound', () => {
    expect(assertServedVariant('model-a', null, 'v2')).toEqual({ ok: true });
    expect(assertServedVariant('model-a', 'v1', 'v1')).toEqual({ ok: true });
    expect(assertServedVariant('model-a', 'v1', null).ok).toBe(false);
    expect(assertServedVariant('model-a', 'v1', 'v2').ok).toBe(false);
  });
});

describe('loadBenchmarkTargets', () => {
  it('names the alias and variant in the load-failure message', async () => {
    const result = await loadBenchmarkTargets(
      suite({ targets: [{ alias: 'phi', variantId: 'cuda:1' }] }),
      async () => { throw new Error('not found'); },
    );
    expect(result).toEqual({ ok: false, error: 'Could not load phi (cuda:1): not found' });
  });

  it('loads only the requested target indexes', async () => {
    const loaded: string[] = [];
    const result = await loadBenchmarkTargets(
      suite({
        targets: [
          { alias: 'model-a', variantId: null },
          { alias: 'model-b', variantId: null },
        ],
      }),
      async (alias) => { loaded.push(alias); },
      undefined,
      new Set([1]),
    );
    expect(result).toEqual({ ok: true });
    expect(loaded).toEqual(['model-b']);
  });

  it('rejects a fresh explicit-variant target whose load resolves to a different variant, instead of executing against the mismatched build', async () => {
    // `expectedByAlias` starts empty for a fresh run, so comparing the loader's result only
    // against a *prior* map entry would miss this case entirely (there is no prior entry to
    // disagree with) and silently accept whatever the loader resolved -- execution would then
    // dispatch every case against a build the suite never asked for.
    const result = await loadBenchmarkTargets(
      suite({ targets: [{ alias: 'phi', variantId: 'cuda:1' }] }),
      async () => 'cuda:2',
      undefined,
      undefined,
      new Map(),
    );
    expect(result).toEqual({
      ok: false,
      error: 'Loaded variant "cuda:2" for phi did not match the bound variant "cuda:1"',
    });
  });
});

describe('resumeBenchmarkSession', () => {
  it('rejects a legacy same-alias/different-variant snapshot without pinning or calling chat', async () => {
    await putRawRun({
      id: 'legacy-run',
      suiteId: 'suite-1',
      suite: suite({
        targets: [
          { alias: 'model-a', variantId: 'v1' },
          { alias: 'model-a', variantId: 'v2' },
        ],
      }),
      createdAt: Date.now(),
      status: 'stopped',
    });
    const host = fakeHost();
    const result = await resumeBenchmarkSession('legacy-run', host);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/cannot be resumed/);
    expect(host.order).toEqual([]);
  });

  it('resolves `done` even when the restore never settles, so a resume halt does not hang there (finishPreparedHalt path)', async () => {
    await putRawRun({
      id: 'hanging-unpin-run',
      suiteId: 'suite-1',
      suite: suite({ targets: [{ alias: 'model-a', variantId: null }] }),
      createdAt: Date.now(),
      status: 'stopped',
    });
    await recordAttemptDispatched({
      id: 'attempt-1',
      runId: 'hanging-unpin-run',
      logicalAttemptId: 'measured:0:0:0',
      targetIndex: 0,
      phase: 'measured',
      caseIndex: 0,
      repeatIndex: 0,
      sequence: 0,
      status: 'dispatched',
      alias: 'model-a',
      requestedVariantId: null,
      boundVariantId: 'v1',
      intentCommittedAt: Date.now(),
    });
    await recordAttemptDispatched({
      id: 'attempt-2',
      runId: 'hanging-unpin-run',
      logicalAttemptId: 'measured:0:0:0',
      targetIndex: 0,
      phase: 'measured',
      caseIndex: 0,
      repeatIndex: 0,
      sequence: 1,
      status: 'dispatched',
      alias: 'model-a',
      requestedVariantId: null,
      boundVariantId: 'v2',
      intentCommittedAt: Date.now(),
    });
    const host = fakeHost({ unpin: () => new Promise<void>(() => {}) });
    const result = await resumeBenchmarkSession('hanging-unpin-run', host);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = await Promise.race([
      result.execution.done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('done did not settle in time')), 500)),
    ]);
    expect(outcome.ok).toBe(false);
  });

  it('halts resume instead of dispatching, when persisted attempts for a target carry conflicting boundVariantId', async () => {
    // Proves the wiring end to end: boundVariantIdForTarget's conflict result actually reaches
    // resumeBenchmarkSession and prevents both pin/load and dispatch, not just the unit-level
    // helper return value.
    await putRawRun({
      id: 'conflicted-run',
      suiteId: 'suite-1',
      suite: suite({ targets: [{ alias: 'model-a', variantId: null }] }),
      createdAt: Date.now(),
      status: 'stopped',
    });
    const baseAttempt = {
      runId: 'conflicted-run',
      logicalAttemptId: 'measured:0:0:0',
      targetIndex: 0,
      phase: 'measured' as const,
      caseIndex: 0,
      repeatIndex: 0,
      status: 'dispatched' as const,
      alias: 'model-a',
      requestedVariantId: null,
      intentCommittedAt: Date.now(),
    };
    await recordAttemptDispatched({ ...baseAttempt, id: 'attempt-1', sequence: 0, boundVariantId: 'v1' });
    await recordAttemptDispatched({ ...baseAttempt, id: 'attempt-2', sequence: 1, boundVariantId: 'v2' });

    const host = fakeHost();
    const result = await resumeBenchmarkSession('conflicted-run', host);
    expect(result.ok).toBe(true);
    const outcome = result.ok && await result.execution.done;
    expect(outcome && outcome.ok).toBe(false);
    expect(outcome && !outcome.ok && outcome.error).toMatch(/Conflicting recorded variants/);
    // finishPreparedHalt best-effort unpins on the way out; neither loadModel nor pinAliases
    // (the load/pin path) ran, since the conflict is caught before pin/load begins.
    expect(host.order).toEqual(['unpin']);
  });

  it('halts resume when alias-only attempts exist but none recorded a bound or served variant', async () => {
    await putRawRun({
      id: 'unbound-run',
      suiteId: 'suite-1',
      suite: suite({ targets: [{ alias: 'model-a', variantId: null }] }),
      createdAt: Date.now(),
      status: 'stopped',
    });
    await recordAttemptDispatched({
      id: 'attempt-legacy',
      runId: 'unbound-run',
      logicalAttemptId: 'measured:0:0:0',
      targetIndex: 0,
      phase: 'measured',
      caseIndex: 0,
      repeatIndex: 0,
      sequence: 0,
      status: 'dispatched',
      alias: 'model-a',
      requestedVariantId: null,
      intentCommittedAt: Date.now(),
    });
    const host = fakeHost();
    const result = await resumeBenchmarkSession('unbound-run', host);
    expect(result.ok).toBe(true);
    const outcome = result.ok && await result.execution.done;
    expect(outcome && outcome.ok).toBe(false);
    expect(outcome && !outcome.ok && outcome.error).toMatch(/none recorded a bound or served variant/);
    expect(host.order).toEqual(['unpin']);
  });

  it('pins before loading when resuming a valid stopped run', async () => {
    const stopController = createStopController();
    stopController.stop();
    const started = await startBenchmarkRun(
      suite(),
      async () => ({ ok: true, responseText: 'x' }),
      stopController,
    );
    expect(started.ok).toBe(true);
    const host = fakeHost();
    const resumed = await resumeBenchmarkSession(started.run!.id, host);
    expect(resumed.ok).toBe(true);
    const done = resumed.ok ? await resumed.execution.done : null;
    expect(done?.ok).toBe(true);
    expect(host.order[0]).toBe('pin:model-a');
    expect(host.order).toContain('load:model-a');
  });

  it('resume pin/load skips a fully-settled target so a gone completed model cannot block pending retries', async () => {
    const s = suite({
      targets: [
        { alias: 'model-done', variantId: null },
        { alias: 'model-pending', variantId: null },
      ],
      warmupCount: 0,
      repeatCount: 1,
      cases: [{ id: 'c1', prompt: 'x' }],
    });
    await putBenchmarkSuite(s);
    const stopController = createStopController();
    const started = await startBenchmarkRun(s, async (req) => {
      if (req.alias === 'model-done') {
        stopController.stop();
        return { ok: true, responseText: 'ok' };
      }
      return { ok: true, responseText: 'should not run' };
    }, stopController);
    expect(started.ok).toBe(true);
    expect(started.result?.status).toBe('stopped');

    const host = fakeHost({
      loadModel: async (alias) => {
        host.order.push(`load:${alias}`);
        if (alias === 'model-done') throw new Error('no longer downloaded');
      },
    });
    const resumed = await resumeBenchmarkSession(started.run!.id, host);
    expect(resumed.ok).toBe(true);
    const done = resumed.ok ? await resumed.execution.done : null;
    expect(done?.ok).toBe(true);
    expect(host.order.filter((x) => x.startsWith('pin:'))).toEqual(['pin:model-pending']);
    expect(host.order.filter((x) => x.startsWith('load:'))).toEqual(['load:model-pending']);
  });

  it('resume pin failure is fatal regardless of whether a still-pending target has an explicit variant', async () => {
    const s = suite({
      targets: [
        { alias: 'model-done', variantId: 'v1' },
        { alias: 'model-pending', variantId: null },
      ],
      warmupCount: 0,
      repeatCount: 1,
      cases: [{ id: 'c1', prompt: 'x' }],
    });
    await putBenchmarkSuite(s);
    const stopController = createStopController();
    const started = await startBenchmarkRun(s, async (req) => {
      if (req.alias === 'model-done') {
        stopController.stop();
        return { ok: true, responseText: 'ok' };
      }
      return { ok: true, responseText: 'should not run' };
    }, stopController);
    expect(started.ok).toBe(true);

    const host = fakeHost({
      pinAliases: async (aliases) => {
        host.order.push(`pin:${aliases.join(',')}`);
        throw new Error('pin failed');
      },
    });
    const resumed = await resumeBenchmarkSession(started.run!.id, host);
    expect(resumed.ok).toBe(true);
    const done = resumed.ok ? await resumed.execution.done : null;
    expect(done?.ok).toBe(false);
    expect(host.order[0]).toBe('pin:model-pending');
    expect(host.order.filter((x) => x.startsWith('load:'))).toEqual([]);
  });

  it('treats a user Stop during resume pin/load as a stopped outcome, not a failed run', async () => {
    const stopController = createStopController();
    stopController.stop();
    const started = await startBenchmarkRun(
      suite(),
      async () => ({ ok: true, responseText: 'x' }),
      stopController,
    );
    expect(started.ok).toBe(true);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = fakeHost({
      loadModel: async (alias) => {
        host.order.push(`load:${alias}`);
        await gate;
      },
    });
    const resumed = await resumeBenchmarkSession(started.run!.id, host);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    while (!host.order.includes('load:model-a')) {
      await new Promise((r) => setTimeout(r, 0));
    }
    resumed.execution.stopController.stop();
    release();
    const done = await resumed.execution.done;
    expect(done.ok).toBe(true);
    expect(done.result?.status).toBe('stopped');
  });

  it('records a failed attempt when load bound a variant and chat served a different one', async () => {
    const host = fakeHost({
      loadModel: async (alias) => {
        host.order.push(`load:${alias}`);
        return 'bound-v1';
      },
      chatCompletion: async () => ({
        choices: [{ message: { content: 'ok' } }],
        servedVariantId: 'other-v2',
      }),
    });
    const result = await startBenchmarkSession(suite(), host);
    expect(result.ok).toBe(true);
    const done = result.ok ? await result.execution.done : null;
    expect(done?.ok).toBe(true);
    const attempts = await listAttemptsForRun(result.ok ? result.execution.runId : '');
    expect(attempts.ok).toBe(true);
    expect(attempts.value?.some((a) => a.status === 'failed' && /bound variant "bound-v1"/.test(a.errorMessage || ''))).toBe(true);
  });

  it('resume loads an alias-only target as the variant previously served', async () => {
    const s = suite({
      warmupCount: 0,
      repeatCount: 1,
      cases: [{ id: 'c1', prompt: 'x' }, { id: 'c2', prompt: 'y' }],
    });
    await putBenchmarkSuite(s);
    const stopController = createStopController();
    let n = 0;
    const started = await startBenchmarkRun(s, async () => {
      n += 1;
      if (n === 1) {
        stopController.stop();
        return { ok: true, responseText: 'ok', servedVariantId: 'hist-v' };
      }
      return { ok: true, responseText: 'ok', servedVariantId: 'hist-v' };
    }, stopController);
    expect(started.ok).toBe(true);

    const loaded: Array<[string, string | null]> = [];
    const host = fakeHost({
      loadModel: async (alias, variantId) => {
        loaded.push([alias, variantId]);
        host.order.push(`load:${alias}:${variantId}`);
        return variantId;
      },
      chatCompletion: async () => ({
        choices: [{ message: { content: 'ok' } }],
        servedVariantId: 'hist-v',
      }),
    });
    const resumed = await resumeBenchmarkSession(started.run!.id, host);
    expect(resumed.ok).toBe(true);
    const done = resumed.ok ? await resumed.execution.done : null;
    expect(done?.ok).toBe(true);
    expect(loaded).toEqual([['model-a', 'hist-v']]);
  });
});
