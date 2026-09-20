import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SidecarOperationError } from './operation-outcome';
import {
  createSidecarBenchmarkTransport,
  loadBenchmarkTargets,
  resumeBenchmarkSession,
  startBenchmarkSession,
  type BenchmarkLifecycleHost,
} from './benchmark-lifecycle';
import { createStopController, startBenchmarkRun } from './benchmark-runner';
import { getBenchmarkRun, listBenchmarkRunsForSuite, openBenchmarkDatabase, putBenchmarkSuite } from './benchmark-repository';
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
    expect(result.ok).toBe(false);
    expect(host.order[0]).toBe('pin:model-a,model-b');
    expect(host.order).toContain('load:model-a');
    expect(host.order).toContain('unpin');
  });

  it('does not load when pin fails and the suite has explicit variants', async () => {
    const host = fakeHost({
      pinAliases: async () => { throw new Error('pin failed'); },
    });
    const s = suite({ targets: [{ alias: 'model-a', variantId: 'v1' }] });
    await putBenchmarkSuite(s);
    const result = await startBenchmarkSession(s, host);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/explicit variants/);
    expect(host.order).toEqual(['unpin']);
  });

  it('still loads when pin fails and no target has an explicit variant', async () => {
    const host = fakeHost({
      pinAliases: async (aliases) => {
        host.order.push(`pin:${aliases.join(',')}`);
        throw new Error('pin failed');
      },
    });
    const result = await startBenchmarkSession(suite(), host);
    expect(result.ok).toBe(true);
    expect(host.order[0]).toBe('pin:model-a');
    expect(host.order).toContain('load:model-a');
    if (result.ok) {
      result.execution.stopController.stop();
      await result.execution.done;
    }
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
    expect(result.ok).toBe(false);
    const runs = await listBenchmarkRunsForSuite(s.id);
    expect(runs.ok).toBe(true);
    expect(runs.value).toHaveLength(1);
    expect(runs.value![0].status).toBe('stopped');
    const stored = await getBenchmarkRun(runs.value![0].id);
    expect(stored.value?.status).toBe('stopped');
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
});

describe('loadBenchmarkTargets', () => {
  it('names the alias and variant in the load-failure message', async () => {
    const result = await loadBenchmarkTargets(
      suite({ targets: [{ alias: 'phi', variantId: 'cuda:1' }] }),
      async () => { throw new Error('not found'); },
    );
    expect(result).toEqual({ ok: false, error: 'Could not load phi (cuda:1): not found' });
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
    expect(host.order[0]).toBe('pin:model-a');
    expect(host.order).toContain('load:model-a');
    if (resumed.ok) {
      resumed.execution.stopController.stop();
      await resumed.execution.done;
    }
  });
});
