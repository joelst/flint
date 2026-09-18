#!/usr/bin/env node
/**
 * Install deps in CI so the Foundry native cache is in place *before* the SDK
 * install script runs. Root `preinstall` is too early: `npm ci` deletes
 * node_modules, runs preinstall, then extracts foundry-local-sdk (wiping any
 * restore) and only then runs the SDK's skipIfPresent installer.
 *
 * Sequence: extract packages without scripts → restore cache → run install
 * scripts (SDK skipIfPresent hits).
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function run (command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.status) process.exit(result.status ?? 1);
}

run('npm', ['ci', '--ignore-scripts']);
run(process.execPath, [path.join(__dirname, 'hydrate-foundry-native.cjs'), '--restore']);
run('npm', ['rebuild']);
