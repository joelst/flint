// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stageKoffiNative, validateKoffiNative } from './stage-koffi-native.cjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-koffi-stage-'));
  roots.push(root);
  return root;
}

function packageFile(root, name, file, content) {
  const target = path.join(root, 'node_modules', '@koromix', name, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function bindingFixture() {
  const root = fixture();
  const sidecar = path.join(root, 'sidecar', 'cuda-runtime-path.js');
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'sidecar', 'cuda-runtime-path.js'), sidecar);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  return root;
}

function probeBinding(root) {
  const sidecar = path.join(root, 'sidecar', 'cuda-runtime-path.js');
  const script = `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { addDllDirectory } = await import(${JSON.stringify(pathToFileURL(sidecar).href)});
    await addDllDirectory(${JSON.stringify(root)});
    console.log('registered');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: { ...process.env, NODE_PATH: '' },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('koffi native staging', () => {
  it.each([false, true])('loads the flattened binding without node_modules and preserves load failures (broken: %s)', (broken) => {
    const root = bindingFixture();
    const koffi = path.join(root, 'koffi');
    fs.mkdirSync(koffi, { recursive: true });
    fs.writeFileSync(path.join(koffi, 'index.js'), broken
      ? 'export function load() { throw new Error("packaged binding is broken"); }'
      : 'export function load() { return { func: () => () => 1n }; }');
    const result = probeBinding(root);
    expect(result.error).toBeUndefined();
    if (broken) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('packaged binding is broken');
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('registered');
    }
  });

  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('loads the real Windows native payload from an isolated flattened resource tree', () => {
    const root = bindingFixture();
    fs.cpSync(path.join(process.cwd(), 'node_modules', 'koffi'), path.join(root, 'koffi'), { recursive: true });
    fs.cpSync(
      path.join(process.cwd(), 'node_modules', '@koromix', 'koffi-win32-x64'),
      path.join(root, '@koromix', 'koffi-win32-x64'),
      { recursive: true },
    );
    const result = probeBinding(root);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('registered');
  });

  it('copies native packages and replaces stale staging without touching installed sources', () => {
    const root = fixture();
    const koffi = path.join(root, 'node_modules', 'koffi');
    fs.mkdirSync(koffi, { recursive: true });
    fs.writeFileSync(path.join(koffi, 'package.json'), '{"version":"3.3.4"}');
    packageFile(root, 'koffi-win32-x64', 'package.json', '{"version":"3.3.4"}');
    packageFile(root, 'koffi-win32-x64', 'index.js', 'module.exports = require("./win32_x64/koffi.node");');
    packageFile(root, 'koffi-win32-x64', 'win32_x64/koffi.node', 'current native');
    packageFile(root, 'unrelated', 'index.js', 'not a koffi package');
    const stale = path.join(root, 'runtime', 'koffi-stage', '@koromix', 'stale');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'old');

    expect(stageKoffiNative(root, 'win32', 'x64')).toEqual(['koffi-win32-x64']);
    const staged = path.join(root, 'runtime', 'koffi-stage', '@koromix');
    expect(fs.readdirSync(staged)).toEqual(['koffi-win32-x64']);
    expect(fs.readFileSync(path.join(staged, 'koffi-win32-x64', 'win32_x64', 'koffi.node'), 'utf8'))
      .toBe('current native');
    expect(fs.readFileSync(path.join(root, 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'), 'utf8'))
      .toBe('current native');
  });

  it('creates the Tauri resource directory even when no optional package is installed on non-CUDA targets', () => {
    const root = fixture();
    expect(stageKoffiNative(root, 'linux', 'x64')).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'runtime', 'koffi-stage', '@koromix'))).toEqual([]);
  });

  it('refuses Windows x64 packaging without its CUDA DLL-search binding', () => {
    const root = fixture();
    packageFile(root, 'koffi-darwin-arm64', 'koffi.node', 'wrong platform');
    expect(() => stageKoffiNative(root, 'win32', 'x64')).toThrow(/missing koffi-win32-x64/);
  });

  it('rejects an incomplete or mismatched Windows native package before replacing staging', () => {
    const root = fixture();
    const koffi = path.join(root, 'node_modules', 'koffi');
    const natives = path.join(root, 'node_modules', '@koromix');
    fs.mkdirSync(koffi, { recursive: true });
    fs.writeFileSync(path.join(koffi, 'package.json'), '{"version":"3.3.4"}');
    packageFile(root, 'koffi-win32-x64', 'package.json', '{"version":"3.3.4"}');
    packageFile(root, 'koffi-win32-x64', 'index.js', 'module.exports = require("./win32_x64/koffi.node");');
    expect(() => validateKoffiNative(koffi, natives, 'win32-x64')).toThrow(/koffi.node/);
    packageFile(root, 'koffi-win32-x64', 'win32_x64/koffi.node', 'native fixture');
    expect(() => validateKoffiNative(koffi, natives, 'win32-x64')).not.toThrow();
    packageFile(root, 'koffi-win32-x64', 'package.json', '{"version":"3.3.3"}');
    expect(() => validateKoffiNative(koffi, natives, 'win32-x64')).toThrow(/version/);
    expect(() => stageKoffiNative(root, 'win32', 'x64')).toThrow(/version/);
    expect(fs.existsSync(path.join(root, 'runtime', 'koffi-stage'))).toBe(false);
  });
});
