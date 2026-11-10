// Copy the platform koffi native next to the packaged koffi package.
// koffi loads ../../../@koromix/koffi-<platform>-<arch> from its own file.
// The installer maps that directory to $RESOURCE/@koromix/. Dev uses node_modules.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', '@koromix');
const dest = path.join(root, 'runtime', 'koffi-stage', '@koromix');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

const names = fs.existsSync(source)
  ? fs.readdirSync(source).filter((name) => name.startsWith('koffi-'))
  : [];
for (const name of names) {
  fs.cpSync(path.join(source, name), path.join(dest, name), { recursive: true });
}

const needed = `koffi-${process.platform}-${process.arch}`;
if (process.platform === 'win32' && process.arch === 'x64' && !names.includes(needed)) {
  console.error(`[stage-koffi-native] missing ${needed}; Windows x64 CUDA registration needs it`);
  process.exit(1);
}

console.log(`[stage-koffi-native] staged ${names.length ? names.join(', ') : 'no platform package'}`);
