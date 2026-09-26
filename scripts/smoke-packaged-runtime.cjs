#!/usr/bin/env node
/**
 * Launch a debug Flint binary with FLINT_RUNTIME_SMOKE=1 and require a 0 exit
 * once the sidecar reports ready. Does not load a model. GUI may flash on CI.
 *
 * Usage: node scripts/smoke-packaged-runtime.cjs [--exe path]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function defaultExe() {
  const debug = path.join(root, 'src-tauri', 'target', 'debug');
  if (process.platform === 'win32') {
    return path.join(debug, 'Flint.exe');
  }
  return path.join(debug, 'Flint');
}

function main() {
  const args = process.argv.slice(2);
  let exe = defaultExe();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--exe' && args[i + 1]) exe = args[i + 1];
  }
  if (!fs.existsSync(exe)) {
    throw new Error(`Flint debug binary not found at ${exe}. Build with tauri --debug first.`);
  }
  console.log(`[smoke-packaged-runtime] launching ${exe}`);
  const result = spawnSync(exe, [], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FLINT_RUNTIME_SMOKE: '1' },
    timeout: 60_000,
    windowsHide: false,
  });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (output.trim()) console.log(output.trim());
  if (result.status !== 0) {
    throw new Error(`Runtime smoke failed with exit ${result.status}`);
  }
  console.log('[smoke-packaged-runtime] ready');
}

main();
