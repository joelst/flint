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
import { getBenchmarkRun, listAttemptsForRun, listBenchmarkRunsForSuite, openBenchmarkDatabase, putBenchmarkSuite } from './benchmark-repository';
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

  it('does not pin or load a live suite with duplicate target aliases', async () => {
    const host = fakeHost();
    const s = suite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
      ],
    });
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/duplicate target aliases/);
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
  it('prefers the suite variant, else the first served variant already recorded for that target', () => {
    expect(boundVariantIdForTarget({ variantId: 'explicit' }, 0, [
      { targetIndex: 0, servedVariantId: 'hist' },
    ])).toBe('explicit');
    expect(boundVariantIdForTarget({ variantId: null }, 1, [
      { targetIndex: 0, servedVariantId: 'other' },
      { targetIndex: 1, servedVariantId: 'hist-v' },
    ])).toBe('hist-v');
    expect(boundVariantIdForTarget({ variantId: null }, 0, [])).toBe(null);
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
