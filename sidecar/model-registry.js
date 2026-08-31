// Resolving the model identifier an OpenAI client sends into something loadable.
//
// The Foundry service advertises variant ids in `GET /v1/models` (`qwen3-0.6b-generic-cpu`)
// and routes on that form, with or without the `:<version>` suffix. It does **not** route
// the friendly alias: a request naming `qwen2.5-0.5b` is rejected with "is not loaded" even
// while that exact model is resident (verified against a live service). The SDK loader is
// the mirror image — `catalog.getModel()` accepts **only** the alias and throws on a variant
// id. So the two halves of the job disagree about what a model is called, and neither
// accepts the other's vocabulary.
//
// Resolution therefore has to yield both parts: the alias to load, and the specific variant
// that was asked for. Dropping the variant would silently load a different one (a CPU build
// when the client asked for the CUDA build), and the forwarded request still names the
// original variant, so it would fail again with the same error it was meant to fix.
//
// An alias resolves with `variantId: null`, meaning "whatever the service picks". The
// gateway learns the answer from the loader and rewrites the replayed request to match,
// since the alias the client sent would never route on its own.
//
// Pure module: no SDK calls and no I/O, so the mapping rules are unit testable.

/** Variant ids carry a `:<version>` suffix that the /v1/models listing strips. */
export function stripVersion (id) {
  return String(id || '').replace(/:\d+$/, '');
}

/**
 * Build a lookup from every identifier form a client might send.
 *
 * Only models that are actually cached are indexed. The catalog also contains models that
 * are merely downloadable, and autoloading one of those would turn a stray request into a
 * multi-gigabyte download — the service never advertised them, so we do not accept them.
 *
 * @param {Array<{alias?: string, variants?: Array<{id?: string, cached?: boolean}>}>} models
 * @returns {Map<string, { alias: string, variantId: string|null }>}
 */
export function buildModelIndex (models) {
  const index = new Map();
  if (!Array.isArray(models)) return index;

  for (const model of models) {
    const alias = typeof model?.alias === 'string' ? model.alias : '';
    if (!alias) continue;

    const cachedVariants = (Array.isArray(model.variants) ? model.variants : [])
      .filter(v => v?.cached && typeof v.id === 'string' && v.id);

    if (cachedVariants.length === 0) continue;

    // The alias alone means "whatever the service would pick", so no variant is pinned.
    if (!index.has(alias)) index.set(alias, { alias, variantId: null });

    for (const variant of cachedVariants) {
      // Exact, versioned id: load precisely this one.
      if (!index.has(variant.id)) index.set(variant.id, { alias, variantId: variant.id });

      // Versionless id is what /v1/models advertises. Several cached versions can share
      // it; the highest version is the one a fresh install would have, so prefer it and
      // keep the choice deterministic rather than dependent on catalog order.
      const bare = stripVersion(variant.id);
      if (bare === variant.id) continue;
      const existing = index.get(bare);
      if (!existing || compareVersions(variant.id, existing.variantId) > 0) {
        index.set(bare, { alias, variantId: variant.id });
      }
    }
  }
  return index;
}

/** Compare the trailing `:<version>` of two variant ids. Missing sorts lowest. */
function compareVersions (a, b) {
  const va = Number(String(a || '').match(/:(\d+)$/)?.[1] ?? -1);
  const vb = Number(String(b || '').match(/:(\d+)$/)?.[1] ?? -1);
  return va - vb;
}

/**
 * Look up one identifier.
 *
 * @param {Map<string, { alias: string, variantId: string|null }>} index
 * @param {unknown} requested
 * @returns {{ alias: string, variantId: string|null }|null}
 */
export function resolveModelId (index, requested) {
  if (typeof requested !== 'string' || !requested.trim()) return null;
  const name = requested.trim();
  return index.get(name) ?? index.get(stripVersion(name)) ?? null;
}
