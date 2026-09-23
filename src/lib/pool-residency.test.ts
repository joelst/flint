import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPoolEntryResident } from './pool-residency';
import { computeResidentCapFloor } from './benchmark-priority-lease';
import { toWatchSample } from './memory-watchdog';

describe('pool residency consumers', () => {
  it.each([true, null, undefined])('preserves last-known residency for %s', (isLoaded) => {
    expect(isPoolEntryResident({ isLoaded })).toBe(true);
  });

  it('excludes explicit eviction from actions, badges, memory alerts, and capacity', () => {
    const pool = [
      { alias: 'evicted', variantId: 'evicted:1', isLoaded: false },
      { alias: 'resident', variantId: 'resident:1', isLoaded: true },
    ];
    const resident = pool.filter(isPoolEntryResident);
    expect(resident.some((entry) => entry.alias === 'evicted' && entry.variantId === 'evicted:1')).toBe(false);
    expect(resident.find((entry) => entry.alias === 'evicted')).toBeUndefined();
    expect(resident.map((entry) => entry.alias)).toEqual(['resident']);
    expect(computeResidentCapFloor(resident, { evicted: 'pinned' }, ['benchmark'])).toBe(1);
    expect(toWatchSample({ models: resident }, 0).modelsResident).toBe(1);
    expect(toWatchSample({ models: pool.slice(0, 1).filter(isPoolEntryResident) }, 0).modelsResident).toBe(0);
    expect(pool).toHaveLength(2);
  });

  it('wires every page residency decision through the filtered pool, retaining raw entries only for monitoring', () => {
    // +page.svelte is ts-nocheck: pin the shared policy at its untyped call sites.
    const page = readFileSync(join(process.cwd(), 'src', 'routes', '+page.svelte'), 'utf8');
    const rawPoolLines = page.split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .filter((line) => /\bstate\.pool\b/.test(line))
      .map((line) => line.trim());
    expect(rawPoolLines).toEqual([
      '(state.pool || []).filter((entry) => entry?.alias && isPoolEntryResident(entry)),',
      'state.pool = s.pool ?? [];',
      '{#if state.pool.length === 0}',
      '{#each state.pool as entry (entry.alias)}',
    ]);
    expect(page).toContain('loadedPoolEntries.some((e: any) => e.alias === model.alias && e.variantId === variantId)');
    expect(page).toContain('models: loadedPoolEntries');
  });
});
