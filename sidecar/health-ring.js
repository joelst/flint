/** Bounded in-process health history. Not a metrics database. */

export const HEALTH_RING_MAX = 200;

/**
 * @param {number} [max]
 */
export function createHealthRing(max = HEALTH_RING_MAX) {
  if (!Number.isInteger(max) || max < 1) throw new TypeError('max must be a positive integer');
  /** @type {object[]} */
  const events = [];

  function record(event) {
    const entry = { ...event, ts: Date.now() };
    events.push(entry);
    if (events.length > max) events.splice(0, events.length - max);
    return entry;
  }

  function snapshot() {
    return events.slice();
  }

  return { record, snapshot };
}
