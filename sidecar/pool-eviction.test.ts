import { describe, it, expect } from 'vitest';
import {
  selectEvictions,
  normalizeEvictionConfig,
  normalizePriority,
  describeEviction,
  DEFAULT_EVICTION_CONFIG,
} from './pool-eviction.js';

const NOW = 1_000_000_000;
const minutes = n => n * 60_000;

const entry = (alias, over = {}) => ({
  alias,
  lastUsedAt: NOW,
  inFlight: 0,
  priority: 'normal',
  ...over,
});

const idleCfg = (over = {}) => ({
  ...DEFAULT_EVICTION_CONFIG,
  idleUnloadEnabled: true,
  idleTimeoutMs: minutes(30),
  ...over,
});

const capCfg = (over = {}) => ({
  ...DEFAULT_EVICTION_CONFIG,
  maxResidentEnabled: true,
  maxResident: 2,
  ...over,
});

// Both rules on at once. Composing the two helpers with spread would not work: each one
// re-applies the defaults and would silently switch the other rule back off.
const bothCfg = (over = {}) => ({
  ...DEFAULT_EVICTION_CONFIG,
  idleUnloadEnabled: true,
  idleTimeoutMs: minutes(30),
  maxResidentEnabled: true,
  maxResident: 2,
  ...over,
});

const aliases = plan => plan.map(p => p.alias);

describe('selectEvictions — disabled by default', () => {
  it('evicts nothing when both rules are off', () => {
    const pool = [entry('a', { lastUsedAt: 0 }), entry('b'), entry('c'), entry('d')];
    expect(selectEvictions(pool, DEFAULT_EVICTION_CONFIG, NOW)).toEqual([]);
  });

  it('tolerates a missing or malformed pool', () => {
    expect(selectEvictions(null, idleCfg(), NOW)).toEqual([]);
    expect(selectEvictions([null, undefined, { noAlias: true }], idleCfg(), NOW)).toEqual([]);
  });
});

describe('selectEvictions — idle unload', () => {
  it('unloads a model past the idle timeout', () => {
    const pool = [entry('stale', { lastUsedAt: NOW - minutes(31) }), entry('fresh')];
    expect(selectEvictions(pool, idleCfg(), NOW)).toEqual([{ alias: 'stale', reason: 'idle' }]);
  });

  it('treats the timeout as inclusive', () => {
    const pool = [entry('exact', { lastUsedAt: NOW - minutes(30) })];
    expect(aliases(selectEvictions(pool, idleCfg(), NOW))).toEqual(['exact']);
  });

  it('leaves a model one millisecond short of the timeout', () => {
    const pool = [entry('nearly', { lastUsedAt: NOW - minutes(30) + 1 })];
    expect(selectEvictions(pool, idleCfg(), NOW)).toEqual([]);
  });

  it('unloads every idle model, not just the oldest', () => {
    const pool = [
      entry('a', { lastUsedAt: NOW - minutes(90) }),
      entry('b', { lastUsedAt: NOW - minutes(60) }),
      entry('c'),
    ];
    expect(aliases(selectEvictions(pool, idleCfg(), NOW)).sort()).toEqual(['a', 'b']);
  });

  it('treats a missing timestamp as just-used rather than never-used', () => {
    const pool = [entry('unknown', { lastUsedAt: undefined }), entry('bad', { lastUsedAt: Number.NaN })];
    expect(selectEvictions(pool, idleCfg(), NOW)).toEqual([]);
  });
});

describe('selectEvictions — protected entries', () => {
  it('never unloads a pinned model, however idle', () => {
    const pool = [entry('kept', { lastUsedAt: 0, priority: 'pinned' })];
    expect(selectEvictions(pool, idleCfg(), NOW)).toEqual([]);
  });

  it('never unloads a model with a request in flight', () => {
    // A gateway completion can run for minutes past its last touch; unloading underneath it
    // would fail a live request.
    const pool = [entry('busy', { lastUsedAt: 0, inFlight: 1 })];
    expect(selectEvictions(pool, idleCfg(), NOW)).toEqual([]);
  });

  it('keeps pinned models even when the cap is exceeded', () => {
    const pool = [
      entry('p1', { priority: 'pinned', lastUsedAt: 0 }),
      entry('p2', { priority: 'pinned', lastUsedAt: 0 }),
      entry('other', { lastUsedAt: NOW }),
    ];
    expect(aliases(selectEvictions(pool, capCfg(), NOW))).toEqual(['other']);
  });

  it('gives up rather than evicting pinned models when pins alone exceed the cap', () => {
    const pool = [
      entry('p1', { priority: 'pinned' }),
      entry('p2', { priority: 'pinned' }),
      entry('p3', { priority: 'pinned' }),
    ];
    expect(selectEvictions(pool, capCfg(), NOW)).toEqual([]);
  });
});

describe('selectEvictions — max resident cap', () => {
  it('does nothing while the pool is within the cap', () => {
    expect(selectEvictions([entry('a'), entry('b')], capCfg(), NOW)).toEqual([]);
  });

  it('evicts the least recently used until the pool fits', () => {
    const pool = [
      entry('newest', { lastUsedAt: NOW }),
      entry('oldest', { lastUsedAt: NOW - minutes(50) }),
      entry('middle', { lastUsedAt: NOW - minutes(10) }),
      entry('older', { lastUsedAt: NOW - minutes(30) }),
    ];
    expect(aliases(selectEvictions(pool, capCfg(), NOW))).toEqual(['oldest', 'older']);
  });

  it('evicts low-priority models before more recently used normal ones', () => {
    const pool = [
      entry('lowbutfresh', { lastUsedAt: NOW, priority: 'low' }),
      entry('normalold', { lastUsedAt: NOW - minutes(50) }),
      entry('normalnew', { lastUsedAt: NOW }),
    ];
    expect(aliases(selectEvictions(pool, capCfg({ maxResident: 2 }), NOW))).toEqual(['lowbutfresh']);
  });

  it('breaks ties deterministically by alias', () => {
    const pool = [entry('zeta'), entry('alpha'), entry('beta')];
    expect(aliases(selectEvictions(pool, capCfg(), NOW))).toEqual(['alpha']);
  });

  it('makes room before admitting a new model', () => {
    // Counting the incoming load against the cap means memory is freed before it is spent,
    // not after.
    const pool = [entry('a', { lastUsedAt: NOW - minutes(50) }), entry('b', { lastUsedAt: NOW })];
    expect(aliases(selectEvictions(pool, capCfg(), NOW, { admitting: 1 }))).toEqual(['a']);
  });

  it('ignores a nonsense admitting value', () => {
    const pool = [entry('a'), entry('b')];
    expect(selectEvictions(pool, capCfg(), NOW, { admitting: Number.NaN })).toEqual([]);
    expect(selectEvictions(pool, capCfg(), NOW, { admitting: -5 })).toEqual([]);
  });
});

describe('selectEvictions — both rules together', () => {
  it('does not plan the same model twice', () => {
    const pool = [
      entry('idle1', { lastUsedAt: NOW - minutes(90) }),
      entry('idle2', { lastUsedAt: NOW - minutes(80) }),
      entry('active', { lastUsedAt: NOW }),
    ];
    const plan = selectEvictions(pool, bothCfg({ maxResident: 1 }), NOW);
    expect(plan).toEqual([
      { alias: 'idle1', reason: 'idle' },
      { alias: 'idle2', reason: 'idle' },
    ]);
    expect(new Set(aliases(plan)).size).toBe(plan.length);
  });

  it('applies the cap to whatever the idle rule left behind', () => {
    const pool = [
      entry('stale', { lastUsedAt: NOW - minutes(90) }),
      entry('a', { lastUsedAt: NOW - minutes(5) }),
      entry('b', { lastUsedAt: NOW - minutes(4) }),
      entry('c', { lastUsedAt: NOW }),
    ];
    const plan = selectEvictions(pool, bothCfg({ maxResident: 2 }), NOW);
    expect(plan).toEqual([
      { alias: 'stale', reason: 'idle' },
      { alias: 'a', reason: 'cap' },
    ]);
  });
});

describe('normalizeEvictionConfig', () => {
  it('defaults both rules to off', () => {
    expect(normalizeEvictionConfig(null)).toEqual(DEFAULT_EVICTION_CONFIG);
    expect(normalizeEvictionConfig({}).idleUnloadEnabled).toBe(false);
    expect(normalizeEvictionConfig({}).maxResidentEnabled).toBe(false);
  });

  it('requires an explicit true to enable a rule', () => {
    expect(normalizeEvictionConfig({ idleUnloadEnabled: 'yes' }).idleUnloadEnabled).toBe(false);
    expect(normalizeEvictionConfig({ idleUnloadEnabled: true }).idleUnloadEnabled).toBe(true);
  });

  it('holds the idle timeout above a one-minute floor', () => {
    expect(normalizeEvictionConfig({ idleTimeoutMs: 5 }).idleTimeoutMs).toBe(60_000);
    expect(normalizeEvictionConfig({ idleTimeoutMs: 1e12 }).idleTimeoutMs).toBe(24 * 60 * 60 * 1000);
  });

  it('keeps the cap at one or more', () => {
    expect(normalizeEvictionConfig({ maxResident: 0 }).maxResident).toBe(1);
    expect(normalizeEvictionConfig({ maxResident: -3 }).maxResident).toBe(1);
    expect(normalizeEvictionConfig({ maxResident: 999 }).maxResident).toBe(32);
  });

  it('falls back on non-numeric values', () => {
    expect(normalizeEvictionConfig({ maxResident: 'lots' }).maxResident).toBe(DEFAULT_EVICTION_CONFIG.maxResident);
    expect(normalizeEvictionConfig({ idleTimeoutMs: Number.NaN }).idleTimeoutMs).toBe(DEFAULT_EVICTION_CONFIG.idleTimeoutMs);
  });
});

describe('normalizePriority', () => {
  it('recognises the three levels and rejects anything else', () => {
    expect(normalizePriority('pinned')).toBe('pinned');
    expect(normalizePriority('low')).toBe('low');
    expect(normalizePriority('normal')).toBe('normal');
    expect(normalizePriority('urgent')).toBe('normal');
    expect(normalizePriority(undefined)).toBe('normal');
  });
});

describe('describeEviction', () => {
  it('explains an idle unload in minutes', () => {
    expect(describeEviction({ alias: 'phi', reason: 'idle' }, idleCfg()))
      .toBe('phi unloaded after 30 min idle');
  });

  it('explains a cap eviction', () => {
    expect(describeEviction({ alias: 'phi', reason: 'cap' }, capCfg()))
      .toBe('phi unloaded to stay within the 2-model limit');
  });
});
