#!/usr/bin/env node
/**
 * Verify the version and release-channel metadata before a Flint handoff.
 *
 * Usage:
 *   node scripts/verify-release-metadata.cjs 0.7.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  CANONICAL_UPDATER_ENDPOINT,
  isCanonicalUpdaterEndpoint,
  isStrictSemver,
  validateReleaseInputs,
} = require('./release-metadata.cjs');

const root = path.resolve(__dirname, '..');
const expected = process.argv[2] || process.env.FLINT_RELEASE_VERSION;
const channelArgument = process.argv.find((arg) => arg.startsWith('--channel='));
const channel = channelArgument ? channelArgument.slice('--channel='.length) : 'stable';

if (!expected || !isStrictSemver(expected) || !['stable', 'evaluation'].includes(channel)) {
  console.error('Usage: node scripts/verify-release-metadata.cjs <version> [--channel=stable|evaluation]');
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readCargoVersion() {
  const cargo = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const match = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('Could not find the Cargo package version');
  return match[1];
}

const tauriConfig = readJson('src-tauri/tauri.conf.json');
const actual = {
  package: readJson('package.json').version,
  tauri: tauriConfig.version,
  cargo: readCargoVersion(),
};

let failed = false;
for (const [source, version] of Object.entries(actual)) {
  if (version !== expected) {
    console.error(`✗ ${source} version is ${version}; expected ${expected}`);
    failed = true;
  } else {
    console.log(`✓ ${source} version ${version}`);
  }
}

const updaterEndpoints = tauriConfig.plugins?.updater?.endpoints || [];
const latestEndpoint = updaterEndpoints.find((endpoint) => {
  return isCanonicalUpdaterEndpoint(endpoint);
});
const inputError = validateReleaseInputs(expected, channel);
if (inputError && inputError !== 'invalid version or release channel') {
  console.error(`✗ ${inputError}`);
  failed = true;
} else if (latestEndpoint) {
  console.log(
    channel === 'evaluation'
      ? `✓ exact application updater endpoint remains configured; publication channel is evaluation: ${latestEndpoint}`
      : `✓ exact updater endpoint configured for stable release: ${latestEndpoint}`,
  );
} else {
  console.error(`✗ updater configuration must use the exact canonical endpoint: ${CANONICAL_UPDATER_ENDPOINT}`);
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`Release metadata verified for ${expected}.`);
