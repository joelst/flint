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

// Tauri 2's `-c/--config` is repeatable and merged in order, so a later config
// replaces the temporary version. Clap accepts the attached short form (`-cfile.json`).
function isConfigOverrideArg(arg) {
  return arg === '--config'
    || (typeof arg === 'string' && arg.startsWith('--config='))
    || (typeof arg === 'string' && arg.startsWith('-c') && !arg.startsWith('--'));
}

function tauriArgsBeforeRunner(extraArgs) {
  const separator = extraArgs.indexOf('--');
  return separator === -1 ? extraArgs : extraArgs.slice(0, separator);
}

function main(argv = process.argv.slice(2), deps = {}) {
  const io = {
    mkdtempSync,
    rmSync,
    writeFileSync,
    spawnSync,
    resolveTauriCli: () => require.resolve('@tauri-apps/cli/tauri.js'),
    cwd: process.cwd(),
    execPath: process.execPath,
    env: process.env,
    tmpdir: tmpdir(),
    logError: (line) => console.error(line),
    ...deps,
  };

  const [version, ...extraArgs] = argv;
  if (!isStrictSemver(version)) {
    io.logError('Usage: npm run tauri:build:local:version -- <semver> [tauri build options]');
    io.logError('Example: npm run tauri:build:local:version -- 0.10.0');
    return 2;
  }
  if (tauriArgsBeforeRunner(extraArgs).some(isConfigOverrideArg)) {
    io.logError('Do not pass --config or -c; this command supplies a temporary version override.');
    return 2;
  }

  const tempDir = io.mkdtempSync(path.join(io.tmpdir, 'flint-local-build-'));
  const configPath = path.join(tempDir, 'tauri-version.json');
  try {
    io.writeFileSync(configPath, createTauriConfig(version));
    const result = io.spawnSync(
      io.execPath,
      [io.resolveTauriCli(), ...createTauriBuildArgs(configPath, extraArgs)],
      {
        cwd: io.cwd,
        stdio: 'inherit',
        env: createBuildEnv(version, io.env),
      },
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
    io.logError(`Local Tauri build failed: ${error?.message || error}`);
    return 1;
  } finally {
    io.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  createBuildEnv,
  createTauriBuildArgs,
  createTauriConfig,
  isConfigOverrideArg,
  main,
};
