import { describe, expect, it } from 'vitest';
import { createHealthRing } from './health-ring.js';

describe('createHealthRing', () => {
  it('appends events and snapshots a copy', () => {
    const ring = createHealthRing(10);
    ring.record({ kind: 'init' });
    const snap = ring.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].kind).toBe('init');
    expect(typeof snap[0].ts).toBe('number');
    snap.push({ kind: 'mutated' });
    expect(ring.snapshot()).toHaveLength(1);
  });

  it('owns recorded timestamps even when callers provide one', () => {
    const ring = createHealthRing(10);
    const before = Date.now();
    const entry = ring.record({ kind: 'init', ts: 1 });
    expect(entry.ts).toBeGreaterThanOrEqual(before);
  });

  it('drops the oldest events when full', () => {
    const ring = createHealthRing(3);
    ring.record({ kind: 'a' });
    ring.record({ kind: 'b' });
    ring.record({ kind: 'c' });
    ring.record({ kind: 'd' });
    expect(ring.snapshot().map((e) => e.kind)).toEqual(['b', 'c', 'd']);
  });

  it('rejects a non-positive max', () => {
    expect(() => createHealthRing(0)).toThrow(/positive integer/);
  });
});
