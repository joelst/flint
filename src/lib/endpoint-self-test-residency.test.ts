import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createSelfTestResidencyController,
  preferredResidentChatAlias,
} from './endpoint-self-test-residency';

const models = [
  {
    alias: 'Chat-Model',
    variants: [{ id: 'chat-model-generic-cpu:1' }, { id: 'chat-model-generic-cuda:2' }],
  },
  {
    alias: 'speech-model',
    variants: [{ id: 'speech-model-generic-cpu:1' }],
  },
];

describe('endpoint self-test residency', () => {
  it('restores an originally resident alias to its exact variant', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const unload = vi.fn().mockResolvedValue(undefined);
    const controller = createSelfTestResidencyController({
      models,
      initialPool: [{ alias: 'chat-model', variantId: 'chat-model-generic-cpu:1' }],
      currentPool: async () => [],
      load,
      unload,
    });

    await controller.restore('CHAT-MODEL-GENERIC-CUDA');

    expect(load).toHaveBeenCalledWith(models[0], 'chat-model-generic-cpu:1');
    expect(unload).not.toHaveBeenCalled();
  });

  it('unloads an alias that was not resident before the test', async () => {
    const unload = vi.fn().mockResolvedValue(undefined);
    const controller = createSelfTestResidencyController({
      models,
      initialPool: [],
      currentPool: async () => [{ alias: 'speech-model', variantId: 'speech-model-generic-cpu:1' }],
      load: vi.fn(),
      unload,
    });

    await controller.restore('speech-model-generic-cpu:1');

    expect(unload).toHaveBeenCalledWith('speech-model');
  });

  it('keeps a model the user loaded after the run started, restoring the variant they chose', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const unload = vi.fn().mockResolvedValue(undefined);
    // Not resident at the start; the user loads the CUDA build before this alias's probes.
    let pool: Array<{ alias: string; variantId: string }> = [];
    const controller = createSelfTestResidencyController({
      models,
      initialPool: [],
      currentPool: async () => pool,
      load,
      unload,
    });

    pool = [{ alias: 'chat-model', variantId: 'chat-model-generic-cuda:2' }];
    await controller.observe('chat-model-generic-cpu');
    // The gateway probe switched the alias to the listed CPU build.
    pool = [{ alias: 'chat-model', variantId: 'chat-model-generic-cpu:1' }];
    await controller.restore('chat-model-generic-cpu');

    expect(load).toHaveBeenCalledWith(models[0], 'chat-model-generic-cuda:2');
    expect(unload).not.toHaveBeenCalled();
  });

  it('unloads a model that was absent just before its probe, even if it was resident at the start', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const unload = vi.fn().mockResolvedValue(undefined);
    let pool: Array<{ alias: string; variantId: string }> = [];
    const controller = createSelfTestResidencyController({
      models,
      // Resident at the start, then unloaded (by eviction, say) before this group's probes.
      initialPool: [{ alias: 'speech-model', variantId: 'speech-model-generic-cpu:1' }],
      currentPool: async () => pool,
      load,
      unload,
    });

    await controller.observe('speech-model');
    pool = [{ alias: 'speech-model', variantId: 'speech-model-generic-cpu:1' }];
    await controller.restore('speech-model');

    expect(unload).toHaveBeenCalledWith('speech-model');
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses to unload activity that arrived during the self-test', async () => {
    const unload = vi.fn();
    const controller = createSelfTestResidencyController({
      models,
      initialPool: [],
      currentPool: async () => [{
        alias: 'speech-model',
        variantId: 'speech-model-generic-cpu:1',
        inFlight: 1,
      }],
      load: vi.fn(),
      unload,
    });

    await expect(controller.restore('speech-model')).rejects.toThrow(/requests are in flight/);
    expect(unload).not.toHaveBeenCalled();
  });

  it('prefers an already-resident chat alias for the terminal disconnect probe', () => {
    const classify = (id: string) => id.toLowerCase().includes('speech')
      ? 'speech' as const
      : 'chat' as const;

    expect(preferredResidentChatAlias([
      { alias: 'speech-model', variantId: 'speech-model-generic-cpu:1' },
      { alias: 'Chat-Model', variantId: 'chat-model-generic-cpu:1' },
    ], classify)).toBe('Chat-Model');
  });

  it('wires cleanup through the sidecar-side atomic idle fence', () => {
    const sidecar = readFileSync(
      join(process.cwd(), 'sidecar', 'foundry-sidecar-main.js'),
      'utf8',
    );
    const page = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');

    expect(sidecar).toContain("unload:             { required: ['alias'], optional: ['lane', 'ifIdle'] }");
    expect(sidecar).toContain('const releaseIdleFence = payload.ifIdle ? tryBeginIdleUnload(alias)');
    expect(sidecar).toContain("phase === 'start'");
    expect(sidecar).toContain('activityFences.has(candidate.toLowerCase())');
    expect(page).toContain('sdkUnloadModelIfIdle({ alias })');
  });

  it('fences the page against user pool changes while the self-test runs', () => {
    const page = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');

    expect(page).toContain('beforeModelProbe: residency.observe,');
    expect(page).toContain('afterModelProbe: residency.restore,');
    // The one fence every Models/Monitor/chat-model-switch mutation checks covers the run.
    const fence = page.slice(page.indexOf('function blockedByExclusivePoolRun()'), page.indexOf('\n  }', page.indexOf('function blockedByExclusivePoolRun()')));
    expect(fence).toContain('benchmarkRunInFlight');
    expect(fence).toContain('endpointSelfTestBusy');
    expect(page).not.toContain('blockedByActiveBenchmark');
    // And the run does not start over a mutation that is already in flight, or an Arena run.
    const run = page.slice(page.indexOf('async function runGatewaySelfTest()'), page.indexOf('endpointSelfTestBusy = true;'));
    expect(run).toContain('poolMutationsInFlight > 0');
    expect(run).toContain('isComparing || comparePreparing');
    // The Arena checks the same fence, so it cannot start while the self-test runs.
    const arenaStart = page.indexOf('async function runComparison(');
    const arena = page.slice(arenaStart, page.indexOf('compareReviewId = null;', arenaStart));
    expect(arena).toContain('blockedByExclusivePoolRun()');
  });
});
