// Verify Foundry Local native binaries are present for packaging / after build.
// Fails hard when foundry_local is missing — that is the
// FoundryLocalCorePath error mode in release installs.

'use strict';

const fs = require('fs');
const path = require('path');
const {
  describeInvalidNativeFile,
  platformKeyForTriple,
  validateNativePayload,
} = require('./foundry-native-payload.cjs');

const root = path.resolve(__dirname, '..');

// Release builds run `tauri build --target <triple>`, which puts output under
// target/<triple>/release instead of target/release. Without --target the
// staging and installer checks below silently find nothing and "pass".
function parseArgs(argv) {
  let target = process.env.FLINT_VERIFY_TARGET || null;
  let requireBuild = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') {
      target = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    } else if (arg === '--require-build') {
      requireBuild = true;
    }
  }
  return { target: target || null, requireBuild };
}

const { target: buildTarget, requireBuild } = parseArgs(process.argv.slice(2));
const targetPlatformKey = buildTarget ? platformKeyForTriple(buildTarget) : null;
if (buildTarget && !targetPlatformKey) {
  console.error(`Unknown --target triple: ${buildTarget}`);
  process.exit(1);
}
const releaseDir = buildTarget
  ? path.join(root, 'src-tauri', 'target', buildTarget, 'release')
  : path.join(root, 'src-tauri', 'target', 'release');

const platformKey =
  targetPlatformKey ||
  `${process.platform}-${process.arch}`;

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

function checkPayloadAt(label, dir) {
  let validation;
  try {
    validation = validateNativePayload(dir, platformKey);
  } catch (error) {
    bad(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  for (const file of validation.invalid) {
    bad(
      `${label}: ${path.relative(root, file.filePath)} is ${describeInvalidNativeFile(file)}`,
    );
  }
  if (validation.invalid.length === 0) {
    ok(`${label}: complete ${platformKey} native payload (${validation.files.length} files)`);
  }
  return validation.files;
}

console.log('Verifying Foundry Local SDK packaging prerequisites...');
console.log(`Platform: ${platformKey}`);

// --- Bundled Node (Spike A: Tauri externalBin binaries/node) ---
function hostTripleForNode() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  return null;
}

console.log('Checking bundled Node runtime (externalBin)...');
const triple = hostTripleForNode();
const nodeExt = process.platform === 'win32' ? '.exe' : '';
const nodeBin = triple
  ? path.join(root, 'src-tauri', 'binaries', `node-${triple}${nodeExt}`)
  : null;
const nodeVerFile = path.join(root, 'src-tauri', 'binaries', 'node.VERSION');
if (!triple) {
  bad(`unsupported platform for bundled Node: ${process.platform}-${process.arch}`);
} else if (!fs.existsSync(nodeBin)) {
  bad(
    `missing ${path.relative(root, nodeBin)} — run: npm run ensure:node`,
  );
} else {
  const st = fs.statSync(nodeBin);
  const mb = st.size / (1024 * 1024);
  if (mb < 20) {
    bad(`${path.relative(root, nodeBin)} is only ${mb.toFixed(1)} MB (expected full Node binary)`);
  } else {
    ok(`bundled Node: ${path.relative(root, nodeBin)} (${mb.toFixed(1)} MB)`);
  }
  if (fs.existsSync(nodeVerFile)) {
    ok(`node.VERSION: ${fs.readFileSync(nodeVerFile, 'utf8').trim()}`);
  } else {
    bad('missing src-tauri/binaries/node.VERSION');
  }
}

const sdkRoot = path.join(root, 'node_modules', 'foundry-local-sdk');
let expectedFiles = [];
if (!fs.existsSync(sdkRoot)) {
  bad('node_modules/foundry-local-sdk not installed — run npm install');
} else {
  expectedFiles = checkPayloadAt('node_modules', sdkRoot);
}

// Staged Tauri resource tree (present after a local release build)
// Flattened map-form: <release>/foundry-local-sdk
const stagedSdk = path.join(releaseDir, 'foundry-local-sdk');
if (fs.existsSync(releaseDir)) {
  console.log(`Checking release resource staging (${path.relative(root, releaseDir)})...`);
  if (!fs.existsSync(stagedSdk)) {
    bad(
      'no staged foundry-local-sdk under target/release (expected foundry-local-sdk/) — run tauri build'
    );
  } else {
    checkPayloadAt(
      `staged resources (${path.relative(root, stagedSdk)})`,
      stagedSdk,
    );
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
  const nsiPath = path.join(releaseDir, 'nsis', 'x64', 'installer.nsi');
  if (fs.existsSync(nsiPath)) {
    const nsi = fs.readFileSync(nsiPath, 'utf8');
    // NSI lists each resource with File /oname=...prebuilds\win32-x64\...
    for (const file of expectedFiles || []) {
      const fileRe = new RegExp(
        `prebuilds[\\\\/]${escapeRegExp(platformKey)}[\\\\/]${escapeRegExp(file.name)}`,
        'i',
      );
      if (fileRe.test(nsi) || nsi.includes(file.name)) {
        ok(`NSIS script includes ${file.name}`);
      } else {
        bad(`NSIS script missing ${file.name}: ${path.relative(root, nsiPath)}`);
      }
    }
  } else {
    console.log('  (no installer.nsi yet — skipped NSIS file-list check)');
  }

  function checkInstallers(dir, ext, minMb) {
    if (!fs.existsSync(dir)) return 0;
    let names = fs.readdirSync(dir).filter((f) => f.endsWith(ext));
    if (versionNeedle) {
      const matched = names.filter((f) => f.includes(versionNeedle));
      if (matched.length) names = matched;
      else {
        console.log(`  (no ${ext} for version ${appVersion} in ${path.relative(root, dir)})`);
        return 0;
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
    return names.length;
  }

  // MSI: looser compression → higher floor. NSIS: solid LZMA → lower floor.
  let installerCount = 0;
  installerCount += checkInstallers(path.join(releaseDir, 'bundle', 'msi'), '.msi', 20);
  installerCount += checkInstallers(path.join(releaseDir, 'bundle', 'nsis'), '.exe', 12);
  installerCount += checkInstallers(path.join(releaseDir, 'bundle', 'dmg'), '.dmg', 12);

  if (requireBuild && installerCount === 0) {
    bad(
      `--require-build: no installers found under ${path.relative(root, path.join(releaseDir, 'bundle'))}`
    );
  }
} else if (requireBuild) {
  bad(
    `--require-build: no release build at ${path.relative(root, releaseDir)}` +
      (buildTarget ? '' : ' (pass --target <triple> if this was a --target build)')
  );
} else {
  console.log(
    `No release build under ${path.relative(root, releaseDir)} — skipped staging/installer checks.`
  );
}

if (failed) {
  console.error('\nVerification FAILED. Fix with:');
  console.error('  npm run ensure:node');
  console.error('  node scripts/ensure-foundry-native.cjs');
  console.error('  npm run tauri:build:local');
  console.error('  npm run verify:bundle');
  process.exit(1);
}

console.log('\nVerification passed.');
