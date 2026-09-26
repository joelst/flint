// Chooses which resident models to unload, and why.
//
// Foundry keeps a model in memory until something explicitly unloads it. Flint's gateway
// will happily load a model on behalf of any OpenAI-compatible client, so an agent that
// switches models over a long session accumulates them all — bounded only by RAM. The
// watchdog reports that; this bounds it.
//
// Two independent rules, both opt-in:
//   idle    — a model untouched for longer than the timeout is unloaded.
//   maxResident — the pool is capped, and the least valuable entries are unloaded to fit.
//
// Two things are never evicted, no matter what:
//   pinned models, because the user said to keep them;
//   models with a request in flight, because unloading mid-generation would fail a live
//   request. This matters more than it looks: gateway traffic is proxied straight to
//   Foundry, so a long completion can run for minutes past its last "touch".
//
// Pure: no timers, no SDK, no unloading. The caller acts on the returned plan.

/**
 * @typedef {object} PoolEntry
 * @property {string} alias
 * @property {number} lastUsedAt      epoch ms of the most recent request
 * @property {number} [inFlight]      requests currently being served
 * @property {'pinned'|'normal'|'low'} [priority]
 */

/**
 * @typedef {object} EvictionConfig
 * @property {boolean} idleUnloadEnabled
 * @property {number}  idleTimeoutMs
 * @property {boolean} maxResidentEnabled
 * @property {number}  maxResident
 */

/** @type {EvictionConfig} */
export const DEFAULT_EVICTION_CONFIG = {
  idleUnloadEnabled: false,
  idleTimeoutMs: 30 * 60 * 1000,
  maxResidentEnabled: false,
  maxResident: 3,
};

const PRIORITY_RANK = { low: 0, normal: 1, pinned: 2 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Keeps a corrupted or hand-edited persisted config from unloading models unexpectedly. */
export function normalizeEvictionConfig (input) {
  const d = DEFAULT_EVICTION_CONFIG;
  const src = input ?? {};
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    idleUnloadEnabled: src.idleUnloadEnabled === true,
    // A floor of one minute: shorter turns every pause into an unload/reload cycle that
    // costs far more time than the memory is worth.
    idleTimeoutMs: clamp(num(src.idleTimeoutMs, d.idleTimeoutMs), 60_000, 24 * 60 * 60 * 1000),
    maxResidentEnabled: src.maxResidentEnabled === true,
    maxResident: clamp(Math.round(num(src.maxResident, d.maxResident)), 1, 32),
  };
}

export function normalizePriority (value) {
  return value === 'pinned' || value === 'low' ? value : 'normal';
}

/** Pinned models and models mid-request are off limits for both rules. */
function isProtected (entry) {
  return normalizePriority(entry.priority) === 'pinned' || Number(entry.inFlight) > 0;
}

/**
 * Least valuable first: lowest priority, then least recently used. Ties break on alias so
 * the plan is deterministic — an unstable order would make the tests lie and would make
 * two identical pools evict different models.
 */
function byEvictionOrder (a, b) {
  const rank = PRIORITY_RANK[normalizePriority(a.priority)] - PRIORITY_RANK[normalizePriority(b.priority)];
  if (rank !== 0) return rank;
  const used = lastUsed(a) - lastUsed(b);
  if (used !== 0) return used;
  return a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0;
}

/**
 * A missing or nonsense timestamp is treated as "just used" rather than "never used".
 * Erring the other way would let a bookkeeping bug silently unload a model the user is
 * actively talking to; this way the entry simply becomes evictable once it is touched.
 */
function lastUsed (entry, now = Date.now()) {
  const value = Number(entry?.lastUsedAt);
  return Number.isFinite(value) ? value : now;
}

/**
 * @param {PoolEntry[]} entries          currently resident models
 * @param {EvictionConfig} config
 * @param {number} now                   epoch ms
 * @param {object} [options]
 * @param {number} [options.admitting]   models about to be loaded, counted against the cap
 *   so room is made *before* the load rather than after memory is already committed
 * @returns {{alias: string, reason: 'idle'|'cap'}[]} in the order they should be unloaded
 */
export function selectEvictions (entries, config, now, options = {}) {
  const cfg = normalizeEvictionConfig(config);
  const admitting = Math.max(0, Number(options.admitting) || 0);
  const pool = Array.isArray(entries) ? entries.filter(e => e && typeof e.alias === 'string') : [];

  /** @type {{alias: string, reason: 'idle'|'cap'}[]} */
  const plan = [];
  const evicted = new Set();

  if (cfg.idleUnloadEnabled) {
    for (const entry of pool) {
      if (isProtected(entry)) continue;
      if (now - lastUsed(entry, now) >= cfg.idleTimeoutMs) {
        plan.push({ alias: entry.alias, reason: 'idle' });
        evicted.add(entry.alias);
      }
    }
  }

  if (cfg.maxResidentEnabled) {
    // The cap counts everything that will be resident, including protected entries and the
    // load we are making room for. Protected entries can push the pool over the cap and
    // there is nothing to be done about that — evicting everything else would not help.
    const remaining = pool.filter(e => !evicted.has(e.alias));
    let residentCount = remaining.length + admitting;
    if (residentCount > cfg.maxResident) {
      const candidates = remaining.filter(e => !isProtected(e)).sort(byEvictionOrder);
      for (const entry of candidates) {
        if (residentCount <= cfg.maxResident) break;
        plan.push({ alias: entry.alias, reason: 'cap' });
        evicted.add(entry.alias);
        residentCount--;
      }
    }
  }

  return plan;
}

/** Human-readable reason for the log and the UI. */
export function describeEviction (entry, config) {
  const cfg = normalizeEvictionConfig(config);
  if (entry.reason === 'idle') {
    const minutes = Math.round(cfg.idleTimeoutMs / 60_000);
    return `${entry.alias} unloaded after ${minutes} min idle`;
  }
  return `${entry.alias} unloaded to stay within the ${cfg.maxResident}-model limit`;
}
