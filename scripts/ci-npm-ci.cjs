#!/usr/bin/env node
/**
 * Install deps in CI so the Foundry native cache is in place *before* the SDK
 * install script runs. A root `preinstall` cannot do that: dependency install
 * scripts run as packages are extracted, before any restore into
 * `node_modules/foundry-local-sdk` can survive.
 *
 * Sequence: extract packages without scripts → restore cache → run install
 * scripts (the SDK installer skips downloading artifacts already present in
 * its prebuilds dir). An ONNX Runtime DLL whose FileVersion is not the one
 * pinned in deps_versions.json is removed first, so a leftover from the other
 * Foundry SDK cannot satisfy that skip.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const DEST_DIR = path.join(root, 'node_modules', 'foundry-local-sdk', 'prebuilds');

function dirHasFiles (dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir, { recursive: true }).some((entry) => {
      return fs.statSync(path.join(dir, entry)).isFile();
    });
  } catch {
    return false;
  }
}

function run (command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['ci', '--ignore-scripts']);
// SDK 2.x ships its own natives in the tarball; an empty prebuilds dir means the
// package never extracted, and restoring into it would hide that.
if (!dirHasFiles(DEST_DIR)) {
  console.error(`[ci-npm-ci] ${path.relative(root, DEST_DIR)} is empty after npm ci`);
  process.exit(1);
}
// Snapshot what the tarball shipped so the saved cache carries only the files the
// SDK installer downloads.
run(process.execPath, [path.join(__dirname, 'hydrate-foundry-native.cjs'), '--baseline']);
// Refuses a cache saved for a different SDK/runtime version and exits non-zero if
// a matching cache fails to land.
run(process.execPath, [path.join(__dirname, 'hydrate-foundry-native.cjs'), '--restore']);
const { removeUnpinnedRuntimeFiles } = require('./foundry-native-payload.cjs');
const removed = removeUnpinnedRuntimeFiles(path.join(root, 'node_modules', 'foundry-local-sdk'));
if (removed.length > 0) {
  console.log(
    `[ci-npm-ci] removed ${removed.length} ONNX Runtime file(s) that do not match this SDK`,
  );
}
run('npm', ['rebuild']);
