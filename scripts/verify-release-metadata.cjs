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
  normalizeVersion,
  validateReleaseInputs,
} = require('./release-metadata.cjs');

const root = path.resolve(__dirname, '..');
function readJson(rootPath, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootPath, relativePath), 'utf8'));
}

function readCargoVersion(rootPath) {
  const cargo = fs.readFileSync(path.join(rootPath, 'src-tauri', 'Cargo.toml'), 'utf8');
  const packageStart = cargo.indexOf('[package]');
  if (packageStart === -1) throw new Error('Could not find the Cargo package version');
  const afterPackage = cargo.slice(packageStart + '[package]'.length);
  const nextSection = afterPackage.search(/^\[[^\]]+\]\s*$/m);
  const packageSection = nextSection === -1 ? afterPackage : afterPackage.slice(0, nextSection);
  const match = packageSection.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('Could not find the Cargo package version');
  return match[1];
}

function verifyReleaseMetadata(rootPath, rawExpected, channel, log = console) {
  const expected = normalizeVersion(rawExpected);
  const inputError = validateReleaseInputs(expected, channel);
  if (inputError) {
    log.error(`✗ ${inputError}`);
    return false;
  }

  let tauriConfig;
  let cargoVersion;
  let packageVersion;
  try {
    tauriConfig = readJson(rootPath, 'src-tauri/tauri.conf.json');
    packageVersion = readJson(rootPath, 'package.json').version;
    cargoVersion = readCargoVersion(rootPath);
  } catch (error) {
    log.error(`✗ could not read release metadata: ${error.message}`);
    return false;
  }
  const actual = {
    package: packageVersion,
    tauri: tauriConfig.version,
    cargo: cargoVersion,
  };
  let failed = false;
  for (const [source, version] of Object.entries(actual)) {
    if (version !== expected) {
      log.error(`✗ ${source} version is ${version}; expected ${expected}`);
      failed = true;
    } else {
      log.log(`✓ ${source} version ${version}`);
    }
  }

  const updaterEndpoints = tauriConfig.plugins?.updater?.endpoints || [];
  if (updaterEndpoints.length !== 1 || !isCanonicalUpdaterEndpoint(updaterEndpoints[0])) {
    log.error(`✗ updater configuration must use exactly the canonical endpoint: ${CANONICAL_UPDATER_ENDPOINT}`);
    failed = true;
  } else {
    log.log(
      channel === 'evaluation'
        ? `✓ exact application updater endpoint remains configured; publication channel is evaluation: ${updaterEndpoints[0]}`
        : `✓ exact updater endpoint configured for stable release: ${updaterEndpoints[0]}`,
    );
  }

  if (!failed) log.log(`Release metadata verified for ${expected}.`);
  return !failed;
}

if (require.main === module) {
  const rawExpected = process.argv[2] || process.env.FLINT_RELEASE_VERSION;
  const channelArgument = process.argv.find((arg) => arg.startsWith('--channel='));
  const channel = channelArgument ? channelArgument.slice('--channel='.length) : 'stable';
  if (!rawExpected || !isStrictSemver(normalizeVersion(rawExpected)) || !['stable', 'evaluation'].includes(channel)) {
    console.error('Usage: node scripts/verify-release-metadata.cjs <version> [--channel=stable|evaluation]');
    process.exit(1);
  }
  process.exit(verifyReleaseMetadata(root, rawExpected, channel) ? 0 : 1);
}

module.exports = { verifyReleaseMetadata };
