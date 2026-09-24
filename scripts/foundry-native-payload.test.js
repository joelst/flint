import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  describeInvalidNativeFile,
  platformKeyForTriple,
  readUtf16FileVersion,
  removeUnpinnedRuntimeFiles,
  requiredNativeFiles,
  validateNativePayload,
} = require('./foundry-native-payload.cjs');
const ensureScript = join(process.cwd(), 'scripts', 'ensure-foundry-native.cjs');

const dependencies = { ortVersion: '1.28.0', genaiVersion: '0.15.2' };

function fileVersionBytes(version, minBytes) {
  const payload = Buffer.from(`FileVersion\0${version}`, 'utf16le');
  const buffer = Buffer.alloc(Math.max(minBytes, payload.length));
  payload.copy(buffer);
  return buffer;
}

/** A fixture file: runtime files carry their pinned FileVersion, like the real DLLs. */
function pinnedBody(file) {
  return file.runtimeVersion
    ? fileVersionBytes(`${file.runtimeVersion}.0`, file.minBytes)
    : Buffer.alloc(file.minBytes);
}

function makeSdk(platformKey, omitted = null) {
  const sdkRoot = mkdtempSync(join(tmpdir(), 'flint-native-payload-'));
  writeFileSync(
    join(sdkRoot, 'deps_versions.json'),
    JSON.stringify({
      onnxruntime: { version: dependencies.ortVersion },
      'onnxruntime-genai': { version: dependencies.genaiVersion },
    }),
  );
  const platformDir = join(sdkRoot, 'prebuilds', platformKey);
  mkdirSync(platformDir, { recursive: true });
  for (const file of requiredNativeFiles(platformKey, dependencies)) {
    if (file.name !== omitted) {
      writeFileSync(join(platformDir, file.name), pinnedBody(file));
    }
  }
  return sdkRoot;
}

describe('Foundry native payload manifest', () => {
  it('maps release target triples to SDK platform directories', () => {
    expect(platformKeyForTriple('x86_64-pc-windows-msvc')).toBe('win32-x64');
    expect(platformKeyForTriple('aarch64-apple-darwin')).toBe('darwin-arm64');
    expect(platformKeyForTriple('unknown-target')).toBeNull();
  });

  it('derives the versioned macOS ONNX Runtime filename from SDK metadata', () => {
    const files = requiredNativeFiles('darwin-arm64', dependencies);
    expect(files.map((file) => file.name)).toContain('libonnxruntime.1.dylib');
    expect(files.find((file) => file.name === 'libonnxruntime.dylib')?.symlinkTo).toBe(
      'libonnxruntime.1.dylib',
    );
  });

  it('rejects a partial install that has the core but is missing ORT-GenAI', () => {
    const sdkRoot = makeSdk('win32-x64', 'onnxruntime-genai.dll');
    const result = validateNativePayload(sdkRoot, 'win32-x64');

    expect(result.invalid.map((file) => file.name)).toEqual(['onnxruntime-genai.dll']);
  });

  it('accepts a complete model-load payload', () => {
    const sdkRoot = makeSdk('linux-x64');
    expect(validateNativePayload(sdkRoot, 'linux-x64').invalid).toEqual([]);
  });

  it('accepts a macOS ONNX Runtime alias that packaging copied as a regular file', () => {
    const sdkRoot = makeSdk('darwin-arm64');
    expect(validateNativePayload(sdkRoot, 'darwin-arm64').invalid).toEqual([]);
  });

  it('reports a missing macOS ONNX Runtime alias as missing, not as a bad symlink', () => {
    const sdkRoot = makeSdk('darwin-arm64', 'libonnxruntime.dylib');
    const invalid = validateNativePayload(sdkRoot, 'darwin-arm64').invalid;

    expect(invalid.map((file) => file.name)).toEqual(['libonnxruntime.dylib']);
    expect(describeInvalidNativeFile(invalid[0])).toBe('missing');
  });

  it('rejects a macOS ONNX Runtime alias that points at the wrong library', () => {
    const sdkRoot = makeSdk('darwin-arm64');
    const alias = join(sdkRoot, 'prebuilds', 'darwin-arm64', 'libonnxruntime.dylib');
    rmSync(alias);
    try {
      symlinkSync('libonnxruntime-genai.dylib', alias);
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'ENOTSUP')) return;
      throw error;
    }

    const invalid = validateNativePayload(sdkRoot, 'darwin-arm64').invalid;
    expect(invalid.map((file) => file.name)).toEqual(['libonnxruntime.dylib']);
    expect(describeInvalidNativeFile(invalid[0])).toBe(
      'a symlink to libonnxruntime-genai.dylib, not libonnxruntime.1.dylib',
    );
  });

  it('reads the Windows FileVersion resource, including the ORT build suffix', () => {
    const buffer = fileVersionBytes('1.28.0.20260724.14.da9b5e3', 64);
    expect(readUtf16FileVersion(buffer)).toBe('1.28.0.20260724.14.da9b5e3');
  });

  it('rejects an ONNX Runtime DLL built for a different Foundry SDK', () => {
    const sdkRoot = makeSdk('win32-x64');
    const dll = join(sdkRoot, 'prebuilds', 'win32-x64', 'onnxruntime.dll');
    writeFileSync(dll, fileVersionBytes('1.26.0.20260520.2', 1_000_000));

    const invalid = validateNativePayload(sdkRoot, 'win32-x64').invalid;
    expect(invalid.map((file) => file.name)).toEqual(['onnxruntime.dll']);
    expect(describeInvalidNativeFile(invalid[0])).toBe('version 1.26.0.20260520.2, not 1.28.0');
  });

  it('accepts the 2.0.1 ONNX Runtime file version pinned as 1.28.0', () => {
    const sdkRoot = makeSdk('win32-x64');
    writeFileSync(
      join(sdkRoot, 'prebuilds', 'win32-x64', 'onnxruntime.dll'),
      fileVersionBytes('1.28.0.20260724.14.da9b5e3', 1_000_000),
    );
    writeFileSync(
      join(sdkRoot, 'prebuilds', 'win32-x64', 'onnxruntime-genai.dll'),
      fileVersionBytes('0.15.2', 1_000_000),
    );

    expect(validateNativePayload(sdkRoot, 'win32-x64').invalid).toEqual([]);
  });

  it('rejects a Windows ONNX Runtime DLL with no readable FileVersion', () => {
    const sdkRoot = makeSdk('win32-x64');
    writeFileSync(join(sdkRoot, 'prebuilds', 'win32-x64', 'onnxruntime.dll'), Buffer.alloc(1_000_000));

    const invalid = validateNativePayload(sdkRoot, 'win32-x64').invalid;
    expect(invalid.map((file) => file.name)).toEqual(['onnxruntime.dll']);
    expect(invalid[0].reason).toBe('unknown-version');
    expect(describeInvalidNativeFile(invalid[0])).toBe('missing a readable FileVersion, expected 1.28.0');
    rmSync(sdkRoot, { recursive: true, force: true });
  });

  it('deletes a Windows runtime DLL with no readable FileVersion so the installer downloads the pinned one', () => {
    const sdkRoot = makeSdk('win32-x64');
    const dll = join(sdkRoot, 'prebuilds', 'win32-x64', 'onnxruntime-genai.dll');
    writeFileSync(dll, Buffer.alloc(1_000_000));

    expect(removeUnpinnedRuntimeFiles(sdkRoot)).toEqual([dll]);
    expect(existsSync(dll)).toBe(false);
    rmSync(sdkRoot, { recursive: true, force: true });
  });

  it('does not read a Windows FileVersion resource from a macOS runtime', () => {
    const sdkRoot = makeSdk('darwin-arm64');
    const runtime = join(sdkRoot, 'prebuilds', 'darwin-arm64', 'libonnxruntime.1.dylib');
    writeFileSync(runtime, fileVersionBytes('1.26.0', 1_000_000));
    expect(validateNativePayload(sdkRoot, 'darwin-arm64').invalid).toEqual([]);
    rmSync(sdkRoot, { recursive: true, force: true });
  });

  it('rejects a truncated core that is present but cannot be a real runtime', () => {
    const sdkRoot = makeSdk('win32-x64');
    writeFileSync(join(sdkRoot, 'prebuilds', 'win32-x64', 'foundry_local.dll'), 'truncated');

    expect(validateNativePayload(sdkRoot, 'win32-x64').invalid.map((file) => file.name)).toContain(
      'foundry_local.dll',
    );
  });

  it('rejects an SDK platform that the installer cannot populate', () => {
    const sdkRoot = makeSdk('linux-x64');
    expect(() => validateNativePayload(sdkRoot, 'darwin-x64')).toThrow(
      'Unsupported Foundry platformKey',
    );
  });

  it('runs the SDK installer as the requested cross-target platform before validating', () => {
    const sdkRoot = mkdtempSync(join(tmpdir(), 'flint-cross-target-install-'));
    const platformDir = join(sdkRoot, 'prebuilds', 'linux-arm64');
    const scriptDir = join(sdkRoot, 'script');
    mkdirSync(platformDir, { recursive: true });
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(sdkRoot, 'deps_versions.json'),
      JSON.stringify({
        onnxruntime: { version: dependencies.ortVersion },
        'onnxruntime-genai': { version: dependencies.genaiVersion },
      }),
    );
    for (const file of requiredNativeFiles('linux-arm64', dependencies)) {
      if (!file.name.includes('onnxruntime')) {
        writeFileSync(join(platformDir, file.name), Buffer.alloc(file.minBytes));
      }
    }
    writeFileSync(
      join(scriptDir, 'install-native.cjs'),
      `const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
async function main() {
  const dir = path.join(__dirname, '..', 'prebuilds', os.platform() + '-' + os.arch());
  fs.writeFileSync(path.join(__dirname, '..', 'installed-platform.txt'), os.platform() + '-' + os.arch());
  fs.writeFileSync(path.join(dir, 'libonnxruntime.so.1'), Buffer.alloc(1000000));
  fs.writeFileSync(path.join(dir, 'libonnxruntime-genai.so'), Buffer.alloc(1000000));
  return 0;
}
module.exports = { main };
if (require.main === module) main().then((code) => { process.exitCode = code; });
`,
    );

    const result = spawnSync(process.execPath, [ensureScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FLINT_FOUNDRY_SDK_DIR: sdkRoot,
        FOUNDRY_PLATFORM_KEY: 'linux-arm64',
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(join(sdkRoot, 'installed-platform.txt'), 'utf8')).toBe('linux-arm64');
  });

  it('deletes a leftover ONNX Runtime DLL before the SDK installer can skip it', () => {
    const sdkRoot = mkdtempSync(join(tmpdir(), 'flint-ort-replace-'));
    const platformDir = join(sdkRoot, 'prebuilds', 'win32-x64');
    const scriptDir = join(sdkRoot, 'script');
    mkdirSync(platformDir, { recursive: true });
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(sdkRoot, 'deps_versions.json'),
      JSON.stringify({
        onnxruntime: { version: dependencies.ortVersion },
        'onnxruntime-genai': { version: dependencies.genaiVersion },
      }),
    );
    for (const file of requiredNativeFiles('win32-x64', dependencies)) {
      const body = file.name === 'onnxruntime.dll'
        ? fileVersionBytes('1.26.0.20260520.2', file.minBytes)
        : pinnedBody(file);
      writeFileSync(join(platformDir, file.name), body);
    }
    const pinnedOrt = fileVersionBytes('1.28.0.20260724.14', 1_000_000).toString('base64');
    writeFileSync(
      join(scriptDir, 'install-native.cjs'),
      `const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const dll = path.join(__dirname, '..', 'prebuilds', 'win32-x64', 'onnxruntime.dll');
  fs.writeFileSync(path.join(__dirname, '..', 'dll-present-at-install.txt'), fs.existsSync(dll) ? 'present' : 'absent');
  fs.writeFileSync(dll, Buffer.from('${pinnedOrt}', 'base64'));
  return 0;
}
module.exports = { main };
if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}
`,
    );

    const result = spawnSync(process.execPath, [ensureScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FLINT_FOUNDRY_SDK_DIR: sdkRoot,
        FOUNDRY_PLATFORM_KEY: 'win32-x64',
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(join(sdkRoot, 'dll-present-at-install.txt'), 'utf8')).toBe('absent');
  });
});
