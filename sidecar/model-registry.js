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

/**
 * Variant ids carry a `:<version>` suffix that the /v1/models listing strips.
 * @param {unknown} id
 * @returns {string}
 */
export function stripVersion (id) {
  return String(id || '').replace(/:\d+$/, '');
}

export const LOCAL_REGISTRATION_PROVIDER = 'LocalRegistration';

/**
 * @typedef {{
 *   alias?: unknown,
 *   id?: unknown,
 *   info?: Record<string, unknown>,
 *   variants?: unknown,
 *   isCached?: boolean
 * }} CatalogEntry
 */

/**
 * @param {{info?: {uri?: unknown, providerType?: unknown}}|null|undefined} entry
 * @returns {boolean}
 */
export function isLocalCatalogEntry (entry) {
  const uri = entry?.info?.uri;
  if (typeof uri === 'string' && uri.startsWith('local://')) return true;
  return entry?.info?.providerType === LOCAL_REGISTRATION_PROVIDER;
}

/**
 * List rows keep the `local://` uri the UI already uses. SDK 2.1.0 leaves that
 * field empty and reports `providerType: LocalRegistration` instead.
 *
 * @param {Record<string, unknown> | null | undefined} info
 * @param {string} [alias]
 */
export function localRegistrationInfo (info, alias) {
  const source = info && typeof info === 'object' ? info : {};
  if (source.providerType !== LOCAL_REGISTRATION_PROVIDER) return source;
  if (typeof source.uri === 'string' && source.uri.startsWith('local://')) return source;
  const name = typeof alias === 'string' && alias ? alias : source.alias;
  if (typeof name !== 'string' || !name) return source;
  return { ...source, uri: `local://${name}` };
}

/**
 * @template T
 * @param {() => T} read
 * @returns {T | undefined}
 */
function readField (read) {
  try {
    return read();
  } catch {
    // A native getter can throw. One unreadable row must not drop the rest of the catalog.
    return undefined;
  }
}

/** @param {CatalogEntry | null | undefined} model */
function cleanAlias (model) {
  const alias = readField(() => model?.alias);
  return typeof alias === 'string' ? alias.trim().toLowerCase() : '';
}

/** @param {CatalogEntry | null | undefined} model */
function cleanId (model) {
  const id = readField(() => model?.id);
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

/** @param {CatalogEntry | null | undefined} model */
function cleanTask (model) {
  const task = readField(() => model?.info?.task);
  return typeof task === 'string' && task.trim() ? task.trim() : '';
}

/** @param {CatalogEntry | null | undefined} model */
function variantCount (model) {
  try {
    return Array.isArray(model?.variants) ? model.variants.length : 0;
  } catch {
    return 0;
  }
}

/**
 * A local registration is one on-disk build. The public catalog's variant list
 * does not include it, so the index and the model list treat the registration
 * itself as its cached variant.
 *
 * @param {CatalogEntry} model
 */
export function indexableLocalModel (model) {
  if (variantCount(model) > 0) return model;
  const idValue = readField(() => model?.id);
  const aliasValue = readField(() => model?.alias);
  const id = typeof idValue === 'string' ? idValue : '';
  const alias = typeof aliasValue === 'string' ? aliasValue : '';
  if (!id || !alias) return model;
  return {
    alias,
    id,
    info: model?.info,
    isCached: true,
    variants: [{
      id,
      isCached: true,
      info: { cached: true },
    }],
  };
}

/**
 * Append local-catalog registrations the public snapshot does not already name.
 * A public row with no task and no variants is replaced by the registration
 * that carries the session task.
 *
 * @param {CatalogEntry[] | null | undefined} publicModels
 * @param {CatalogEntry[] | null | undefined} localModels
 */
export function mergeLocalRegistrations (publicModels, localModels) {
  const merged = [];
  const aliasAt = new Map();
  for (const model of Array.isArray(publicModels) ? publicModels : []) {
    aliasAt.set(cleanAlias(model), merged.length);
    merged.push(model);
  }
  const seenIds = new Set(merged.map(cleanId).filter(Boolean));
  for (const model of Array.isArray(localModels) ? localModels : []) {
    const alias = cleanAlias(model);
    const id = cleanId(model);
    const indexable = indexableLocalModel(model);
    if (alias && aliasAt.has(alias)) {
      const at = aliasAt.get(alias);
      const existing = merged[at];
      if (!cleanTask(existing) && variantCount(existing) === 0 && cleanTask(model)) {
        merged[at] = indexable;
      }
      continue;
    }
    if (id && seenIds.has(id)) continue;
    merged.push(indexable);
    if (alias) aliasAt.set(alias, merged.length - 1);
    if (id) seenIds.add(id);
  }
  return merged;
}

/**
 * Whether an SDK model or variant has its build in the local cache. The same predicate admits
 * a variant into the index and re-validates an autoload target, so the two cannot disagree.
 * A boolean native value is authoritative; otherwise the plain info snapshot is the fallback.
 */
/**
 * @param {{isCached?: boolean, info?: {cached?: boolean}}|null|undefined} model
 * @returns {boolean}
 */
export function isCachedModel (model) {
  return readCachedState(model).cached;
}

/**
 * @param {{isCached?: boolean, info?: {cached?: boolean}}|null|undefined} model
 * @returns {{cached: boolean, readable: boolean}}
 */
function readCachedState (model) {
  try {
    const cached = model?.isCached;
    if (typeof cached === 'boolean') return { cached, readable: true };
  } catch {
    // Fall through to the plain info snapshot.
  }
  try {
    const cached = model?.info?.cached;
    return typeof cached === 'boolean'
      ? { cached, readable: true }
      : { cached: false, readable: false };
  } catch {
    return { cached: false, readable: false };
  }
}

/**
 * Snapshot the native-backed catalog into plain data before publishing derived indexes.
 * One unreadable row or variant must not discard usable siblings or leak a partial index.
 *
 * @param {Array<{
 *   alias?: string,
 *   variants?: Array<{id?: string, isCached?: boolean, info?: {cached?: boolean}}>
 * }>} models
 * @returns {{
 *   models: Array<{alias: string, variants: Array<{id: string, cached: boolean}>}>,
 *   complete: boolean
 * }}
 */
export function normalizeCatalogModels (models) {
  const normalized = [];
  let complete = true;
  for (const model of Array.isArray(models) ? models : []) {
    try {
      const alias = typeof model?.alias === 'string' ? model.alias : '';
      if (!alias) {
        complete = false;
        continue;
      }
      const variants = [];
      for (const variant of Array.isArray(model?.variants) ? model.variants : []) {
        try {
          const id = typeof variant?.id === 'string' ? variant.id : '';
          const cachedState = readCachedState(variant);
          if (!cachedState.readable) {
            complete = false;
            continue;
          }
          if (id) {
            variants.push({ id, cached: cachedState.cached });
          } else {
            complete = false;
          }
        } catch {
          complete = false;
          // One native-backed variant getter must not discard usable sibling variants.
        }
      }
      normalized.push({ alias, variants });
    } catch {
      complete = false;
      // One native-backed row must not prevent other aliases from being indexed.
    }
  }
  return { models: normalized, complete };
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

/**
 * Snapshot cached-only native rows into plain data and retain whether every row was readable.
 *
 * @param {Array<{alias?: string, id?: string}>} models
 * @returns {{
 *   models: Array<{alias: string, id: string}>,
 *   complete: boolean,
 *   incompleteAliases: string[],
 *   unknownAliasFailure: boolean
 * }}
 */
export function normalizeCachedModels (models) {
  const normalized = [];
  let complete = true;
  const incompleteAliases = new Set();
  let unknownAliasFailure = false;
  for (const model of Array.isArray(models) ? models : []) {
    let alias = '';
    try {
      alias = typeof model?.alias === 'string' ? model.alias : '';
      const id = typeof model?.id === 'string' ? model.id : '';
      if (alias && id) {
        normalized.push({ alias, id });
      } else {
        complete = false;
        if (alias) {
          incompleteAliases.add(indexKey(alias));
        } else {
          unknownAliasFailure = true;
        }
      }
    } catch {
      complete = false;
      if (alias) {
        incompleteAliases.add(indexKey(alias));
      } else {
        unknownAliasFailure = true;
      }
    }
  }
  return {
    models: normalized,
    complete,
    incompleteAliases: [...incompleteAliases],
    unknownAliasFailure,
  };
}

/**
 * Group cached variant ids by normalized alias without trusting native-backed getters.
 * Catalog rows expose `variants`; cached-only inventory rows expose one `id` each.
 *
 * @param {Array<{
 *   alias?: string,
 *   id?: string,
 *   cached?: boolean,
 *   isCached?: boolean,
 *   info?: {cached?: boolean},
 *   variants?: Array<{
 *     id?: string,
 *     cached?: boolean,
 *     isCached?: boolean,
 *     info?: {cached?: boolean}
 *   }>
 * }>} models
 * @param {{ rowsAreCached?: boolean }} [options]
 * @returns {Map<string, string[]>}
 */
export function buildCachedVariantIdsByAlias (models, { rowsAreCached = false } = {}) {
  const byAlias = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    try {
      const alias = indexKey(model?.alias);
      if (!alias) continue;
      const variants = Array.isArray(model?.variants) ? model.variants : [model];
      for (const variant of variants) {
        try {
          const id = typeof variant?.id === 'string' ? variant.id : '';
          const cached = rowsAreCached || variant?.cached === true || isCachedModel(variant);
          if (!id || !cached) continue;
          const ids = byAlias.get(alias) || [];
          if (!ids.includes(id)) ids.push(id);
          byAlias.set(alias, ids);
        } catch {
          // One native-backed variant getter must not discard usable sibling variants.
        }
      }
    } catch {
      // One native-backed row must not prevent other aliases from being classified.
    }
  }
  return byAlias;
}

/** Index keys ignore case; the values keep the catalog's own spelling. */
/** @param {unknown} name */
function indexKey (name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * Compare the trailing `:<version>` of two variant ids. Missing sorts lowest.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {number}
 */
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
