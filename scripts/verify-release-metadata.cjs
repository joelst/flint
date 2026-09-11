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

const root = path.resolve(__dirname, '..');
const expected = process.argv[2] || process.env.FLINT_RELEASE_VERSION;

if (!expected || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error('Usage: node scripts/verify-release-metadata.cjs <version>');
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

const actual = {
  package: readJson('package.json').version,
  tauri: readJson('src-tauri/tauri.conf.json').version,
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

const updaterEndpoints = readJson('src-tauri/tauri.conf.json').plugins?.updater?.endpoints || [];
const latestEndpoint = updaterEndpoints.find((endpoint) => endpoint.includes('/releases/latest/'));
if (expected.includes('-') && latestEndpoint) {
  console.error(
    `✗ ${expected} is a prerelease but updater endpoint targets releases/latest: ${latestEndpoint}`,
  );
  failed = true;
} else if (latestEndpoint) {
  console.log(`✓ updater endpoint uses published latest release: ${latestEndpoint}`);
}

if (failed) {
  process.exit(1);
}

console.log(`Release metadata verified for ${expected}.`);
