#!/usr/bin/env node
/**
 * Install deps in CI so the Foundry native cache is in place *before* the SDK
 * install script runs. A root `preinstall` cannot do that: dependency install
 * scripts run as packages are extracted, before any restore into
 * `node_modules/foundry-local-sdk` can survive.
 *
 * Sequence: extract packages without scripts → restore cache → run install
 * scripts (SDK skipIfPresent hits).
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(root, 'runtime', 'foundry-native-cache');
const DEST_DIR = path.join(root, 'node_modules', 'foundry-local-sdk', 'foundry-local-core');

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
const hadCache = dirHasFiles(CACHE_DIR);
run(process.execPath, [path.join(__dirname, 'hydrate-foundry-native.cjs'), '--restore']);
if (hadCache && !dirHasFiles(DEST_DIR)) {
  console.error('[ci-npm-ci] Foundry native cache was present but restore left dest empty');
  process.exit(1);
}
run('npm', ['rebuild']);
