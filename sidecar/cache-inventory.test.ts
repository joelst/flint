import { describe, expect, it } from 'vitest';
import { summarizeCacheInventory } from './cache-inventory.js';

describe('cache inventory summary', () => {
  it('reports duplicate aliases and partial bytes without authorizing deletion', () => {
    const result = summarizeCacheInventory([
      { path: '/cache/a/v1', alias: 'a', variantId: 'a-cpu:1', sizeBytes: 100, partial: false, linked: false, owned: false },
      { path: '/cache/a/v2', alias: 'a', variantId: 'a-cpu:2', sizeBytes: 200, partial: false, linked: false, owned: false },
      { path: '/cache/b', alias: 'b', variantId: null, sizeBytes: 50, partial: true, linked: false, owned: true },
    ]);

    expect(result.totalBytes).toBe(350);
    expect(result.partialBytes).toBe(50);
    expect(result.duplicateBytes).toBe(100);
    expect(result.duplicateGroups[0]).toMatchObject({
      alias: 'a',
      entries: ['/cache/a/v1', '/cache/a/v2'],
      recommendation: expect.stringContaining('do not delete'),
    });
    expect(result.partialEntries[0].recommendation).toContain('do not delete');
  });

  it('ignores malformed entries and normalizes invalid sizes', () => {
    const result = summarizeCacheInventory([
      null as any,
      { path: '/cache/a', alias: null, variantId: null, sizeBytes: -1, partial: false, linked: false, owned: false },
      { path: '', alias: 'ignored', variantId: null, sizeBytes: 9, partial: false, linked: false, owned: false },
    ]);

    expect(result.entries).toHaveLength(2);
    expect(result.totalBytes).toBe(9);
    expect(result.duplicateGroups).toEqual([]);
  });
});
