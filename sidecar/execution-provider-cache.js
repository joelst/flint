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
// provider. Confirmation is a later discoverEps, and a retry passes the
// failed names explicitly.

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

/**
 * Delete one provider cache. Returns true only when a directory was removed.
 * @param {string} epRoot
 * @param {unknown} epName
 * @returns {boolean}
 */
function isFileBusy (error) {
  const code = error?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/**
 * Delete one provider cache.
 * Returns true when the directory was removed, false when it was already
 * gone, and 'busy' when Windows still has a file in it loaded.
 * @param {string} epRoot
 * @param {unknown} epName
 * @returns {true|false|'busy'}
 */
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
  const names = new Set();
  const add = (name) => {
    const slug = providerCacheSlug(name);
    if (!slug || registered.has(slug)) return;
    names.add(name);
  };
  for (const ep of discovered ?? []) {
    if (ep && ep.isRegistered === false && ep.name) add(ep.name);
  }
  for (const name of providersWithUnregisteredCache(epRoot, discovered)) add(name);
  for (const name of extraNames) add(name);
  return [...names];
}

function reportedFailures (result) {
  const failed = Array.isArray(result?.failedEps) ? result.failedEps.filter(Boolean) : [];
  if (failed.length > 0) return failed;
  if (result?.success === false) return providerNamesInText(result?.status);
  return [];
}

/**
 * @param {{
 *   downloadAndRegister: (names: string[]|undefined, onProgress?: (name: string, pct: number) => void) => Promise<{ success?: boolean, failedEps?: string[], status?: string }|null|undefined>,
 *   onProgress?: (name: string, pct: number) => void,
 * }} deps
 * @param {string[]} names
 */
async function registerProviders (deps, names) {
  try {
    const result = await deps.downloadAndRegister(names.length ? names : undefined, deps.onProgress);
    return result ?? { success: false, failedEps: [], status: '' };
  } catch (error) {
    const status = error?.message || String(error);
    return { success: false, failedEps: providerNamesInText(status), status };
  }
}

/**
 * Replace providers that are not registered. A provider discover marks
 * registered is left alone, including when a status string mentions it as
 * available. A cache Windows will not delete is left out of the registration
 * batch, because Foundry 2.0.1 fails the whole batch when one provider fails.
 *
 * The SDK result is not proof. 1.2.4 can list available providers in the same
 * sentence as the failure, and 2.0.1 throws or returns the names that were
 * requested. After the attempt, discoverEps is the result. Nothing is sent to
 * Foundry when discover and the cache agree that every provider is ready.
 * Registration always names the providers; the no-name call registers one
 * preferred provider on 2.0.1.
 *
 * @param {{
 *   discover: () => Array<{ name?: string, isRegistered?: boolean }>|null|undefined,
 *   downloadAndRegister: (names: string[]|undefined, onProgress?: (name: string, pct: number) => void) => Promise<{ success?: boolean, failedEps?: string[], status?: string }|null|undefined>,
 *   removeCache: (name: string) => true|false|'busy'|Promise<true|false|'busy'>,
 *   onProgress?: (name: string, pct: number) => void,
 *   epRoot?: string|null,
 * }} deps
 */
export async function rebuildBrokenExecutionProviders (deps) {
  const removed = [];
  const attempted = [];
  const busy = [];
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
  const registrable = async (names) => {
    const ready = [];
    for (const name of names) {
      if (busy.includes(name)) continue;
      if (await classify(name) !== 'busy') ready.push(name);
    }
    return ready;
  };

  const broken = brokenProviderNames(deps.discover() ?? [], deps.epRoot);
  if (broken.length === 0) {
    return {
      removed,
      attempted,
      busy,
      result: {
        success: true,
        failedEps: [],
        registeredEps: [],
        status: 'No broken providers',
      },
    };
  }

  const first = await registrable(broken);
  let sdkResult = first.length
    ? await registerProviders(deps, first)
    : { success: true, failedEps: [], status: '' };
  rememberAttempt(first);

  const retryNames = brokenProviderNames(
    deps.discover() ?? [],
    deps.epRoot,
    reportedFailures(sdkResult),
  ).filter((name) => !busy.includes(name));
  const retry = await registrable(retryNames);
  if (retry.length) {
    sdkResult = await registerProviders(deps, retry);
    rememberAttempt(retry);
  }

  const stillBroken = brokenProviderNames(deps.discover() ?? [], deps.epRoot);
  return {
    removed,
    attempted,
    busy,
    result: {
      success: stillBroken.length === 0,
      failedEps: stillBroken,
      registeredEps: [],
      status: stillBroken.length
        ? (sdkResult?.status || 'Provider still not registered')
        : (sdkResult?.status || 'No broken providers'),
    },
  };
}
