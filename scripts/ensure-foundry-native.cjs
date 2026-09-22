// Ensure Foundry Local native binaries exist before tauri build.
// Foundry SDK 2.0 ships them in node_modules/foundry-local-sdk/prebuilds/<platformKey>/.
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
const { execFileSync } = require('node:child_process');
const {
  INSTALLABLE_PLATFORM_KEYS,
  platformKeyForTriple,
  validateNativePayload,
} = require('./foundry-native-payload.cjs');

const root = path.resolve(__dirname, '..');

function log(msg) {
  console.log(`[ensure-foundry-native] ${msg}`);
}

function fail(msg) {
  console.error(`[ensure-foundry-native] ${msg}`);
  process.exit(1);
}

function nodePlatformArch(platformKey) {
  const [platform, arch] = platformKey.split('-');
  return { platform, arch };
}

function runInstallForPlatformKey(sdkRoot, platformKey) {
  const installScript = path.join(sdkRoot, 'script', 'install-native.cjs');
  if (!fs.existsSync(installScript)) return false;

  const hostKey = `${process.platform}-${process.arch}`;
  if (platformKey === hostKey) {
    log(`Installing missing runtime libraries for host ${platformKey}...`);
    execFileSync(process.execPath, [installScript], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    return true;
  }

  const { platform, arch } = nodePlatformArch(platformKey);
  log(`Installing runtime libraries for build target ${platformKey} from host ${hostKey}...`);
  const bootstrap = `
    const os = require('node:os');
    os.platform = () => ${JSON.stringify(platform)};
    os.arch = () => ${JSON.stringify(arch)};
    Promise.resolve(require(${JSON.stringify(installScript)}).main())
      .then((code) => { process.exitCode = code ?? 0; })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  `;
  execFileSync(process.execPath, ['-e', bootstrap], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  return true;
}

/**
 * Resolve Node-style platformKey (e.g. darwin-arm64) for the build target.
 * Order: CLI --target / FOUNDRY_PLATFORM_KEY → TAURI_ENV_* → CARGO_BUILD_TARGET → host.
 */
function resolvePlatformKey() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) {
      const fromTriple = platformKeyForTriple(args[i + 1]);
      if (fromTriple) return { platformKey: fromTriple, source: `--target ${args[i + 1]}` };
      fail(`Unknown --target triple: ${args[i + 1]}`);
    }
    if (args[i].startsWith('--target=')) {
      const triple = args[i].slice('--target='.length);
      const fromTriple = platformKeyForTriple(triple);
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
  const fromTriple = triple ? platformKeyForTriple(triple) : null;
  if (triple && fromTriple) {
    return {
      platformKey: fromTriple,
      source: `target triple env (${triple})`,
    };
  }

  return {
    platformKey: `${process.platform}-${process.arch}`,
    source: 'host process.platform/arch',
  };
}

// --- main ---

const { platformKey, source } = resolvePlatformKey();
const sdkRoot =
  process.env.FLINT_FOUNDRY_SDK_DIR ||
  path.join(root, 'node_modules', 'foundry-local-sdk');

log(`Target platformKey=${platformKey} (from ${source})`);

if (!INSTALLABLE_PLATFORM_KEYS.has(platformKey)) {
  fail(
    `Foundry Local SDK does not publish native cores for platformKey "${platformKey}".\n` +
      `  Installable today: ${[...INSTALLABLE_PLATFORM_KEYS].join(', ')}\n` +
      `  Release matrix targets that need this platform will produce broken sidecars.\n` +
      `  Drop the target from the matrix or wait for SDK support.`
  );
}

let validation;
try {
  validation = validateNativePayload(sdkRoot, platformKey);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (validation.invalid.length > 0) {
  log(`Native payload is incomplete for ${platformKey}; running the SDK installer.`);
  try {
    if (!runInstallForPlatformKey(sdkRoot, platformKey)) {
      fail(`Foundry SDK install script is missing under ${path.relative(root, sdkRoot)}.`);
    }
    validation = validateNativePayload(sdkRoot, platformKey);
  } catch (error) {
    fail(`Foundry SDK native install failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (validation.invalid.length > 0) {
  for (const file of validation.invalid) {
    const detail =
      file.symlinkTo && file.linkTarget !== file.symlinkTo
        ? `not a symlink to ${file.symlinkTo}`
        : file.size === 0
          ? 'missing'
          : `${file.size} bytes`;
    log(`${file.role} is ${detail}: ${path.relative(root, file.filePath)}`);
  }
  fail(
    `Foundry 2.0 native payload is incomplete for ${platformKey}.\n` +
      '  Re-run npm install with scripts enabled, or npm rebuild foundry-local-sdk,\n' +
      '  then run npm run ensure:foundry again.'
  );
}

for (const file of validation.files) {
  const filePath = path.join(validation.platformDir, file.name);
  const size = fs.statSync(filePath).size;
  log(`OK ${file.role} (${(size / (1024 * 1024)).toFixed(1)} MB): ${path.relative(root, filePath)}`);
}
