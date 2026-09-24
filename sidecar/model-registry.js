// Resolving the model identifier an OpenAI client sends into something loadable.
//
// The Foundry service advertises versionless variant ids in `GET /v1/models`
// (`qwen3-0.6b-generic-cpu`) but routes only the exact, case-sensitive loaded variant id
// (`qwen3-0.6b-generic-cpu:4`). The friendly alias, the versionless id, and any other casing
// get `404 Model not found` even while that exact model is resident (SDK 2.0.1, verified
// against a live service; SDK 1.x accepted the versionless form). The SDK loader is the
// mirror image — `catalog.getModel()` accepts **only** the alias and throws on a variant id.
// So the two halves of the job disagree about what a model is called, and neither accepts
// the other's vocabulary.
//
// Lookups here ignore case, since the replay always sends the canonical id the loader
// reports. An explicit `:<version>` resolves exactly or not at all: a client that asked for
// version 999 is not quietly served version 4. A versionless id resolves to the highest
// cached version, the one a fresh install would have.
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

export function isLocalCatalogEntry (entry) {
  return typeof entry?.info?.uri === 'string' && entry.info.uri.startsWith('local://');
}

/**
 * Whether an SDK model or variant has its build in the local cache. The same predicate admits
 * a variant into the index and re-validates an autoload target, so the two cannot disagree.
 * The native getter can throw; the info snapshot is the fallback.
 */
export function isCachedModel (model) {
  try {
    return !!model?.isCached;
  } catch {
    return !!model?.info?.cached;
  }
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
    const aliasKey = indexKey(alias);
    if (!index.has(aliasKey)) index.set(aliasKey, { alias, variantId: null });

    for (const variant of cachedVariants) {
      // Exact, versioned id: load precisely this one.
      const exactKey = indexKey(variant.id);
      if (!index.has(exactKey)) index.set(exactKey, { alias, variantId: variant.id });

      // Versionless id is what /v1/models advertises. Several cached versions can share
      // it; the highest version is the one a fresh install would have, so prefer it and
      // keep the choice deterministic rather than dependent on catalog order.
      const bare = stripVersion(variant.id);
      if (bare === variant.id) continue;
      // BYOM commonly uses `alias:version` as the variant id. Its bare form is the
      // friendly alias, which must keep variantId:null so an unknown `alias:999`
      // cannot silently fall back to a different cached version.
      const bareKey = indexKey(bare);
      if (bareKey === aliasKey) continue;
      const existing = index.get(bareKey);
      if (!existing || compareVersions(variant.id, existing.variantId) > 0) {
        index.set(bareKey, { alias, variantId: variant.id });
      }
    }
  }
  return index;
}

/**
 * Build the same lookup from the SDK's cached-only inventory, whose rows are
 * individual variants rather than aliases containing a variants array.
 *
 * @param {Array<{alias?: string, id?: string}>} models
 * @returns {Map<string, { alias: string, variantId: string|null }>}
 */
export function buildCachedModelIndex (models) {
  const normalized = [];
  for (const model of Array.isArray(models) ? models : []) {
    try {
      normalized.push({
        alias: model?.alias,
        variants: [{ id: model?.id, cached: true }],
      });
    } catch {
      // Native-backed SDK getters can fail independently; keep usable cached rows.
    }
  }
  return buildModelIndex(normalized);
}

/** Index keys ignore case; the values keep the catalog's own spelling. */
function indexKey (name) {
  return String(name || '').trim().toLowerCase();
}

/** Compare the trailing `:<version>` of two variant ids. Missing sorts lowest. */
function compareVersions (a, b) {
  const va = Number(String(a || '').match(/:(\d+)$/)?.[1] ?? -1);
  const vb = Number(String(b || '').match(/:(\d+)$/)?.[1] ?? -1);
  return va - vb;
}

/**
 * Look up one identifier: an alias, an exact variant id, or a versionless variant id, in
 * any casing. An explicit `:<version>` that is not cached resolves to nothing rather than
 * to another version.
 *
 * @param {Map<string, { alias: string, variantId: string|null }>} index
 * @param {unknown} requested
 * @returns {{ alias: string, variantId: string|null }|null}
 */
export function resolveModelId (index, requested) {
  if (typeof requested !== 'string' || !requested.trim()) return null;
  // Exact only. An alias and a versionless id are keys in their own right, so they resolve
  // here; an explicit `:<version>` that is not cached resolves to nothing rather than to
  // another version, so a client that asked for version 999 is not quietly served version 1.
  return index.get(indexKey(requested)) ?? null;
}
