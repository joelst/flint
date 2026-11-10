/**
 * Windows x64 CUDA execution providers in Foundry Local 2.2.1+ no longer ship
 * the CUDA 12 / cuDNN 9 runtime. AddDllDirectory has to run in this Node
 * process before that provider is registered. PATH alone does not apply, and a
 * parent-process call does not apply to the sidecar. Other platforms skip it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CUDA_TOOLKIT_ROOT = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
const dllDirectoryCookies = [];
let addDllDirectoryFn = null;

function readNames(readdir, directory) {
  try {
    const entries = readdir(directory);
    return Array.isArray(entries) ? entries.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function versionRank(name) {
  const match = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(name);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareVersions(left, right) {
  const a = versionRank(left);
  const b = versionRank(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return 0;
}

/** A versioned toolkit root is CUDA 12 only. An unversioned custom root stays eligible. */
function isCuda12ToolkitRoot(root) {
  const name = String(root).trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const match = /^v(\d+)(?:\.|$)/i.exec(name);
  return !match || Number(match[1]) === 12;
}

/**
 * First existing CUDA 12 bin directory.
 * CUDA_PATH, then CUDA_PATH_V12_*, then Program Files v12.* newest first.
 *
 * @param {{ env?: NodeJS.ProcessEnv, exists?: (dir: string) => boolean, readdir?: (dir: string) => string[] }} [options]
 * @returns {string | null}
 */
export function resolveCudaBinDirectory({
  env = process.env,
  exists = (directory) => fs.existsSync(directory),
  readdir = (directory) => fs.readdirSync(directory),
} = {}) {
  const candidates = [];
  if (typeof env.CUDA_PATH === 'string' && env.CUDA_PATH.trim() && isCuda12ToolkitRoot(env.CUDA_PATH)) {
    candidates.push(path.win32.join(env.CUDA_PATH.trim(), 'bin'));
  }
  for (const key of Object.keys(env).filter((name) => /^CUDA_PATH_V12_/i.test(name)).sort()) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() && isCuda12ToolkitRoot(value)) {
      candidates.push(path.win32.join(value.trim(), 'bin'));
    }
  }
  const installed = readNames(readdir, CUDA_TOOLKIT_ROOT)
    .filter((name) => /^v12\./i.test(name))
    .sort(compareVersions);
  for (const version of installed) {
    candidates.push(path.win32.join(CUDA_TOOLKIT_ROOT, version, 'bin'));
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * In-process AddDllDirectory. Tests inject their own caller and never reach this.
 * A null cookie is a failure. The cookie is retained for the life of the process.
 *
 * @param {string} directory
 */
export async function addDllDirectory(directory) {
  if (process.platform !== 'win32') {
    throw new Error('AddDllDirectory is only available on Windows.');
  }
  if (!addDllDirectoryFn) {
    const bundledEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'koffi', 'index.js');
    const imported = await import(fs.existsSync(bundledEntry) ? pathToFileURL(bundledEntry).href : 'koffi');
    const koffi = imported.default ?? imported;
    const kernel32 = koffi.load('kernel32.dll');
    addDllDirectoryFn = kernel32.func('void * __stdcall AddDllDirectory(str16)');
  }
  const cookie = addDllDirectoryFn(directory);
  if (cookie == null || cookie === 0 || cookie === 0n) {
    throw new Error(`AddDllDirectory returned no directory cookie for ${directory}.`);
  }
  dllDirectoryCookies.push(cookie);
  return cookie;
}

/**
 * Prepare the CUDA runtime when this process is Windows x64.
 * A missing directory is an explicit CUDA failure. CPU registration continues.
 *
 * @param {{
 *   platform?: string,
 *   arch?: string,
 *   env?: NodeJS.ProcessEnv,
 *   exists?: (dir: string) => boolean,
 *   readdir?: (dir: string) => string[],
 *   addDllDirectory?: (dir: string) => unknown,
 * }} [options]
 * @returns {Promise<{ ok: boolean, required: boolean, directory?: string | null, reason?: string }>}
 */
export async function prepareCudaRuntime({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  exists = (directory) => fs.existsSync(directory),
  readdir = (directory) => fs.readdirSync(directory),
  addDllDirectory: addDirectory = addDllDirectory,
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    return { ok: true, required: false };
  }
  const directory = resolveCudaBinDirectory({ env, exists, readdir });
  if (!directory) {
    return {
      ok: false,
      required: true,
      directory: null,
      reason: 'CUDA 12 runtime directory was not found. Install CUDA 12 with cuDNN 9 in that bin directory before using the CUDA execution provider.',
    };
  }
  try {
    await addDirectory(directory);
  } catch (error) {
    return {
      ok: false,
      required: true,
      directory,
      reason: error?.message || String(error),
    };
  }
  return { ok: true, required: true, directory };
}
