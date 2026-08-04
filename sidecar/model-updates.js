function variantTrackKey(variant) {
  const name = String(variant?.name || '').trim();
  if (name) return `name:${name}`;

  const deviceType = String(variant?.deviceType || 'unknown').trim().toLowerCase();
  const executionProvider = String(variant?.executionProvider || 'unknown').trim().toLowerCase();
  return `runtime:${deviceType}:${executionProvider}`;
}

function numericVersion(variant) {
  const version = Number(variant?.version);
  return Number.isFinite(version) ? version : null;
}

/**
 * Mark the newest cached variant in each acceleration-specific track when a
 * newer uncached catalog variant is available.
 */
export function annotateVariantUpdates(variants) {
  const rows = Array.isArray(variants)
    ? variants.map((variant) => ({ ...variant, update: null }))
    : [];
  const groups = new Map();

  for (const row of rows) {
    const key = variantTrackKey(row);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const versioned = group.filter((row) => numericVersion(row) !== null);
    if (versioned.length === 0) continue;

    const latest = versioned.reduce((best, row) =>
      numericVersion(row) > numericVersion(best) ? row : best
    );
    if (latest.cached) continue;

    const cached = versioned.filter((row) => row.cached);
    if (cached.length === 0) continue;

    const current = cached.reduce((best, row) =>
      numericVersion(row) > numericVersion(best) ? row : best
    );
    if (numericVersion(latest) <= numericVersion(current)) continue;

    current.update = {
      currentVersion: numericVersion(current),
      latestVersion: numericVersion(latest),
      latestVariantId: latest.id,
      deviceType: latest.deviceType ?? current.deviceType ?? null,
      executionProvider: latest.executionProvider ?? current.executionProvider ?? null,
    };
  }

  return rows;
}
