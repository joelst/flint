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
});
