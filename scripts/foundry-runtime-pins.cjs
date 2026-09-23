// ONNX Runtime files in foundry-local-sdk/foundry-local-core/<platformKey>/ that must be the
// builds deps_versions.json pins.
//
// The SDK installer skips a NuGet package when that package's main file name already exists,
// so a runtime restored from a CI cache or left by another SDK version is packaged as-is.
// A 0.9.2 build shipped the 2.0.1 runtime (ORT 1.28, GenAI 0.15) beside Foundry 1.2.4's core
// that way, and the 1.26 CUDA provider 1.2.4 downloads then failed to load (Error 1114).
//
// Windows records the version in the DLL's FileVersion resource. ORT 1.26 builds put a date
// in the patch field (1.26.20260520.2...) while 1.28 builds do not (1.28.0.20260724...), so
// only major.minor is compared; that is what separates one SDK's runtime from another's.
// macOS and Linux libraries carry no such resource and are not checked here.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} sdkRoot
 * @returns {{ ortVersion: string, genaiVersion: string }|null}
 */
function readRuntimePins (sdkRoot) {
  try {
    const deps = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'deps_versions.json'), 'utf8'));
    const ortVersion = deps?.onnxruntime?.version;
    const genaiVersion = deps?.['onnxruntime-genai']?.version;
    if (typeof ortVersion !== 'string' || typeof genaiVersion !== 'string') return null;
    return { ortVersion, genaiVersion };
  } catch {
    return null;
  }
}

/**
 * Files one NuGet package installs, with the version it must have. The package is reinstalled
 * only when its first file is missing, so a group is removed as a whole.
 * @param {{ ortVersion: string, genaiVersion: string }} pins
 */
function windowsRuntimeGroups (pins) {
  return [
    { role: 'ONNX Runtime', version: pins.ortVersion, files: ['onnxruntime.dll', 'onnxruntime_providers_shared.dll'] },
    { role: 'ONNX Runtime GenAI', version: pins.genaiVersion, files: ['onnxruntime-genai.dll'] },
  ];
}

/**
 * FileVersion from a Windows version resource, or null when there is none.
 * @param {Buffer} buffer
 * @returns {string|null}
 */
function readUtf16FileVersion (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const key = Buffer.from('FileVersion', 'utf16le');
  let at = buffer.indexOf(key);
  while (at !== -1) {
    let pos = at + key.length;
    while (pos + 1 < buffer.length && buffer.readUInt16LE(pos) === 0) pos += 2;
    let value = '';
    for (let i = pos; i + 1 < buffer.length && value.length < 80; i += 2) {
      const code = buffer.readUInt16LE(i);
      if (code === 0) break;
      if (code < 32 || code > 126) {
        value = '';
        break;
      }
      value += String.fromCharCode(code);
    }
    if (/^\d+\.\d+/.test(value)) return value;
    at = buffer.indexOf(key, at + 2);
  }
  return null;
}

/** @param {string} version */
function majorMinor (version) {
  const [major, minor] = String(version).split('.');
  return `${major}.${minor}`;
}

/**
 * Why one runtime file is not the pinned build, or null when it is.
 * @param {string} filePath
 * @param {string} version
 * @returns {null|{ reason: 'missing'|'unknown-version'|'wrong-version', fileVersion: string|null }}
 */
function runtimeFileProblem (filePath, version) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return { reason: 'missing', fileVersion: null };
  }
  if (buffer.length === 0) return { reason: 'missing', fileVersion: null };
  const fileVersion = readUtf16FileVersion(buffer);
  if (!fileVersion) return { reason: 'unknown-version', fileVersion: null };
  if (majorMinor(fileVersion) !== majorMinor(version)) return { reason: 'wrong-version', fileVersion };
  return null;
}

/**
 * Runtime files for one Windows platform that are missing or not the pinned build.
 * @param {string} sdkRoot
 * @param {string} platformKey
 */
function runtimeProblems (sdkRoot, platformKey) {
  if (!platformKey.startsWith('win32-')) return [];
  const pins = readRuntimePins(sdkRoot);
  if (!pins) return [{ role: 'deps_versions.json', file: 'deps_versions.json', reason: 'missing', fileVersion: null, version: null }];
  const dir = path.join(sdkRoot, 'foundry-local-core', platformKey);
  const problems = [];
  for (const group of windowsRuntimeGroups(pins)) {
    for (const file of group.files) {
      const problem = runtimeFileProblem(path.join(dir, file), group.version);
      if (problem) problems.push({ role: group.role, file: path.join(dir, file), version: group.version, ...problem });
    }
  }
  return problems;
}

/** @param {{ reason: string, fileVersion: string|null, version: string|null }} problem */
function describeRuntimeProblem (problem) {
  if (problem.reason === 'missing') return 'missing';
  if (problem.reason === 'unknown-version') return `missing a readable FileVersion, expected ${problem.version}`;
  return `version ${problem.fileVersion}, not ${problem.version}`;
}

/**
 * Delete every Windows runtime package whose files are present but not the pinned build, so
 * the SDK installer downloads the pinned one instead of skipping it.
 * @param {string} sdkRoot
 * @returns {string[]} removed file paths
 */
function removeUnpinnedRuntimeFiles (sdkRoot) {
  const pins = readRuntimePins(sdkRoot);
  if (!pins) return [];
  const coreRoot = path.join(sdkRoot, 'foundry-local-core');
  let platformKeys = [];
  try {
    platformKeys = fs.readdirSync(coreRoot).filter((name) => name.startsWith('win32-'));
  } catch {
    return [];
  }
  const removed = [];
  for (const platformKey of platformKeys) {
    const dir = path.join(coreRoot, platformKey);
    for (const group of windowsRuntimeGroups(pins)) {
      const present = group.files.filter((file) => fs.existsSync(path.join(dir, file)));
      const stale = present.some((file) => runtimeFileProblem(path.join(dir, file), group.version));
      if (!stale) continue;
      for (const file of present) {
        const filePath = path.join(dir, file);
        fs.rmSync(filePath, { force: true });
        removed.push(filePath);
      }
    }
  }
  return removed;
}

module.exports = {
  describeRuntimeProblem,
  readRuntimePins,
  readUtf16FileVersion,
  removeUnpinnedRuntimeFiles,
  runtimeProblems,
};
