import { describe, expect, it } from 'vitest';
import { activityCandidateKeys } from './activity-booking.js';

describe('activityCandidateKeys', () => {
  it('charges a different variant of a resident alias to the raw name', () => {
    const keys = activityCandidateKeys({
      requested: 'qwen3.5-9b-generic-gpu',
      matchedResidentAlias: null,
      occupantAlias: 'qwen3.5-9b',
      occupantVariantId: 'qwen3.5-9b-cuda-gpu:4',
      resolvedAlias: 'qwen3.5-9b',
      resolvedVariantId: 'qwen3.5-9b-generic-gpu:4',
    });
    expect(keys[0]).toBe('qwen3.5-9b-generic-gpu');
    expect(keys).toContain('qwen3.5-9b');
  });

  it('charges the resident alias when the request names that build', () => {
    const keys = activityCandidateKeys({
      requested: 'qwen3.5-9b-cuda-gpu',
      matchedResidentAlias: 'qwen3.5-9b',
      occupantAlias: 'qwen3.5-9b',
      occupantVariantId: 'qwen3.5-9b-cuda-gpu:4',
      resolvedAlias: 'qwen3.5-9b',
      resolvedVariantId: 'qwen3.5-9b-cuda-gpu:4',
    });
    expect(keys[0]).toBe('qwen3.5-9b');
  });

  it('charges the resident alias when the request names the friendly alias', () => {
    const keys = activityCandidateKeys({
      requested: 'qwen3.5-9b',
      matchedResidentAlias: 'qwen3.5-9b',
      occupantAlias: 'qwen3.5-9b',
      occupantVariantId: 'qwen3.5-9b-cuda-gpu:4',
      resolvedAlias: 'qwen3.5-9b',
      resolvedVariantId: null,
    });
    expect(keys[0]).toBe('qwen3.5-9b');
  });

  it('charges the catalog alias for a cold load', () => {
    const keys = activityCandidateKeys({
      requested: 'qwen3.5-9b-generic-gpu',
      matchedResidentAlias: null,
      occupantAlias: null,
      occupantVariantId: null,
      resolvedAlias: 'qwen3.5-9b',
      resolvedVariantId: 'qwen3.5-9b-generic-gpu:4',
    });
    expect(keys[0]).toBe('qwen3.5-9b');
    expect(keys).toContain('qwen3.5-9b-generic-gpu');
  });

  it('keeps the raw name searchable after the requested variant becomes resident', () => {
    const keys = activityCandidateKeys({
      requested: 'qwen3.5-9b-generic-gpu',
      matchedResidentAlias: 'qwen3.5-9b',
      occupantAlias: 'qwen3.5-9b',
      occupantVariantId: 'qwen3.5-9b-generic-gpu:4',
      resolvedAlias: 'qwen3.5-9b',
      resolvedVariantId: 'qwen3.5-9b-generic-gpu:4',
    });
    expect(keys[0]).toBe('qwen3.5-9b');
    expect(keys).toContain('qwen3.5-9b-generic-gpu');
  });
});
