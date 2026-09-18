import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInsideRoot } from '../../sidecar/byom-import.js';

const require = createRequire(import.meta.url);
const { verifyIpcContracts } = require('../../scripts/verify-ipc-contracts.cjs');

function permissionId(permission: unknown): string | null {
  if (typeof permission === 'string') return permission;
  if (permission && typeof permission === 'object' && 'identifier' in permission) {
    const id = (permission as { identifier?: unknown }).identifier;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

function permissionById(permissions: unknown[], id: string) {
  return permissions.find((permission) => permissionId(permission) === id);
}

describe('renderer capability ACL', () => {
  const capability = JSON.parse(
    readFileSync(join(process.cwd(), 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
  );
  const permissions: unknown[] = capability.permissions;
  const ids = permissions.map(permissionId);

  it('is limited to the main window', () => {
    expect(capability.windows).toEqual(['main']);
  });

  it('does not grant opener, spawn, kill, or stdin-write', () => {
    expect(ids).not.toContain('opener:default');
    expect(ids).not.toContain('shell:allow-spawn');
    expect(ids).not.toContain('shell:allow-kill');
    expect(ids).not.toContain('shell:allow-stdin-write');
    expect(ids.some((id) => typeof id === 'string' && id.startsWith('opener:'))).toBe(false);
  });

  it('does not grant the renderer a $RESOURCE read scope', () => {
    const scopes = permissions.filter((permission) => permissionId(permission) === 'fs:scope');
    expect(scopes).toEqual([]);
  });

  it('keeps $RESOURCE writes denied on the export write command', () => {
    const write = permissionById(permissions, 'fs:allow-write-text-file') as {
      deny?: Array<{ path?: string }>;
    };
    expect(write?.deny?.some((rule) => rule.path === '$RESOURCE/**')).toBe(true);
  });

  it('keeps renderer shell execute limited to Node version probes', () => {
    const execute = permissionById(permissions, 'shell:allow-execute') as {
      allow?: Array<{ name?: string; cmd?: string; sidecar?: boolean; args?: Array<{ validator?: string }> }>;
    };
    expect(execute?.allow).toHaveLength(2);
    for (const entry of execute.allow ?? []) {
      expect(entry.args).toEqual([{ validator: '^(-v|--version)$' }]);
    }
    const names = (execute.allow ?? []).map((entry) => entry.name);
    expect(names).toContain('binaries/node');
    expect(names).toContain('node');
  });

  it('keeps updater download-and-install for the 1.0 install UX', () => {
    expect(ids).toContain('updater:allow-check');
    expect(ids).toContain('updater:allow-download-and-install');
  });

  it('does not depend on the opener plugin crate or npm package', () => {
    const cargo = readFileSync(join(process.cwd(), 'src-tauri', 'Cargo.toml'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const lib = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'lib.rs'), 'utf8');
    expect(cargo).not.toMatch(/tauri-plugin-opener/);
    expect(pkg.dependencies['@tauri-apps/plugin-opener']).toBeUndefined();
    expect(lib).not.toMatch(/tauri_plugin_opener/);
  });
});

describe('renderer/sidecar boundary', () => {
  it('keeps IPC command allowlists synchronized', () => {
    const count = verifyIpcContracts(process.cwd(), { log() {}, error() {} });
    expect(count).toBeGreaterThan(0);
  });

  it('rejects BYOM paths that escape the cache root', () => {
    const root = join(process.cwd(), 'models');
    expect(isInsideRoot(root, join(root, 'phi'))).toBe(true);
    expect(isInsideRoot(root, join(root, '..', 'elsewhere'))).toBe(false);
    expect(isInsideRoot(root, `${root}-evil`)).toBe(false);
  });

  it('keeps the quit-flush event name synchronized', () => {
    const sdk = readFileSync(join(process.cwd(), 'src', 'lib', 'sdk.ts'), 'utf8');
    const rust = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'quit_flush.rs'), 'utf8');
    expect(sdk).toContain("QUIT_FLUSH_EVENT = 'flint-quit-flush'");
    expect(rust).toContain('QUIT_FLUSH_EVENT: &str = "flint-quit-flush"');
  });

  it('keeps the frontend and native runtime frame limits synchronized', () => {
    const sdk = readFileSync(join(process.cwd(), 'src', 'lib', 'sdk.ts'), 'utf8');
    const rust = readFileSync(
      join(process.cwd(), 'src-tauri', 'src', 'runtime_manager.rs'),
      'utf8',
    );
    expect(sdk).toContain('NATIVE_RUNTIME_MAX_FRAME_BYTES = 80 * 1024 * 1024');
    expect(rust).toContain('MAX_RUNTIME_FRAME_BYTES: usize = 80 * 1024 * 1024');
  });
});
