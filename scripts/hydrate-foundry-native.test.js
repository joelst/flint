import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts', 'hydrate-foundry-native.cjs');

function runRestore (cacheDir, destDir) {
  return spawnSync(process.execPath, [script, '--restore'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FLINT_FOUNDRY_CACHE_DIR: cacheDir,
      FLINT_FOUNDRY_DEST_DIR: destDir,
    },
  });
}

describe('hydrate-foundry-native restore', () => {
  it('creates a missing destination parent and copies cached files', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-'));
    const cacheDir = join(root, 'cache');
    const destDir = join(root, 'node_modules', 'foundry-local-sdk', 'foundry-local-core');
    mkdirSync(join(cacheDir, 'win32-x64'), { recursive: true });
    writeFileSync(join(cacheDir, 'win32-x64', 'Microsoft.AI.Foundry.Local.Core.dll'), 'core');

    const result = runRestore(cacheDir, destDir);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(destDir, 'win32-x64', 'Microsoft.AI.Foundry.Local.Core.dll'))).toBe(true);
    expect(readFileSync(join(destDir, 'win32-x64', 'Microsoft.AI.Foundry.Local.Core.dll'), 'utf8')).toBe('core');
  });

  it('is a no-op when the cache directory is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-hydrate-empty-'));
    const cacheDir = join(root, 'cache');
    const destDir = join(root, 'dest');
    mkdirSync(cacheDir, { recursive: true });

    const result = runRestore(cacheDir, destDir);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(destDir)).toBe(false);
  });
});
