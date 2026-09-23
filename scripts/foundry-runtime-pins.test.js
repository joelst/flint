import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  describeRuntimeProblem,
  readUtf16FileVersion,
  removeUnpinnedRuntimeFiles,
  runtimeProblems,
} = require('./foundry-runtime-pins.cjs');
const hydrate = join(process.cwd(), 'scripts', 'hydrate-foundry-native.cjs');

/** A buffer with a Windows FileVersion resource, like the real DLLs. */
function dll (version) {
  const payload = Buffer.from(`FileVersion\0${version}\0`, 'utf16le');
  const buffer = Buffer.alloc(4096);
  payload.copy(buffer, 64);
  return buffer;
}

// FileVersion strings read from the real Foundry 1.2.4 and 2.0.1 packages.
const ORT_124 = '1.26.20260520.2.756157b';
const ORT_201 = '1.28.0.20260724.14.da9b5e3';

function makeSdk ({ ort = ORT_124, shared = ort, genai = '0.14.1' } = {}) {
  const sdkRoot = mkdtempSync(join(tmpdir(), 'flint-runtime-pins-'));
  writeFileSync(join(sdkRoot, 'deps_versions.json'), JSON.stringify({
    onnxruntime: { version: '1.26.0' },
    'onnxruntime-genai': { version: '0.14.1' },
  }));
  const dir = join(sdkRoot, 'foundry-local-core', 'win32-x64');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Microsoft.AI.Foundry.Local.Core.dll'), dll('1.2.0'));
  if (ort) writeFileSync(join(dir, 'onnxruntime.dll'), typeof ort === 'string' ? dll(ort) : ort);
  if (shared) writeFileSync(join(dir, 'onnxruntime_providers_shared.dll'), typeof shared === 'string' ? dll(shared) : shared);
  if (genai) writeFileSync(join(dir, 'onnxruntime-genai.dll'), dll(genai));
  return { sdkRoot, dir };
}

describe('Foundry 1.2.4 runtime pins', () => {
  it('reads the FileVersion of both ORT build styles', () => {
    expect(readUtf16FileVersion(dll(ORT_124))).toBe(ORT_124);
    expect(readUtf16FileVersion(dll(ORT_201))).toBe(ORT_201);
    expect(readUtf16FileVersion(Buffer.alloc(4096))).toBeNull();
  });

  it('accepts the 1.2.4 runtime, whose FileVersion has a date in the patch field', () => {
    const { sdkRoot } = makeSdk();
    expect(runtimeProblems(sdkRoot, 'win32-x64')).toEqual([]);
    expect(removeUnpinnedRuntimeFiles(sdkRoot)).toEqual([]);
  });

  it('rejects the 2.0.1 runtime left beside the 1.2.4 core', () => {
    const { sdkRoot } = makeSdk({ ort: ORT_201, genai: '0.15.2' });
    const problems = runtimeProblems(sdkRoot, 'win32-x64');
    expect(problems.map((p) => [p.role, p.reason])).toEqual([
      ['ONNX Runtime', 'wrong-version'],
      ['ONNX Runtime', 'wrong-version'],
      ['ONNX Runtime GenAI', 'wrong-version'],
    ]);
    expect(describeRuntimeProblem(problems[0])).toBe(`version ${ORT_201}, not 1.26.0`);
  });

  it('removes the whole ORT package when only its shared library is stale', () => {
    // The installer reinstalls the package only when onnxruntime.dll is missing.
    const { sdkRoot, dir } = makeSdk({ shared: ORT_201 });
    const removed = removeUnpinnedRuntimeFiles(sdkRoot).map((file) => file.slice(dir.length + 1)).sort();
    expect(removed).toEqual(['onnxruntime.dll', 'onnxruntime_providers_shared.dll']);
    expect(readdirSync(dir).sort()).toEqual(['Microsoft.AI.Foundry.Local.Core.dll', 'onnxruntime-genai.dll']);
  });

  it('treats a runtime with no readable FileVersion as not the pinned build', () => {
    const { sdkRoot, dir } = makeSdk({ ort: Buffer.alloc(4096) });
    expect(runtimeProblems(sdkRoot, 'win32-x64')[0]).toMatchObject({ reason: 'unknown-version' });
    removeUnpinnedRuntimeFiles(sdkRoot);
    expect(existsSync(join(dir, 'onnxruntime.dll'))).toBe(false);
  });

  it('reports a missing runtime without removing anything', () => {
    const { sdkRoot } = makeSdk({ genai: null });
    expect(runtimeProblems(sdkRoot, 'win32-x64')).toEqual([
      expect.objectContaining({ role: 'ONNX Runtime GenAI', reason: 'missing' }),
    ]);
    expect(removeUnpinnedRuntimeFiles(sdkRoot)).toEqual([]);
  });

  it('does not check macOS or Linux libraries, which carry no FileVersion', () => {
    const { sdkRoot } = makeSdk();
    expect(runtimeProblems(sdkRoot, 'darwin-arm64')).toEqual([]);
  });
});

describe('hydrate-foundry-native with a stale runtime', () => {
  const run = (mode, cacheDir, destDir) => spawnSync(process.execPath, [hydrate, mode], {
    encoding: 'utf8',
    env: { ...process.env, FLINT_FOUNDRY_CACHE_DIR: cacheDir, FLINT_FOUNDRY_DEST_DIR: destDir },
  });

  it('drops a cached 2.0.1 runtime on restore so the SDK installer downloads the pinned one', () => {
    const { sdkRoot } = makeSdk({ ort: null, shared: null, genai: null });
    const cache = mkdtempSync(join(tmpdir(), 'flint-native-cache-'));
    mkdirSync(join(cache, 'win32-x64'), { recursive: true });
    writeFileSync(join(cache, 'win32-x64', 'onnxruntime.dll'), dll(ORT_201));
    writeFileSync(join(cache, 'win32-x64', 'onnxruntime_providers_shared.dll'), dll(ORT_201));
    writeFileSync(join(cache, 'win32-x64', 'onnxruntime-genai.dll'), dll('0.15.2'));

    const result = run('--restore', cache, join(sdkRoot, 'foundry-local-core'));

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(sdkRoot, 'foundry-local-core', 'win32-x64'))).toEqual(['Microsoft.AI.Foundry.Local.Core.dll']);
    expect(result.stdout).toContain('not the pinned build');
  });

  it('refuses to save a runtime that is not the pinned build', () => {
    const { sdkRoot } = makeSdk({ ort: ORT_201 });
    const cache = join(mkdtempSync(join(tmpdir(), 'flint-native-save-')), 'cache');

    const result = run('--save', cache, join(sdkRoot, 'foundry-local-core'));

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(cache)).toBe(false);
    expect(result.stdout).toContain('not saving');
  });

  it('saves a payload whose runtime is the pinned build', () => {
    const { sdkRoot } = makeSdk();
    const cache = join(mkdtempSync(join(tmpdir(), 'flint-native-save-ok-')), 'cache');

    const result = run('--save', cache, join(sdkRoot, 'foundry-local-core'));

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(cache, 'win32-x64')).sort()).toEqual([
      'Microsoft.AI.Foundry.Local.Core.dll',
      'onnxruntime-genai.dll',
      'onnxruntime.dll',
      'onnxruntime_providers_shared.dll',
    ]);
  });
});
