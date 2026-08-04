#!/usr/bin/env node
/**
 * Syncs the version from package.json into the other Tauri version locations:
 *  - src-tauri/tauri.conf.json
 *  - src-tauri/Cargo.toml
 *
 * This is intended to be called after `changeset version` (or manually).
 * It is also used by the release workflow as a robust alternative to inline node -e.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson (file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function main () {
  // Allow explicit version from CLI: node scripts/sync-versions.cjs 1.2.3
  // Falls back to package.json (used by `npm run version`)
  const explicitVersion = process.argv[2];
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = readJson(pkgPath);
  const version = explicitVersion || pkg.version;

  if (!version || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(version)) {
    console.error(`Invalid version: ${version}`);
    process.exit(1);
  }

  // When an explicit version is provided, also update package.json first
  if (explicitVersion && pkg.version !== explicitVersion) {
    pkg.version = explicitVersion;
    writeJson(pkgPath, pkg);
    console.log(`  ✓ Updated package.json to ${explicitVersion}`);
  }

  console.log(`Syncing version ${version} across Tauri config files...`);

  // --- 1. tauri.conf.json
  const tauriPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
  const tauri = readJson(tauriPath);
  if (tauri.version !== version) {
    tauri.version = version;
    writeJson(tauriPath, tauri);
    console.log('  ✓ Updated src-tauri/tauri.conf.json');
  } else {
    console.log('  ✓ src-tauri/tauri.conf.json already matches');
  }

  // --- 2. Cargo.toml (only the [package] version)
  const cargoPath = path.join(ROOT, 'src-tauri', 'Cargo.toml');
  let cargo = fs.readFileSync(cargoPath, 'utf8');

  // Match the version line that appears under the first [package] section.
  // This regex is more careful than a global replace so we don't touch
  // dependency version specifiers (tauri = { version = "2", ... } etc).
  const packageSectionMatch = cargo.match(/(\[package\][\s\S]*?^version\s*=\s*)".*?"/m);
  if (packageSectionMatch) {
    const updated = cargo.replace(
      /(\[package\][\s\S]*?^version\s*=\s*)".*?"/m,
      `$1"${version}"`
    );
    if (updated !== cargo) {
      fs.writeFileSync(cargoPath, updated);
      console.log('  ✓ Updated src-tauri/Cargo.toml');
    } else {
      console.log('  ✓ src-tauri/Cargo.toml already matches');
    }
  } else {
    console.warn('  Could not locate [package] version in Cargo.toml');
  }

  console.log('Version sync complete.');
}

main();
