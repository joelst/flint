// On-disk cache for a downloadable Foundry execution provider.
//
// Foundry 1.2.4 and 2.0.1 both keep a downloaded provider under
// ~/.${appName}/ep/<slug>-ep. CUDAExecutionProvider is cuda-ep;
// WebGpuExecutionProvider is webgpu-ep. A provider that failed to register
// often still has that directory, and the next registration loads the same
// files again. Removing the directory is what makes the following download a
// new copy. CPU has no such directory.
//
// 1.2.4 returns { failedEps } for a partial failure. 2.0.1 throws, and a
// successful return always has failedEps: [] with registeredEps equal to the
// names that were requested. A call with no names registers one preferred
// provider. A provider is one cache slug. Recheck remembers every slug that
// was not registered at the start, and a later discoverEps is the only proof
// that slug is registered. Deleting the directory, or Foundry omitting the
// provider after that delete, is not success. Each native call names one
// provider, because 2.0.1 fails the whole call when one provider fails.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Directory name Foundry uses for one provider, or null when this name must
 * not be mapped onto a cache folder.
 * @param {unknown} epName
 * @returns {string|null}
 */
export function providerCacheSlug (epName) {
  const raw = String(epName || '').trim();
  const prefix = raw.replace(/ExecutionProvider$/i, '');
  if (!prefix || prefix === raw || !/^[A-Za-z0-9]+$/.test(prefix)) return null;
  const slug = prefix.toLowerCase();
  if (slug === 'cpu') return null;
  return `${slug}-ep`;
}

/**
 * Absolute cache directory for one provider, or null when the name is not a
 * single folder inside epRoot.
 * @param {string} epRoot
 * @param {unknown} epName
 * @returns {string|null}
 */
export function providerCacheDirectory (epRoot, epName) {
  const slug = providerCacheSlug(epName);
  if (!slug) return null;
  const root = path.resolve(epRoot);
  const dir = path.resolve(root, slug);
  const rel = path.relative(root, dir);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  if (rel !== slug) return null;
  return dir;
}

/** True when Windows still has the cache file loaded. */
function isFileBusy (error) {
  const code = error?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/**
 * Delete one provider cache.
 * Returns true when the directory was removed, false when it was already
 * gone, and 'busy' when Windows still has a file in it loaded.
 * A loaded DLL cannot be replaced in this process, so the caller must leave
 * that provider out of the registration batch.
 * @param {string} epRoot
 * @param {unknown} epName
 * @returns {Promise<true|false|'busy'>}
 */
export async function removeProviderCache (epRoot, epName) {
  const dir = providerCacheDirectory(epRoot, epName);
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isFileBusy(error)) return 'busy';
    throw error;
  }
}

const KNOWN_PROVIDERS = [
  'CUDAExecutionProvider',
  'WebGpuExecutionProvider',
  'QNNExecutionProvider',
  'OpenVINOExecutionProvider',
  'DmlExecutionProvider',
  'NvTensorRTRTXExecutionProvider',
];

/**
 * Execution-provider names mentioned in a 1.2.4 status string or a 2.0.1 throw.
 * @param {unknown} text
 * @returns {string[]}
 */
export function providerNamesInText (text) {
  return [...new Set(String(text || '').match(/[A-Za-z0-9]+ExecutionProvider/g) ?? [])];
}

/**
 * Known provider caches on disk that discover does not currently mark registered.
 * A broken CUDA install is sometimes absent from discoverEps entirely.
 * @param {string|undefined|null} epRoot
 * @param {Array<{ name?: string, isRegistered?: boolean }>|null|undefined} discovered
 * @returns {string[]}
 */
function registeredCacheSlugs (discovered) {
  const slugs = new Set();
  for (const ep of discovered ?? []) {
    if (!ep?.isRegistered || !ep.name) continue;
    const slug = providerCacheSlug(ep.name);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

export function providersWithUnregisteredCache (epRoot, discovered) {
  const registered = registeredCacheSlugs(discovered);
  if (!epRoot || !fs.existsSync(epRoot)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(epRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = KNOWN_PROVIDERS.find((name) => providerCacheSlug(name) === entry.name);
    if (match && !registered.has(entry.name)) names.push(match);
  }
  return names;
}

/**
 * @param {Array<{ name?: string, isRegistered?: boolean }>|null|undefined} discovered
 * @param {string|undefined|null} epRoot
 * @param {string[]} [extraNames]
 * @returns {string[]}
 */
function brokenProviderNames (discovered, epRoot, extraNames = []) {
  const registered = registeredCacheSlugs(discovered);
  const bySlug = new Map();
  const add = (name) => {
    const slug = providerCacheSlug(name);
    if (!slug || registered.has(slug) || bySlug.has(slug)) return;
    bySlug.set(slug, name);
  };
  for (const ep of discovered ?? []) {
    if (ep && ep.isRegistered === false && ep.name) add(ep.name);
  }
  for (const name of providersWithUnregisteredCache(epRoot, discovered)) add(name);
  for (const name of extraNames) add(name);
  return [...bySlug.values()];
}

/**
 * Candidate names whose cache slug the latest discover does not show as
 * registered. The first spelling wins, so two names for one directory stay
 * one provider. Names discover no longer lists stay in the result.
 * @param {string[]} candidates
 * @param {Array<{ name?: string, isRegistered?: boolean }>|null|undefined} discovered
 * @returns {string[]}
 */
function stillUnregistered (candidates, discovered) {
  const registered = registeredCacheSlugs(discovered);
  const bySlug = new Map();
  for (const name of candidates) {
    const slug = providerCacheSlug(name);
    if (!slug || registered.has(slug) || bySlug.has(slug)) continue;
    bySlug.set(slug, name);
  }
  return [...bySlug.values()];
}

/**
 * @param {{
 *   downloadAndRegister: (names: string[], onProgress?: (name: string, pct: number) => void) => Promise<{ success?: boolean, failedEps?: string[], status?: string }|null|undefined>,
 *   onProgress?: (name: string, pct: number) => void,
 * }} deps
 * @param {string[]} names
 */
async function registerProviders (deps, names) {
  if (!names.length) return { success: true, failedEps: [], status: '' };
  try {
    const result = await deps.downloadAndRegister(names, deps.onProgress);
    return result ?? { success: false, failedEps: [...names], status: '' };
  } catch (error) {
    const status = error?.message || String(error);
    return { success: false, failedEps: [...names], status };
  }
}

/**
 * Replace providers that are not registered. A provider discover marks
 * registered is left alone, including when a status string mentions it as
 * available. Status text is not a list of providers to delete.
 *
 * Each provider is registered by itself. Foundry 2.0.1 fails the whole call
 * when one name fails, so a locked or broken provider must not share a call
 * with the others. A cache Windows will not delete stays out of that call.
 *
 * The SDK result is not proof. The names that were broken, attempted, or
 * busy stay failed until a later discoverEps shows that cache slug
 * registered. Nothing is sent to Foundry when discover and the cache agree
 * that every provider is ready. Registration always names the provider; the
 * no-name call registers one preferred provider on 2.0.1.
 *
 * @param {{
 *   discover: () => Array<{ name?: string, isRegistered?: boolean }>|null|undefined,
 *   downloadAndRegister: (names: string[], onProgress?: (name: string, pct: number) => void) => Promise<{ success?: boolean, failedEps?: string[], status?: string }|null|undefined>,
 *   removeCache: (name: string) => true|false|'busy'|Promise<true|false|'busy'>,
 *   onProgress?: (name: string, pct: number) => void,
 *   epRoot?: string|null,
 * }} deps
 */
export async function rebuildBrokenExecutionProviders (deps) {
  const removed = [];
  const attempted = [];
  const busy = [];
  const registeredNames = (discovered) => (discovered ?? [])
    .filter((ep) => ep?.isRegistered && ep.name)
    .map((ep) => ep.name);
  const classify = async (name) => {
    let outcome;
    try {
      outcome = await deps.removeCache(name);
    } catch (error) {
      if (!isFileBusy(error)) throw error;
      outcome = 'busy';
    }
    if (outcome === 'busy') {
      if (!busy.includes(name)) busy.push(name);
      return 'busy';
    }
    if (outcome) {
      removed.push(name);
      return 'removed';
    }
    return 'missing';
  };
  const rememberAttempt = (names) => {
    for (const name of names) {
      if (name && !attempted.includes(name)) attempted.push(name);
    }
  };
  let sdkResult = { success: true, failedEps: [], status: '' };
  const registerEach = async (names) => {
    for (const name of names) {
      if (busy.includes(name)) continue;
      const outcome = await classify(name);
      if (outcome === 'busy') continue;
      const result = await registerProviders(deps, [name]);
      rememberAttempt([name]);
      if (result?.success === false || sdkResult.success !== false) sdkResult = result;
    }
  };

  const initial = deps.discover() ?? [];
  const broken = brokenProviderNames(initial, deps.epRoot);
  if (broken.length === 0) {
    return {
      removed,
      attempted,
      busy,
      result: {
        success: true,
        failedEps: [],
        registeredEps: registeredNames(initial),
        status: 'No broken providers',
      },
    };
  }

  await registerEach(broken);
  const retryNames = stillUnregistered([...broken, ...attempted], deps.discover() ?? [])
    .filter((name) => !busy.includes(name));
  await registerEach(retryNames);

  const final = deps.discover() ?? [];
  const stillBroken = stillUnregistered(
    [...broken, ...attempted, ...busy, ...brokenProviderNames(final, deps.epRoot)],
    final,
  );
  return {
    removed,
    attempted,
    busy,
    result: {
      success: stillBroken.length === 0,
      failedEps: stillBroken,
      registeredEps: registeredNames(final),
      status: stillBroken.length
        ? (sdkResult?.status || 'Provider still not registered')
        : (sdkResult?.status || 'No broken providers'),
    },
  };
}
