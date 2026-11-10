// Copy the platform koffi native next to the packaged koffi package.
// koffi loads ../../../@koromix/koffi-<platform>-<arch> from its own file.
// The installer maps that directory to $RESOURCE/@koromix/. Dev uses node_modules.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validateKoffiNative(koffiRoot, nativeRoot, platformKey) {
  if (platformKey !== 'win32-x64') return;
  const native = path.join(nativeRoot, `koffi-${platformKey}`);
  for (const file of ['package.json', 'index.js', path.join('win32_x64', 'koffi.node')]) {
    const target = path.join(native, file);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.statSync(target).size === 0) {
      throw new Error(`missing koffi-${platformKey} file: ${target}`);
    }
  }
  const expected = JSON.parse(fs.readFileSync(path.join(koffiRoot, 'package.json'), 'utf8')).version;
  const actual = JSON.parse(fs.readFileSync(path.join(native, 'package.json'), 'utf8')).version;
  if (typeof expected !== 'string' || actual !== expected) {
    throw new Error(`koffi native version ${actual} does not match package version ${expected}`);
  }
}

function stageKoffiNative(root, platform = process.platform, arch = process.arch) {
  const source = path.join(root, 'node_modules', '@koromix');
  const dest = path.join(root, 'runtime', 'koffi-stage', '@koromix');
  const names = fs.existsSync(source)
    ? fs.readdirSync(source).filter((name) => name.startsWith('koffi-'))
    : [];
  const needed = `koffi-${platform}-${arch}`;
  if (platform === 'win32' && arch === 'x64' && !names.includes(needed)) {
    throw new Error(`missing ${needed}; Windows x64 CUDA registration needs it`);
  }
  validateKoffiNative(path.join(root, 'node_modules', 'koffi'), source, `${platform}-${arch}`);

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of names) {
    fs.cpSync(path.join(source, name), path.join(dest, name), { recursive: true });
  }
  return names;
}

module.exports = { stageKoffiNative, validateKoffiNative };

if (require.main === module) {
  try {
    const names = stageKoffiNative(path.resolve(__dirname, '..'));
    console.log(`[stage-koffi-native] staged ${names.length ? names.join(', ') : 'no platform package'}`);
  } catch (error) {
    console.error(`[stage-koffi-native] ${error.message}`);
    process.exitCode = 1;
  }
}
