#!/usr/bin/env node
/**
 * Copy Foundry native binaries between a CI cache directory and the SDK
 * install location. The SDK's install script skips nuget.org when
 * Microsoft.AI.Foundry.Local.Core.* is already present.
 *
 * Usage:
 *   node scripts/hydrate-foundry-native.cjs --restore
 *   node scripts/hydrate-foundry-native.cjs --save
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const CACHE_DIR = process.env.FLINT_FOUNDRY_CACHE_DIR
  || path.join(root, 'runtime', 'foundry-native-cache');
const DEST_DIR = process.env.FLINT_FOUNDRY_DEST_DIR
  || path.join(root, 'node_modules', 'foundry-local-sdk', 'foundry-local-core');
/** The SDK package: foundry-local-core's parent, where deps_versions.json lives. */
const SDK_ROOT = path.dirname(DEST_DIR);

const {
  describeRuntimeProblem,
  removeUnpinnedRuntimeFiles,
  runtimeProblems,
} = require('./foundry-runtime-pins.cjs');

function platformKeysIn(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isDirectory());
  } catch {
    return [];
  }
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
  return true;
}

function dirHasFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    const entries = fs.readdirSync(dir, { recursive: true });
    return entries.some((entry) => {
      const full = path.join(dir, entry);
      return fs.statSync(full).isFile();
    });
  } catch {
    return false;
  }
}

function restore() {
  if (!dirHasFiles(CACHE_DIR)) return;
  // Creating dest is not enough for a plain `npm ci`: the SDK installer runs as
  // the package is extracted. CI must restore after extract (see ci-npm-ci.cjs).
  fs.mkdirSync(DEST_DIR, { recursive: true });
  copyDir(CACHE_DIR, DEST_DIR);
  console.log(`[hydrate-foundry-native] restored cache into ${path.relative(root, DEST_DIR)}`);
  // The SDK installer skips a package whose file name exists, so a runtime that is not the
  // pinned build must go before it runs, or it ships.
  for (const removed of removeUnpinnedRuntimeFiles(SDK_ROOT)) {
    console.log(`[hydrate-foundry-native] removed cached runtime that is not the pinned build: ${path.relative(root, removed)}`);
  }
}

function save() {
  if (!dirHasFiles(DEST_DIR)) {
    console.log('[hydrate-foundry-native] no native payload to cache');
    return;
  }
  // A cache is reused by every later build with this key, so never save a runtime that is not
  // the pinned build.
  const problems = platformKeysIn(DEST_DIR).flatMap((platformKey) => runtimeProblems(SDK_ROOT, platformKey));
  if (problems.length) {
    for (const problem of problems) {
      console.log(`[hydrate-foundry-native] not saving: ${problem.role} ${path.relative(root, problem.file)} is ${describeRuntimeProblem(problem)}`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
  if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  copyDir(DEST_DIR, CACHE_DIR);
  console.log(`[hydrate-foundry-native] saved native payload to ${path.relative(root, CACHE_DIR)}`);
}

const mode = process.argv[2];
if (mode === '--restore') restore();
else if (mode === '--save') save();
else {
  console.error('Usage: node scripts/hydrate-foundry-native.cjs --restore|--save');
  process.exit(1);
}
