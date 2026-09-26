#!/usr/bin/env node
/**
 * Copy Foundry native binaries between a CI cache directory and the SDK
 * install location. SDK 2.x ships foundry_local itself inside the package and
 * downloads ONNX Runtime / ORT-GenAI from NuGet in its install script; that
 * script skips a download when the expected file is already in
 * node_modules/foundry-local-sdk/prebuilds/<platform>/.
 *
 * Those expected file names carry no version, so an older cache restored over
 * a newer SDK would silently satisfy that skip with the wrong runtime. The
 * cache therefore records the SDK version and deps_versions.json it was saved
 * from, and a restore that does not match is refused rather than applied.
 * Restores also never overwrite a file the package tarball already provided.
 *
 * Only what the installer downloads is worth caching. `--baseline`, run right
 * after packages are extracted, records the files the tarball shipped so
 * `--save` can leave them out.
 *
 * Usage:
 *   node scripts/hydrate-foundry-native.cjs --baseline
 *   node scripts/hydrate-foundry-native.cjs --restore
 *   node scripts/hydrate-foundry-native.cjs --save
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const CACHE_DIR = process.env.FLINT_FOUNDRY_CACHE_DIR
  || path.join(root, 'runtime', 'foundry-native-cache');
const DEST_DIR = process.env.FLINT_FOUNDRY_DEST_DIR
  || path.join(root, 'node_modules', 'foundry-local-sdk', 'prebuilds');
// The SDK package root is the parent of prebuilds/; it holds the identity files.
const SDK_DIR = path.dirname(DEST_DIR);
const BASELINE_FILE = process.env.FLINT_FOUNDRY_BASELINE_FILE
  || path.join(root, 'runtime', 'foundry-native-baseline.json');
const MANIFEST = 'flint-native-cache.json';

function log(message) {
  console.log(`[hydrate-foundry-native] ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Identity of the SDK install the cache belongs to. `null` when it cannot be
 * read, which is treated as "cannot be verified" rather than "matches".
 */
function sdkIdentity() {
  const pkg = readJson(path.join(SDK_DIR, 'package.json'));
  const deps = readJson(path.join(SDK_DIR, 'deps_versions.json'));
  if (!pkg || typeof pkg.version !== 'string' || !deps) return null;
  return { layout: 'prebuilds', sdkVersion: pkg.version, deps };
}

function sameIdentity(a, b) {
  if (!a || !b) return false;
  return a.layout === b.layout
    && a.sdkVersion === b.sdkVersion
    && JSON.stringify(a.deps) === JSON.stringify(b.deps);
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => {
        try {
          return fs.statSync(path.join(dir, entry)).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function copyDir(from, to, { overwrite }) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    force: overwrite,
    errorOnExist: false,
    dereference: false,
    verbatimSymlinks: true,
    filter: (src) => path.basename(src) !== MANIFEST,
  });
}

function restore() {
  const cached = listFiles(CACHE_DIR).filter((entry) => path.basename(entry) !== MANIFEST);
  if (cached.length === 0) return;

  const expected = sdkIdentity();
  const recorded = readJson(path.join(CACHE_DIR, MANIFEST));
  if (!expected) {
    log(`skipped restore: cannot read the SDK identity under ${path.relative(root, SDK_DIR)}`);
    return;
  }
  if (!sameIdentity(expected, recorded)) {
    log(
      `skipped restore: cache was saved for ${recorded?.sdkVersion || 'an unknown SDK'}`
        + ` (${recorded?.layout || 'unknown layout'}), install is ${expected.sdkVersion}`
    );
    return;
  }

  // Never overwrite what the package tarball shipped; only fill in the files
  // the SDK install script would otherwise download.
  copyDir(CACHE_DIR, DEST_DIR, { overwrite: false });

  const missing = cached.filter((entry) => !fs.existsSync(path.join(DEST_DIR, entry)));
  if (missing.length > 0) {
    console.error(
      `[hydrate-foundry-native] restore did not land ${missing.length} cached file(s), `
        + `first: ${missing[0]}`
    );
    process.exit(1);
  }
  log(`restored ${cached.length} cached file(s) into ${path.relative(root, DEST_DIR)}`);
}

/** Record what the package tarball shipped, before the installer adds to it. */
function baseline() {
  const identity = sdkIdentity();
  const files = listFiles(DEST_DIR);
  if (!identity || files.length === 0) {
    log(`skipped baseline: nothing extracted under ${path.relative(root, DEST_DIR)}`);
    return;
  }
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...identity, files }, null, 2)}\n`);
  log(`recorded ${files.length} tarball file(s) for SDK ${identity.sdkVersion}`);
}

/** Files the tarball shipped for this exact SDK, which the cache need not carry. */
function shippedFiles(identity) {
  const recorded = readJson(BASELINE_FILE);
  if (!recorded || !Array.isArray(recorded.files)) return new Set();
  if (!sameIdentity(identity, recorded)) return new Set();
  return new Set(recorded.files.map((entry) => String(entry)));
}

function save() {
  const identity = sdkIdentity();
  if (!identity) {
    log(`skipped save: cannot read the SDK identity under ${path.relative(root, SDK_DIR)}`);
    return;
  }
  const shipped = shippedFiles(identity);
  const downloaded = listFiles(DEST_DIR).filter((entry) => !shipped.has(entry));
  if (downloaded.length === 0) {
    log('no downloaded native payload to cache');
    return;
  }
  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
  if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  for (const entry of downloaded) {
    const from = path.join(DEST_DIR, entry);
    const to = path.join(CACHE_DIR, entry);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
  fs.writeFileSync(path.join(CACHE_DIR, MANIFEST), `${JSON.stringify(identity, null, 2)}\n`);
  log(
    `saved ${downloaded.length} downloaded file(s) for SDK ${identity.sdkVersion}`
      + ` to ${path.relative(root, CACHE_DIR)}`
  );
}

const mode = process.argv[2];
if (mode === '--restore') restore();
else if (mode === '--save') save();
else if (mode === '--baseline') baseline();
else {
  console.error('Usage: node scripts/hydrate-foundry-native.cjs --baseline|--restore|--save');
  process.exit(1);
}
