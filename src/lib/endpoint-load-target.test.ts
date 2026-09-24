import { describe, expect, it } from 'vitest';
import { endpointLoadTarget } from './endpoint-load-target';

const whisper = {
  alias: 'whisper-tiny',
  variants: [
    { id: 'openai-whisper-tiny-generic-cpu:3', cached: false },
    { id: 'openai-whisper-tiny-generic-cpu:1', cached: true },
    { id: 'openai-whisper-tiny-generic-cpu:2', cached: true },
  ],
};
const uncached = {
  alias: 'whisper-large',
  variants: [{ id: 'openai-whisper-large-generic-cpu:1', cached: false }],
};

describe('endpointLoadTarget', () => {
  it('loads the highest cached version for a versionless id, not the first catalog match', () => {
    expect(endpointLoadTarget([whisper], 'openai-whisper-tiny-generic-cpu')).toEqual({
      model: whisper,
      variantId: 'openai-whisper-tiny-generic-cpu:2',
    });
  });

  it('loads exactly the cached version a versioned id names', () => {
    expect(endpointLoadTarget([whisper], 'openai-whisper-tiny-generic-cpu:1')?.variantId)
      .toBe('openai-whisper-tiny-generic-cpu:1');
  });

  it('never selects an uncached build', () => {
    expect(endpointLoadTarget([whisper], 'openai-whisper-tiny-generic-cpu:3')?.variantId)
      .toBeUndefined();
    expect(endpointLoadTarget([uncached], 'openai-whisper-large-generic-cpu')).toBeNull();
    expect(endpointLoadTarget([uncached], 'whisper-large')).toBeNull();
  });

  it('pins no variant for an alias, as the gateway does', () => {
    expect(endpointLoadTarget([whisper], 'whisper-tiny')).toEqual({ model: whisper, variantId: null });
  });

  it('returns null for an id no cached model advertises', () => {
    expect(endpointLoadTarget([whisper], 'unknown-model')).toBeNull();
  });
});
