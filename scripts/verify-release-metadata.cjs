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
const channelArgument = process.argv.find((arg) => arg.startsWith('--channel='));
const channel = channelArgument ? channelArgument.slice('--channel='.length) : 'stable';

function isNumericIdentifier(value) {
  return /^(0|[1-9]\d*)$/.test(value);
}

function isIdentifier(value) {
  return /^[0-9A-Za-z-]+$/.test(value) &&
    !(value.length > 1 && value.startsWith('0') && /^\d+$/.test(value));
}

function isStrictSemver(value) {
  return parseSemver(value) !== null;
}

function parseSemver(value) {
  const [versionPart, build] = String(value).split('+');
  if (!versionPart || String(value).split('+').length > 2) return null;

  const hyphen = versionPart.indexOf('-');
  const core = hyphen === -1 ? versionPart : versionPart.slice(0, hyphen);
  const prereleaseText = hyphen === -1 ? '' : versionPart.slice(hyphen + 1);
  const coreParts = core.split('.');
  if (coreParts.length !== 3 || !coreParts.every(isNumericIdentifier)) return null;

  const prerelease = prereleaseText ? prereleaseText.split('.') : [];
  if (hyphen !== -1 && (!prerelease.length || prerelease.some((part) => !isIdentifier(part)))) {
    return null;
  }
  if (build !== undefined && (!build || !build.split('.').every((part) => /^[0-9A-Za-z-]+$/.test(part)))) {
    return null;
  }
  return { prerelease };
}

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
const canonicalEndpoint = 'https://github.com/joelst/flint/releases/latest/download/latest.json';
const latestEndpoint = updaterEndpoints.find((endpoint) => {
  try {
    const url = new URL(endpoint);
    return url.href === canonicalEndpoint;
  } catch {
    return false;
  }
});
const parsedExpected = parseSemver(expected);
const isPrerelease = Boolean(parsedExpected?.prerelease.length);
if (channel === 'stable' && isPrerelease) {
  console.error(`✗ ${expected} is a prerelease but the release channel is stable`);
  failed = true;
} else if (latestEndpoint) {
  console.log(
    channel === 'evaluation'
      ? `✓ exact application updater endpoint remains configured; publication channel is evaluation: ${latestEndpoint}`
      : `✓ exact updater endpoint configured for stable release: ${latestEndpoint}`,
  );
} else {
  console.error(`✗ updater configuration must use the exact canonical endpoint: ${canonicalEndpoint}`);
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`Release metadata verified for ${expected}.`);
