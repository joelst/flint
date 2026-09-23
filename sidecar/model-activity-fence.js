export function createModelActivityFence({ resolveAliases, inFlightFor }) {
  if (typeof resolveAliases !== 'function' || typeof inFlightFor !== 'function') {
    throw new TypeError('model activity fence requires alias resolution and in-flight callbacks');
  }

  const fenced = new Set();

  return {
    allows(modelName) {
      const aliases = resolveAliases(modelName).map(
        (alias) => fenced.has(String(alias || '').trim().toLowerCase()),
      );
      return aliases.length === 0 ? fenced.size === 0 : !aliases.some(Boolean);
    },
    tryAcquire(alias) {
      if (typeof alias !== 'string' || !alias.trim()) {
        throw new TypeError('model activity fence alias must be a non-empty string');
      }
      const original = alias.trim();
      const normalized = original.toLowerCase();
      if (fenced.has(normalized) || inFlightFor(original) > 0) return null;
      fenced.add(normalized);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fenced.delete(normalized);
      };
    },
  };
}
