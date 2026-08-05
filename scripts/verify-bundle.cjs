// Verify Foundry Local native binaries are present for packaging / after build.
// Fails hard when Microsoft.AI.Foundry.Local.Core is missing — that is the
// FoundryLocalCorePath error mode in release installs.

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const platformKey = `${process.platform}-${process.arch}`;
const coreExt =
  process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
const coreFile = `Microsoft.AI.Foundry.Local.Core${coreExt}`;

let failed = false;

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function bad(msg) {
  console.error(`  ✗ ${msg}`);
  failed = true;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkCoreAt(label, dir) {
  const corePath = path.join(dir, 'foundry-local-core', platformKey, coreFile);
  if (!fs.existsSync(corePath)) {
    bad(`${label}: missing ${path.relative(root, corePath)}`);
    return;
  }
  const st = fs.statSync(corePath);
  if (st.size < 1_000_000) {
    bad(`${label}: ${path.relative(root, corePath)} is only ${st.size} bytes (expected multi-MB)`);
    return;
  }
  ok(`${label}: ${path.relative(root, corePath)} (${(st.size / (1024 * 1024)).toFixed(1)} MB)`);
}

console.log('Verifying Foundry Local SDK packaging prerequisites...');
console.log(`Platform: ${platformKey}`);

const sdkRoot = path.join(root, 'node_modules', 'foundry-local-sdk');
if (!fs.existsSync(sdkRoot)) {
  bad('node_modules/foundry-local-sdk not installed — run npm install');
} else {
  checkCoreAt('node_modules', sdkRoot);
  const prebuild = path.join(sdkRoot, 'prebuilds', platformKey, 'foundry_local_napi.node');
  if (fs.existsSync(prebuild)) {
    ok(`prebuild present: ${path.relative(root, prebuild)}`);
  } else {
    bad(`missing N-API prebuild: ${path.relative(root, prebuild)}`);
  }
}

// Staged Tauri resource tree (present after a local release build)
// Flattened map-form: target/release/foundry-local-sdk
const stagedSdk = path.join(root, 'src-tauri', 'target', 'release', 'foundry-local-sdk');
if (fs.existsSync(path.join(root, 'src-tauri', 'target', 'release'))) {
  console.log('Checking release resource staging...');
  if (!fs.existsSync(stagedSdk)) {
    bad(
      'no staged foundry-local-sdk under target/release (expected foundry-local-sdk/) — run tauri build'
    );
  } else {
    checkCoreAt(`staged resources (${path.relative(root, stagedSdk)})`, stagedSdk);
  }

  // Prefer definitive checks; size is only a coarse safety net.
  // NSIS compresses much better than MSI (good builds: MSI ~24MB, NSIS ~17MB;
  // broken without core: MSI ~6MB, NSIS ~4MB).
  let appVersion = null;
  try {
    appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch {
    /* ignore */
  }
  const versionNeedle = appVersion ? `_${appVersion}_` : null;

  // Tauri-generated NSIS script lists every bundled file — definitive for NSIS.
  const nsiPath = path.join(root, 'src-tauri', 'target', 'release', 'nsis', 'x64', 'installer.nsi');
  if (fs.existsSync(nsiPath)) {
    const nsi = fs.readFileSync(nsiPath, 'utf8');
    // NSI lists each resource with File /oname=...foundry-local-core\win32-x64\...
    const coreRe = new RegExp(
      `foundry-local-core[\\\\/]${escapeRegExp(platformKey)}[\\\\/]${escapeRegExp(coreFile)}`,
      'i'
    );
    if (coreRe.test(nsi) || nsi.includes(coreFile)) {
      ok(`NSIS script includes ${coreFile}`);
    } else {
      bad(`NSIS script missing ${coreFile}: ${path.relative(root, nsiPath)}`);
    }
  } else {
    console.log('  (no installer.nsi yet — skipped NSIS file-list check)');
  }

  function checkInstallers(dir, ext, minMb) {
    if (!fs.existsSync(dir)) return;
    let names = fs.readdirSync(dir).filter((f) => f.endsWith(ext));
    if (versionNeedle) {
      const matched = names.filter((f) => f.includes(versionNeedle));
      if (matched.length) names = matched;
      else {
        console.log(`  (no ${ext} for version ${appVersion} in ${path.relative(root, dir)})`);
        return;
      }
    }
    for (const name of names) {
      const p = path.join(dir, name);
      const mb = fs.statSync(p).size / (1024 * 1024);
      if (mb < minMb) {
        bad(
          `${name} is only ${mb.toFixed(1)} MB (min ${minMb} MB) — native Foundry core was almost certainly not packaged. Rebuild after ensure-foundry-native.`
        );
      } else {
        ok(`${name}: ${mb.toFixed(1)} MB`);
      }
    }
  }

  // MSI: looser compression → higher floor. NSIS: solid LZMA → lower floor.
  checkInstallers(path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'msi'), '.msi', 20);
  checkInstallers(path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis'), '.exe', 12);
} else {
  console.log('No release build under src-tauri/target/release — skipped staging/installer checks.');
}

if (failed) {
  console.error('\nVerification FAILED. Fix with:');
  console.error('  node scripts/ensure-foundry-native.cjs');
  console.error('  npm run tauri:build');
  console.error('  npm run verify:bundle');
  process.exit(1);
}

console.log('\nVerification passed.');
