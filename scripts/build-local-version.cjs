#!/usr/bin/env node
'use strict';

const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isStrictSemver } = require('./release-metadata.cjs');

function createTauriConfig(version) {
  return JSON.stringify({ version }, null, 2);
}

function createTauriBuildArgs(configPath, extraArgs = []) {
  return ['build', '--no-sign', '--config', configPath, ...extraArgs];
}

function createBuildEnv(version, env = process.env) {
  return { ...env, VITE_FLINT_BUILD_VERSION: version };
}

function main(argv = process.argv.slice(2)) {
  const [version, ...extraArgs] = argv;
  if (!isStrictSemver(version)) {
    console.error('Usage: npm run tauri:build:local:version -- <semver> [tauri build options]');
    console.error('Example: npm run tauri:build:local:version -- 0.10.0');
    process.exitCode = 2;
    return;
  }
  if (extraArgs.some((arg) => arg === '--config' || arg === '-c' || arg.startsWith('--config='))) {
    console.error('Do not pass --config; this command supplies a temporary version override.');
    process.exitCode = 2;
    return;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'flint-local-build-'));
  const configPath = path.join(tempDir, 'tauri-version.json');
  try {
    writeFileSync(configPath, createTauriConfig(version));
    const tauriCli = require.resolve('@tauri-apps/cli/tauri.js');
    const result = spawnSync(
      process.execPath,
      [tauriCli, ...createTauriBuildArgs(configPath, extraArgs)],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: createBuildEnv(version),
      },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`Local Tauri build failed: ${error?.message || error}`);
    process.exitCode = 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = { createBuildEnv, createTauriBuildArgs, createTauriConfig };
