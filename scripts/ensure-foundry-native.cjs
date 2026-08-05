// Ensure Foundry Local native core binaries exist before tauri build.
// Downloaded into node_modules/foundry-local-sdk/foundry-local-core/<platformKey>/.
//
// Invoked from tauri.conf.json beforeBuildCommand.
//
// IMPORTANT: Prefer the *build target* (what the installer ships), not the host.
// Tauri sets TAURI_ENV_PLATFORM / TAURI_ENV_ARCH / TAURI_ENV_TARGET_TRIPLE on
// beforeBuildCommand when building with --target (e.g. x86_64-apple-darwin on
// an arm64 Mac). Falling back to process.platform/arch is only for local host builds.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');

/** Map Rust / Tauri target triples → Node-style platformKey used by foundry-local-sdk. */
const TRIPLE_TO_PLATFORM_KEY = {
  'x86_64-pc-windows-msvc': 'win32-x64',
  'x86_64-pc-windows-gnu': 'win32-x64',
  'aarch64-pc-windows-msvc': 'win32-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
};

/** NuGet RIDs supported by foundry-local-sdk install-utils (must stay in sync). */
const SUPPORTED_PLATFORM_KEYS = new Set([
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  // darwin-x64 is intentionally absent from current foundry-local-sdk PLATFORM_MAP;
  // we still resolve it so we can fail with a clear message instead of arm64-on-intel mismatch.
]);

/** foundry-local-sdk install-utils PLATFORM_MAP keys that actually download. */
const INSTALLABLE_PLATFORM_KEYS = new Set([
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
]);

function log(msg) {
  console.log(`[ensure-foundry-native] ${msg}`);
}

function fail(msg) {
  console.error(`[ensure-foundry-native] ${msg}`);
  process.exit(1);
}

/**
 * Resolve Node-style platformKey (e.g. darwin-arm64) for the build target.
 * Order: CLI --target / FOUNDRY_PLATFORM_KEY → TAURI_ENV_* → CARGO_BUILD_TARGET → host.
 */
function resolvePlatformKey() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) {
      const fromTriple = TRIPLE_TO_PLATFORM_KEY[args[i + 1]];
      if (fromTriple) return { platformKey: fromTriple, source: `--target ${args[i + 1]}` };
      fail(`Unknown --target triple: ${args[i + 1]}`);
    }
    if (args[i].startsWith('--target=')) {
      const triple = args[i].slice('--target='.length);
      const fromTriple = TRIPLE_TO_PLATFORM_KEY[triple];
      if (fromTriple) return { platformKey: fromTriple, source: `--target=${triple}` };
      fail(`Unknown --target triple: ${triple}`);
    }
  }

  if (process.env.FOUNDRY_PLATFORM_KEY) {
    return {
      platformKey: process.env.FOUNDRY_PLATFORM_KEY,
      source: 'FOUNDRY_PLATFORM_KEY',
    };
  }

  // Tauri beforeBuildCommand (set when using `tauri build --target ...`)
  const tauriPlatform = process.env.TAURI_ENV_PLATFORM; // windows | darwin | linux
  const tauriArch = process.env.TAURI_ENV_ARCH; // x86_64 | aarch64 | ...
  if (tauriPlatform && tauriArch) {
    const nodePlatform =
      tauriPlatform === 'windows' ? 'win32' : tauriPlatform === 'darwin' ? 'darwin' : 'linux';
    const nodeArch =
      tauriArch === 'x86_64' || tauriArch === 'x64'
        ? 'x64'
        : tauriArch === 'aarch64' || tauriArch === 'arm64'
          ? 'arm64'
          : tauriArch;
    return {
      platformKey: `${nodePlatform}-${nodeArch}`,
      source: `TAURI_ENV_PLATFORM=${tauriPlatform} TAURI_ENV_ARCH=${tauriArch}`,
    };
  }

  const triple =
    process.env.TAURI_ENV_TARGET_TRIPLE ||
    process.env.CARGO_BUILD_TARGET ||
    process.env.CARGO_CFG_TARGET_TRIPLE;
  if (triple && TRIPLE_TO_PLATFORM_KEY[triple]) {
    return {
      platformKey: TRIPLE_TO_PLATFORM_KEY[triple],
      source: `target triple env (${triple})`,
    };
  }

  return {
    platformKey: `${process.platform}-${process.arch}`,
    source: 'host process.platform/arch',
  };
}

function coreExtension(platformKey) {
  if (platformKey.startsWith('win32')) return '.dll';
  if (platformKey.startsWith('darwin')) return '.dylib';
  return '.so';
}

function nodePlatformArch(platformKey) {
  const [platform, arch] = platformKey.split('-');
  return { platform, arch };
}

function corePathFor(platformKey) {
  return path.join(
    root,
    'node_modules',
    'foundry-local-sdk',
    'foundry-local-core',
    platformKey,
    `Microsoft.AI.Foundry.Local.Core${coreExtension(platformKey)}`
  );
}

function coreOk(corePath) {
  try {
    const st = fs.statSync(corePath);
    return st.isFile() && st.size > 1_000_000;
  } catch {
    return false;
  }
}

/**
 * Run foundry-local-sdk install-standard.cjs as if on the *target* platform.
 * install-utils.cjs snapshots os.platform()/os.arch() at load time, so we must
 * patch `os` before requiring the install script when host ≠ target.
 */
function runInstallForPlatformKey(platformKey) {
  const standardScript = path.join(
    root,
    'node_modules',
    'foundry-local-sdk',
    'script',
    'install-standard.cjs'
  );
  if (!fs.existsSync(standardScript)) {
    return false;
  }

  const { platform, arch } = nodePlatformArch(platformKey);
  const hostKey = `${process.platform}-${process.arch}`;

  if (platformKey === hostKey) {
    log(`Running install-standard.cjs for host ${platformKey}...`);
    execFileSync(process.execPath, [standardScript], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    return true;
  }

  // Cross-target: patch os.platform/arch before the install utils load.
  log(
    `Host is ${hostKey}; installing natives for build target ${platformKey} (patched os.platform/arch)...`
  );
  const bootstrap = `
    const os = require('os');
    os.platform = () => ${JSON.stringify(platform)};
    os.arch = () => ${JSON.stringify(arch)};
    require(${JSON.stringify(standardScript)});
  `;
  execFileSync(process.execPath, ['-e', bootstrap], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  return true;
}

// --- main ---

const { platformKey, source } = resolvePlatformKey();
const corePath = corePathFor(platformKey);

log(`Target platformKey=${platformKey} (from ${source})`);

if (!INSTALLABLE_PLATFORM_KEYS.has(platformKey)) {
  fail(
    `Foundry Local SDK does not publish native cores for platformKey "${platformKey}".\n` +
      `  Installable today: ${[...INSTALLABLE_PLATFORM_KEYS].join(', ')}\n` +
      `  Release matrix targets that need this platform will produce broken sidecars.\n` +
      `  Drop the target from the matrix or wait for SDK support.`
  );
}

if (coreOk(corePath)) {
  const st = fs.statSync(corePath);
  log(`OK (${(st.size / (1024 * 1024)).toFixed(1)} MB): ${path.relative(root, corePath)}`);
  process.exit(0);
}

log(`Missing or too small: ${path.relative(root, corePath)}`);
log('Native Foundry Local binaries are not present. Downloading via package install script...');

let ran = false;
try {
  ran = runInstallForPlatformKey(platformKey);
} catch (err) {
  fail(`Install script failed: ${err instanceof Error ? err.message : err}`);
}

if (!ran) {
  fail(
    'No foundry-local-sdk install script found. Run `npm install` first (lifecycle scripts must be enabled).'
  );
}

if (!coreOk(corePath)) {
  fail(
    `Still missing after install: ${path.relative(root, corePath)}\n` +
      '  Release installers will be broken without this file.\n' +
      '  Re-run npm install with scripts enabled, then npm run ensure:foundry.\n' +
      `  For cross-targets: ensure:foundry --target <triple> or FOUNDRY_PLATFORM_KEY=${platformKey}`
  );
}

const st = fs.statSync(corePath);
log(`Installed OK (${(st.size / (1024 * 1024)).toFixed(1)} MB): ${path.relative(root, corePath)}`);
