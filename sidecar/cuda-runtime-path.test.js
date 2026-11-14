import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDllDirectory,
  prepareCudaRuntime,
  resolveCudaBinDirectory,
} from './cuda-runtime-path.js';

const PROGRAM_FILES = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';

const native = vi.hoisted(() => ({
  add: vi.fn(),
  func: vi.fn(),
  load: vi.fn(),
}));
vi.mock('koffi', () => ({
  default: { load: native.load },
}));
afterEach(() => vi.unstubAllGlobals());

describe('resolveCudaBinDirectory', () => {
  it('uses CUDA_PATH/bin when that directory exists', () => {
    const exists = vi.fn((directory) => directory === 'D:\\CUDA\\v12.6\\bin');
    expect(resolveCudaBinDirectory({
      env: { CUDA_PATH: 'D:\\CUDA\\v12.6' },
      exists,
      readdir: () => [],
    })).toBe('D:\\CUDA\\v12.6\\bin');
  });

  it('falls through a missing CUDA_PATH to the newest Program Files v12 bin', () => {
    const exists = vi.fn((directory) => directory === `${PROGRAM_FILES}\\v12.8\\bin`);
    expect(resolveCudaBinDirectory({
      env: { CUDA_PATH: 'D:\\missing' },
      exists,
      readdir: () => ['v11.8', 'v12.6', 'v12.8', 'notes.txt'],
    })).toBe(`${PROGRAM_FILES}\\v12.8\\bin`);
  });

  describe('AddDllDirectory binding', () => {
    it('surfaces binding failure, retries initialization, rejects null cookies, and reuses a valid binding', async () => {
      vi.stubGlobal('process', { ...process, platform: 'win32' });
      native.load.mockImplementationOnce(() => { throw new Error('native binding unavailable'); })
        .mockReturnValue({ func: native.func });
      native.func.mockReturnValue(native.add);
      await expect(prepareCudaRuntime({
        platform: 'win32',
        arch: 'x64',
        env: { CUDA_PATH: 'D:\\CUDA\\v12.8' },
        exists: () => true,
        readdir: () => [],
      })).resolves.toMatchObject({ ok: false, reason: 'native binding unavailable' });
      native.add.mockReturnValueOnce(null).mockReturnValueOnce(0).mockReturnValueOnce(0n)
        .mockReturnValueOnce(42n).mockReturnValueOnce(43n);
      for (let i = 0; i < 3; i++) {
        await expect(addDllDirectory('D:\\CUDA\\v12.8\\bin')).rejects.toThrow(/no directory cookie/);
      }
      await expect(addDllDirectory('D:\\CUDA\\v12.8\\bin')).resolves.toBe(42n);
      await expect(addDllDirectory('E:\\CUDA\\v12.8\\bin')).resolves.toBe(43n);
      expect(native.load).toHaveBeenCalledTimes(2);
      expect(native.func).toHaveBeenCalledTimes(1);
      expect(native.func).toHaveBeenCalledWith('void * __stdcall AddDllDirectory(str16)');
      expect(native.add).toHaveBeenLastCalledWith('E:\\CUDA\\v12.8\\bin');
    });
  });

  it('skips a CUDA_PATH that names another major version and uses CUDA 12', () => {
    const exists = vi.fn((directory) => directory.endsWith('\\bin'));
    expect(resolveCudaBinDirectory({
      env: {
        CUDA_PATH: `${PROGRAM_FILES}\\v13.3`,
        CUDA_PATH_V12_8: `${PROGRAM_FILES}\\v12.8`,
      },
      exists,
      readdir: () => ['v12.8', 'v13.3'],
    })).toBe(`${PROGRAM_FILES}\\v12.8\\bin`);
    expect(exists).not.toHaveBeenCalledWith(`${PROGRAM_FILES}\\v13.3\\bin`);
  });

  it('uses CUDA_PATH_V12_* before a Program Files install', () => {
    const exists = vi.fn((directory) => directory === 'E:\\v12\\bin');
    expect(resolveCudaBinDirectory({
      env: { CUDA_PATH_V12_8: 'E:\\v12' },
      exists,
      readdir: () => ['v12.9'],
    })).toBe('E:\\v12\\bin');
    expect(exists).not.toHaveBeenCalledWith(`${PROGRAM_FILES}\\v12.9\\bin`);
  });

  it('returns null when no CUDA 12 bin directory exists', () => {
    expect(resolveCudaBinDirectory({
      env: {},
      exists: () => false,
      readdir: () => ['v11.8'],
    })).toBeNull();
  });

  it('selects numeric minor and patch versions instead of lexical directory order', () => {
    expect(resolveCudaBinDirectory({
      env: {},
      exists: () => true,
      readdir: () => ['v12.9', 'v12.10.1', 'v12.10.2'],
    })).toBe(`${PROGRAM_FILES}\\v12.10.2\\bin`);
  });

  it('keeps an explicit CUDA root usable when the default installation directory cannot be read', () => {
    expect(resolveCudaBinDirectory({
      env: { CUDA_PATH: ' D:\\custom-cuda\\ ' },
      exists: (directory) => directory === 'D:\\custom-cuda\\bin',
      readdir: () => { throw new Error('access denied'); },
    })).toBe('D:\\custom-cuda\\bin');
  });
});

describe('prepareCudaRuntime', () => {
  it('does nothing on platforms other than Windows x64', async () => {
    const addDirectory = vi.fn();
    await expect(prepareCudaRuntime({
      platform: 'linux',
      arch: 'x64',
      addDllDirectory: addDirectory,
    })).resolves.toEqual({ ok: true, required: false });
    await expect(prepareCudaRuntime({
      platform: 'win32',
      arch: 'arm64',
      addDllDirectory: addDirectory,
    })).resolves.toEqual({ ok: true, required: false });
    expect(addDirectory).not.toHaveBeenCalled();
  });

  it('fails CUDA explicitly when the Windows x64 directory is missing', async () => {
    const addDirectory = vi.fn();
    const prepared = await prepareCudaRuntime({
      platform: 'win32',
      arch: 'x64',
      env: {},
      exists: () => false,
      readdir: () => [],
      addDllDirectory: addDirectory,
    });
    expect(prepared.ok).toBe(false);
    expect(prepared.required).toBe(true);
    expect(prepared.reason).toContain('CUDA 12 runtime directory was not found');
    expect(addDirectory).not.toHaveBeenCalled();
  });

  it('registers the directory and reports a failed AddDllDirectory', async () => {
    const directory = 'D:\\CUDA\\v12.8\\bin';
    const addDirectory = vi.fn(async () => 'cookie');
    await expect(prepareCudaRuntime({
      platform: 'win32',
      arch: 'x64',
      env: { CUDA_PATH: 'D:\\CUDA\\v12.8' },
      exists: (candidate) => candidate === directory,
      readdir: () => [],
      addDllDirectory: addDirectory,
    })).resolves.toMatchObject({ ok: true, required: true, directory });
    expect(addDirectory).toHaveBeenCalledWith(directory);

    const failed = await prepareCudaRuntime({
      platform: 'win32',
      arch: 'x64',
      env: { CUDA_PATH: 'D:\\CUDA\\v12.8' },
      exists: () => true,
      readdir: () => [],
      addDllDirectory: () => {
        throw new Error('AddDllDirectory returned no directory cookie');
      },
    });
    expect(failed.ok).toBe(false);
    expect(failed.reason).toContain('no directory cookie');
  });

  it('adds the cached CUDA provider directory to PATH once', async () => {
    const env = {
      CUDA_PATH: 'D:\\CUDA\\v12.8',
      PATH: 'C:\\Windows\\System32',
    };
    const prepareOptions = {
      platform: 'win32',
      arch: 'x64',
      env,
      exists: () => true,
      readdir: () => [],
      addDllDirectory: vi.fn(),
      cudaExecutionProviderDirectory: 'D:\\Users\\test\\.flint\\ep\\cuda-ep',
    };

    await expect(prepareCudaRuntime(prepareOptions)).resolves.toMatchObject({ ok: true });
    await prepareCudaRuntime(prepareOptions);
    expect(env.PATH).toBe('D:\\Users\\test\\.flint\\ep\\cuda-ep;C:\\Windows\\System32');
  });

  it('does not load kernel32 except on Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    await expect(addDllDirectory('D:\\CUDA\\v12.8\\bin')).rejects.toThrow(/only available on Windows/);
  });

  it('passes the CUDA preparer from the production sidecar registration call', () => {
    const source = readFileSync(join(process.cwd(), 'sidecar', 'foundry-sidecar-main.js'), 'utf8');
    expect(source).toContain('prepareCudaRuntime: options?.prepareCudaRuntime ?? prepareCudaRuntimeForSidecar');
    expect(source).toContain("providerCacheDirectory(epRoot, 'CUDAExecutionProvider')");
  });
});
