#!/usr/bin/env node
/**
 * Copy Foundry native binaries between a CI cache directory and the SDK
 * install location. The SDK's install script skips nuget.org when
 * Microsoft.AI.Foundry.Local.Core.* is already present.
 *
 * Usage:
 *   node scripts/hydrate-foundry-native.cjs --restore
 *   node scripts/hydrate-foundry-native.cjs --save
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(root, 'runtime', 'foundry-native-cache');
const DEST_DIR = path.join(root, 'node_modules', 'foundry-local-sdk', 'foundry-local-core');

function copyDir(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
  return true;
}

function dirHasFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    const entries = fs.readdirSync(dir, { recursive: true });
    return entries.some((entry) => {
      const full = path.join(dir, entry);
      return fs.statSync(full).isFile();
    });
  } catch {
    return false;
  }
}

function restore() {
  if (!dirHasFiles(CACHE_DIR)) return;
  if (!fs.existsSync(path.dirname(DEST_DIR))) return;
  copyDir(CACHE_DIR, DEST_DIR);
  console.log(`[hydrate-foundry-native] restored cache into ${path.relative(root, DEST_DIR)}`);
}

function save() {
  if (!dirHasFiles(DEST_DIR)) {
    console.log('[hydrate-foundry-native] no native payload to cache');
    return;
  }
  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
  if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  copyDir(DEST_DIR, CACHE_DIR);
  console.log(`[hydrate-foundry-native] saved native payload to ${path.relative(root, CACHE_DIR)}`);
}

const mode = process.argv[2];
if (mode === '--restore') restore();
else if (mode === '--save') save();
else {
  console.error('Usage: node scripts/hydrate-foundry-native.cjs --restore|--save');
  process.exit(1);
}
