import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  platformKeyForTriple,
  requiredNativeFiles,
  validateNativePayload,
} = require('./foundry-native-payload.cjs');

const dependencies = { ortVersion: '1.28.0', genaiVersion: '0.15.2' };

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
      writeFileSync(join(platformDir, file.name), Buffer.alloc(file.minBytes));
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
});
