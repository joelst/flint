// Smoke: staged externalBin Node can (1) report version and (2) load foundry-local-sdk N-API.
// Does not require Tauri or PATH Node (spawns the staged binary directly).
//
// Usage: node scripts/smoke-bundled-node.cjs
// Prereq: npm run ensure:node && npm install (foundry-local-sdk + prebuilds + cores)

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const binariesDir = path.join(root, 'src-tauri', 'binaries');

function hostTriple() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

function stagedNodePath() {
  const triple = hostTriple();
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(binariesDir, `node-${triple}${ext}`);
}

function run(bin, args, env = {}) {
  return spawnSync(bin, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout: 60_000,
  });
}

function main() {
  const nodeBin = stagedNodePath();
  if (!fs.existsSync(nodeBin)) {
    console.error(`Missing ${path.relative(root, nodeBin)} — run: npm run ensure:node`);
    process.exit(1);
  }

  console.log(`Using ${path.relative(root, nodeBin)}`);

  const ver = run(nodeBin, ['-v']);
  if (ver.status !== 0) {
    console.error('node -v failed:', ver.stderr || ver.error);
    process.exit(1);
  }
  const version = (ver.stdout || ver.stderr || '').trim();
  console.log(`  ✓ version: ${version}`);
  if (!/^v?22\./.test(version)) {
    console.error(`  ✗ expected Node 22.x, got ${version}`);
    process.exit(1);
  }

  const sdkRoot = path.join(root, 'node_modules', 'foundry-local-sdk');
  if (!fs.existsSync(sdkRoot)) {
    console.error('  ✗ node_modules/foundry-local-sdk missing — npm install');
    process.exit(1);
  }

  const loader = path.join(root, 'scripts', '_smoke-load-foundry.mjs');
  fs.writeFileSync(
    loader,
    `import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkEntry = path.join(root, 'node_modules', 'foundry-local-sdk', 'dist', 'index.js');
if (!fs.existsSync(sdkEntry)) {
  console.error('SDK entry missing:', sdkEntry);
  process.exit(2);
}

const mod = await import(pathToFileURL(sdkEntry).href);
if (!mod.FoundryLocalManager) {
  console.error('FoundryLocalManager export missing');
  process.exit(3);
}
console.log('FoundryLocalManager:', typeof mod.FoundryLocalManager);

const plat = process.platform + '-' + process.arch;
const coreName =
  process.platform === 'win32'
    ? 'Microsoft.AI.Foundry.Local.Core.dll'
    : process.platform === 'darwin'
      ? 'Microsoft.AI.Foundry.Local.Core.dylib'
      : 'Microsoft.AI.Foundry.Local.Core.so';
const core = path.join(
  root,
  'node_modules',
  'foundry-local-sdk',
  'foundry-local-core',
  plat,
  coreName,
);
if (!fs.existsSync(core)) {
  console.error('core missing (run npm run ensure:foundry):', core);
  process.exit(5);
}
console.log('core present:', core);

try {
  const mgr = mod.FoundryLocalManager.create({
    appName: 'flint-smoke',
    logLevel: 'error',
    libraryPath: core,
  });
  console.log('manager create: ok', !!mgr);
} catch (e) {
  console.error('manager create failed:', e?.message || e);
  process.exit(4);
}
`,
    'utf8',
  );

  const napi = run(nodeBin, [loader], {
    NODE_PATH: path.join(root, 'node_modules'),
  });
  try {
    fs.unlinkSync(loader);
  } catch {
    /* ignore */
  }

  if (napi.status !== 0) {
    console.error('  ✗ N-API / SDK load failed');
    if (napi.stdout) console.error(napi.stdout);
    if (napi.stderr) console.error(napi.stderr);
    if (napi.error) console.error(napi.error);
    process.exit(napi.status || 1);
  }
  console.log(
    (napi.stdout || '')
      .trim()
      .split(/\r?\n/)
      .map((l) => `  ✓ ${l}`)
      .join('\n'),
  );
  console.log('\nSmoke passed: bundled Node 22 + foundry-local-sdk native load.');
}

main();
