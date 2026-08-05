// Ensure Foundry Local native core binaries exist before tauri build.
// Downloaded by foundry-local-sdk postinstall into
// node_modules/foundry-local-sdk/foundry-local-core/<platform>/ — not part of
// the published npm package tarball. If they are missing, release installers
// package a useless SDK and the sidecar fails with FoundryLocalCorePath.
//
// Invoked from tauri.conf.json beforeBuildCommand (single entry point).

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const platformKey = `${process.platform}-${process.arch}`;
const coreExt =
  process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
const corePath = path.join(
  root,
  'node_modules',
  'foundry-local-sdk',
  'foundry-local-core',
  platformKey,
  `Microsoft.AI.Foundry.Local.Core${coreExt}`
);

function log(msg) {
  console.log(`[ensure-foundry-native] ${msg}`);
}

function fail(msg) {
  console.error(`[ensure-foundry-native] ${msg}`);
  process.exit(1);
}

function coreOk() {
  try {
    const st = fs.statSync(corePath);
    // Guard against empty/corrupt placeholders (real Core binary is multi-MB).
    return st.isFile() && st.size > 1_000_000;
  } catch {
    return false;
  }
}

function runInstallScript(scriptPath) {
  if (!fs.existsSync(scriptPath)) {
    return false;
  }
  log(`Running ${path.relative(root, scriptPath)} ...`);
  execFileSync(process.execPath, [scriptPath], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  return true;
}

if (coreOk()) {
  const st = fs.statSync(corePath);
  log(`OK (${(st.size / (1024 * 1024)).toFixed(1)} MB): ${path.relative(root, corePath)}`);
  process.exit(0);
}

log(`Missing or too small: ${path.relative(root, corePath)}`);
log('Native Foundry Local binaries are not present. Downloading via package install script...');

const standardScript = path.join(
  root,
  'node_modules',
  'foundry-local-sdk',
  'script',
  'install-standard.cjs'
);

let ran = false;
try {
  ran = runInstallScript(standardScript);
} catch (err) {
  fail(`Install script failed: ${err instanceof Error ? err.message : err}`);
}

if (!ran) {
  fail(
    'No foundry-local-sdk install script found. Run `npm install` first (lifecycle scripts must be enabled).'
  );
}

if (!coreOk()) {
  fail(
    `Still missing after install: ${path.relative(root, corePath)}\n` +
      '  Release installers will be broken without this file.\n' +
      '  Re-run npm install with scripts enabled, then npm run ensure:foundry.'
  );
}

const st = fs.statSync(corePath);
log(`Installed OK (${(st.size / (1024 * 1024)).toFixed(1)} MB): ${path.relative(root, corePath)}`);
