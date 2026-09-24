/**
 * Request admission and in-flight accounting for model activity.
 *
 * A booking is keyed by the normalized name the request asked for. The key is a pure function
 * of the request, so the end of a long request always releases the entry its start booked,
 * even after the pool changed underneath it.
 *
 * A destructive operation on an alias (unload, eviction, variant switch, deletion) waits for
 * the requests its resident build serves: bookings of the alias name itself, and bookings
 * whose name the pool resolves to that alias. A name the pool does not resolve is not using
 * anything the operation removes: the pool records every build the native core has loaded
 * (each load goes through it, and a listener restart keeps it), and the native router serves
 * only the exact variant id that is loaded, so such a request can reach only builds the pool
 * lists. If it later autoloads, the load serializes behind the operation on the alias's
 * residency scope and must re-validate its target there.
 */
export function createModelActivityFence({
  residentAliasFor,
  residentVariantFor,
  catalogAliasFor,
  catalogResolutionFor,
}) {
  if (typeof residentAliasFor !== 'function' || typeof catalogAliasFor !== 'function') {
    throw new TypeError('model activity fence requires resident and catalog alias resolution');
  }

  const fenced = new Set();
  const active = new Map();
  const keyOf = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');

  function inFlightFor(alias) {
    const target = keyOf(alias);
    if (!target) return 0;
    let count = 0;
    for (const [name, booking] of active) {
      if (name === target) {
        count += booking.count;
        continue;
      }
      if (keyOf(residentAliasFor(name)) !== target) continue;
      let residentCount = booking.count;
      if (booking.deferredCount > 0 && typeof residentVariantFor === 'function') {
        const resolution = typeof catalogResolutionFor === 'function'
          ? catalogResolutionFor(name)
          : null;
        const residentVariant = residentVariantFor(target);
        if (
          !resolution
          || (
            resolution.alias
            && keyOf(resolution.alias) === target
            && resolution.variantId
            && residentVariant
            && keyOf(resolution.variantId) !== keyOf(residentVariant)
          )
        ) {
          residentCount -= booking.deferredCount;
        }
      }
      count += Math.max(0, residentCount);
    }
    return count;
  }

  function allows(modelName) {
    return ![modelName, residentAliasFor(modelName), catalogAliasFor(modelName)]
      .some((name) => {
        const key = keyOf(name);
        return key !== '' && fenced.has(key);
      });
  }

  return {
    allows,
    inFlightFor,
    /** Books one request. Returns its exact token, or false when a fence excludes it. */
    start(modelName, { deferResidentAlias = false } = {}) {
      const key = keyOf(modelName);
      if (!key || !allows(modelName)) return false;
      const booking = active.get(key) ?? { count: 0, deferredCount: 0 };
      booking.count += 1;
      if (deferResidentAlias) booking.deferredCount += 1;
      active.set(key, booking);
      return key;
    },
    end(token) {
      const key = keyOf(token);
      const booking = active.get(key);
      if (!booking) return;
      booking.count -= 1;
      if (booking.deferredCount > booking.count) booking.deferredCount = booking.count;
      if (booking.count > 0) active.set(key, booking);
      else active.delete(key);
    },
    tryAcquire(alias) {
      if (typeof alias !== 'string' || !alias.trim()) {
        throw new TypeError('model activity fence alias must be a non-empty string');
      }
      const key = keyOf(alias);
      if (fenced.has(key) || inFlightFor(alias) > 0) return null;
      fenced.add(key);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fenced.delete(key);
      };
    },
  };
}
