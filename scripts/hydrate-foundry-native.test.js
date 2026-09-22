import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts', 'hydrate-foundry-native.cjs');

const DEPS = { onnxruntime: { version: '1.28.0' }, 'onnxruntime-genai': { version: '0.15.2' } };

function run (mode, cacheDir, destDir, baselineFile) {
  return spawnSync(process.execPath, [script, mode], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FLINT_FOUNDRY_CACHE_DIR: cacheDir,
      FLINT_FOUNDRY_DEST_DIR: destDir,
      FLINT_FOUNDRY_BASELINE_FILE: baselineFile || join(cacheDir, '..', 'baseline.json'),
    },
  });
}

/** Lay out an SDK install whose prebuilds dir is the hydrate destination. */
function makeSdk (root, { version = '2.0.1', deps = DEPS } = {}) {
  const sdkDir = join(root, 'node_modules', 'foundry-local-sdk');
  const destDir = join(sdkDir, 'prebuilds');
  mkdirSync(join(destDir, 'win32-x64'), { recursive: true });
  writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: 'foundry-local-sdk', version }));
  writeFileSync(join(sdkDir, 'deps_versions.json'), JSON.stringify(deps));
  writeFileSync(join(destDir, 'win32-x64', 'foundry_local.dll'), 'shipped');
  return { sdkDir, destDir };
}

describe('hydrate-foundry-native', () => {
  it('caches only what the installer downloaded, not the tarball payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-baseline-'));
    const cacheDir = join(root, 'cache');
    const { destDir } = makeSdk(root);

    // Baseline is taken right after extraction, before the installer downloads.
    expect(run('--baseline', cacheDir, destDir).status).toBe(0);
    writeFileSync(join(destDir, 'win32-x64', 'onnxruntime.dll'), 'ort');
    expect(run('--save', cacheDir, destDir).status).toBe(0);

    expect(existsSync(join(cacheDir, 'win32-x64', 'onnxruntime.dll'))).toBe(true);
    expect(existsSync(join(cacheDir, 'win32-x64', 'foundry_local.dll'))).toBe(false);
  });

  const symlinkIt = process.platform === 'win32' ? it.skip : it;
  symlinkIt('preserves downloaded symlinks through a cache round trip', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-symlink-'));
    const cacheDir = join(root, 'cache');
    const baselineFile = join(root, 'baseline.json');
    const { destDir } = makeSdk(root);
    const platformDir = join(destDir, 'darwin-arm64');
    mkdirSync(platformDir, { recursive: true });

    expect(run('--baseline', cacheDir, destDir, baselineFile).status).toBe(0);
    const versioned = join(platformDir, 'libonnxruntime.1.dylib');
    const alias = join(platformDir, 'libonnxruntime.dylib');
    writeFileSync(versioned, 'ort');
    symlinkSync('libonnxruntime.1.dylib', alias);

    expect(run('--save', cacheDir, destDir, baselineFile).status).toBe(0);
    expect(lstatSync(join(cacheDir, 'darwin-arm64', 'libonnxruntime.dylib')).isSymbolicLink()).toBe(
      true,
    );

    rmSync(versioned);
    rmSync(alias);
    expect(run('--restore', cacheDir, destDir, baselineFile).status).toBe(0);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readlinkSync(alias)).toBe('libonnxruntime.1.dylib');
  });

  it('round-trips the downloaded runtime for a matching SDK install', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-'));
    const cacheDir = join(root, 'cache');
    const { destDir } = makeSdk(root);
    writeFileSync(join(destDir, 'win32-x64', 'onnxruntime.dll'), 'ort');

    const saved = run('--save', cacheDir, destDir);
    expect(saved.status, saved.stderr).toBe(0);
    expect(existsSync(join(cacheDir, 'flint-native-cache.json'))).toBe(true);

    // A fresh extraction ships only the package's own native.
    const fresh = mkdtempSync(join(tmpdir(), 'flint-hydrate-fresh-'));
    const { destDir: freshDest } = makeSdk(fresh);
    const restored = run('--restore', cacheDir, freshDest);
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(join(freshDest, 'win32-x64', 'onnxruntime.dll'), 'utf8')).toBe('ort');
  });

  it('never overwrites a native shipped by the package tarball', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-shipped-'));
    const cacheDir = join(root, 'cache');
    const { destDir } = makeSdk(root);
    const saved = run('--save', cacheDir, destDir);
    expect(saved.status, saved.stderr).toBe(0);

    const fresh = mkdtempSync(join(tmpdir(), 'flint-hydrate-shipped-2-'));
    const { destDir: freshDest } = makeSdk(fresh);
    writeFileSync(join(freshDest, 'win32-x64', 'foundry_local.dll'), 'newer');
    const restored = run('--restore', cacheDir, freshDest);
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(join(freshDest, 'win32-x64', 'foundry_local.dll'), 'utf8')).toBe('newer');
  });

  it('refuses a cache saved for a different SDK version', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-sdk-'));
    const cacheDir = join(root, 'cache');
    const { destDir } = makeSdk(root, { version: '2.0.0' });
    writeFileSync(join(destDir, 'win32-x64', 'onnxruntime.dll'), 'old-ort');
    expect(run('--save', cacheDir, destDir).status).toBe(0);

    const fresh = mkdtempSync(join(tmpdir(), 'flint-hydrate-sdk-2-'));
    const { destDir: freshDest } = makeSdk(fresh, { version: '2.0.1' });
    const restored = run('--restore', cacheDir, freshDest);
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain('skipped restore');
    expect(existsSync(join(freshDest, 'win32-x64', 'onnxruntime.dll'))).toBe(false);
  });

  it('refuses a cache saved for different pinned runtime versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-deps-'));
    const cacheDir = join(root, 'cache');
    const { destDir } = makeSdk(root, { deps: { onnxruntime: { version: '1.27.0' } } });
    writeFileSync(join(destDir, 'win32-x64', 'onnxruntime.dll'), 'old-ort');
    expect(run('--save', cacheDir, destDir).status).toBe(0);

    const fresh = mkdtempSync(join(tmpdir(), 'flint-hydrate-deps-2-'));
    const { destDir: freshDest } = makeSdk(fresh);
    const restored = run('--restore', cacheDir, freshDest);
    expect(restored.status, restored.stderr).toBe(0);
    expect(existsSync(join(freshDest, 'win32-x64', 'onnxruntime.dll'))).toBe(false);
  });

  it('refuses an unmarked cache left by an older layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-legacy-'));
    const cacheDir = join(root, 'cache');
    mkdirSync(join(cacheDir, 'win32-x64'), { recursive: true });
    writeFileSync(join(cacheDir, 'win32-x64', 'Microsoft.AI.Foundry.Local.Core.dll'), 'v1');
    const { destDir } = makeSdk(root);

    const restored = run('--restore', cacheDir, destDir);
    expect(restored.status, restored.stderr).toBe(0);
    expect(existsSync(join(destDir, 'win32-x64', 'Microsoft.AI.Foundry.Local.Core.dll'))).toBe(false);
  });

  it('is a no-op when the cache directory is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-empty-'));
    const cacheDir = join(root, 'cache');
    const destDir = join(root, 'node_modules', 'foundry-local-sdk', 'prebuilds');
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(dirname(destDir), { recursive: true });

    const result = run('--restore', cacheDir, destDir);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(destDir)).toBe(false);
  });

  it('does not write a cache when there is no payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-nosave-'));
    const cacheDir = join(root, 'cache');
    const destDir = join(root, 'node_modules', 'foundry-local-sdk', 'prebuilds');
    mkdirSync(destDir, { recursive: true });

    const result = run('--save', cacheDir, destDir);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(cacheDir)).toBe(false);
  });
});
