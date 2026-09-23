import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  providerCacheDirectory,
  providerCacheSlug,
  providerNamesInText,
  rebuildBrokenExecutionProviders,
  removeProviderCache,
} from './execution-provider-cache.js';

describe('provider cache paths', () => {
  it('maps downloadable providers onto Foundry cache folders', () => {
    expect(providerCacheSlug('CUDAExecutionProvider')).toBe('cuda-ep');
    expect(providerCacheSlug('WebGpuExecutionProvider')).toBe('webgpu-ep');
    expect(providerCacheSlug('CPUExecutionProvider')).toBeNull();
    expect(providerCacheSlug('../cuda-ep')).toBeNull();
    expect(providerCacheSlug('CUDAExecutionProvider/../../outside')).toBeNull();
  });

  it('keeps the directory inside the ep root', () => {
    const root = path.join(os.tmpdir(), 'flint-ep-root');
    expect(providerCacheDirectory(root, 'CUDAExecutionProvider')).toBe(path.resolve(root, 'cuda-ep'));
    expect(providerCacheDirectory(root, 'CPUExecutionProvider')).toBeNull();
    expect(providerCacheDirectory(root, '..\\..\\Windows')).toBeNull();
  });
});

describe('removeProviderCache', () => {
  it('removes only the named provider directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-ep-'));
    const cuda = path.join(root, 'cuda-ep');
    const webgpu = path.join(root, 'webgpu-ep');
    fs.mkdirSync(cuda);
    fs.writeFileSync(path.join(cuda, 'onnxruntime_providers_cuda.dll'), 'stale');
    fs.mkdirSync(webgpu);
    fs.writeFileSync(path.join(webgpu, 'onnxruntime_providers_webgpu.dll'), 'ok');

    expect(await removeProviderCache(root, 'CUDAExecutionProvider')).toBe(true);
    expect(fs.existsSync(cuda)).toBe(false);
    expect(fs.existsSync(webgpu)).toBe(true);
    expect(await removeProviderCache(root, 'CUDAExecutionProvider')).toBe(false);
    expect(await removeProviderCache(root, 'CPUExecutionProvider')).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('providerNamesInText', () => {
  it('reads provider names out of a 1.2.4 status or a 2.0.1 error', () => {
    expect(providerNamesInText(
      'EP registration partially complete: 1 succeeded, 1 failed (CUDAExecutionProvider)',
    )).toEqual(['CUDAExecutionProvider']);
    expect(providerNamesInText('Failed to register WebGpuExecutionProvider and CUDAExecutionProvider'))
      .toEqual(['WebGpuExecutionProvider', 'CUDAExecutionProvider']);
  });
});

describe('rebuildBrokenExecutionProviders', () => {
  it('registers an unregistered provider by name after removing its cache', async () => {
    const removed = [];
    const calls = [];
    const registered = new Set(['WebGpuExecutionProvider']);
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [
        { name: 'WebGpuExecutionProvider', isRegistered: registered.has('WebGpuExecutionProvider') },
        { name: 'CUDAExecutionProvider', isRegistered: registered.has('CUDAExecutionProvider') },
      ],
      removeCache: (name) => {
        removed.push(name);
        return name === 'CUDAExecutionProvider';
      },
      downloadAndRegister: async (names) => {
        calls.push(names);
        for (const name of names ?? []) registered.add(name);
        return { failedEps: [], success: true };
      },
    });
    expect(removed).toEqual(['CUDAExecutionProvider']);
    expect(calls).toEqual([['CUDAExecutionProvider']]);
    expect(outcome.removed).toEqual(['CUDAExecutionProvider']);
  });

  it('removes a provider that 1.2.4 reports in failedEps and tries that provider again', async () => {
    const calls = [];
    let present = true;
    let cudaRegistered = false;
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [
        { name: 'WebGpuExecutionProvider', isRegistered: true },
        { name: 'CUDAExecutionProvider', isRegistered: cudaRegistered },
      ],
      removeCache: (name) => {
        if (name !== 'CUDAExecutionProvider' || !present) return false;
        present = false;
        return true;
      },
      downloadAndRegister: async (names) => {
        calls.push(names);
        if (calls.length === 1) {
          return {
            failedEps: ['CUDAExecutionProvider'],
            success: false,
            status: '1 failed (CUDAExecutionProvider)',
          };
        }
        cudaRegistered = true;
        return { failedEps: [], success: true };
      },
    });
    expect(calls).toEqual([['CUDAExecutionProvider'], ['CUDAExecutionProvider']]);
    expect(outcome.removed).toEqual(['CUDAExecutionProvider']);
    expect(outcome.result?.success).toBe(true);
    expect(outcome.result?.status).toBe('Providers rebuilt');
  });

  it('retries a 2.0.1 registration that throws after the cache was already removed', async () => {
    const calls = [];
    let cudaRegistered = false;
    let cached = true;
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [{ name: 'CUDAExecutionProvider', isRegistered: cudaRegistered }],
      removeCache: (name) => {
        if (name !== 'CUDAExecutionProvider' || !cached) return false;
        cached = false;
        return true;
      },
      downloadAndRegister: async (names) => {
        calls.push(names);
        if (calls.length === 1) throw new Error('Native failure registering CUDAExecutionProvider');
        cudaRegistered = true;
        return { success: true, failedEps: [], registeredEps: names };
      },
    });
    expect(calls).toEqual([['CUDAExecutionProvider'], ['CUDAExecutionProvider']]);
    expect(outcome.removed).toEqual(['CUDAExecutionProvider']);
    expect(outcome.result?.success).toBe(true);
  });

  it('retries when 2.0.1 returns success but discover still says the provider is not registered', async () => {
    const calls = [];
    let attempts = 0;
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [{ name: 'CUDAExecutionProvider', isRegistered: attempts >= 2 }],
      removeCache: () => true,
      downloadAndRegister: async (names) => {
        calls.push(names);
        attempts += 1;
        return { success: true, failedEps: [], registeredEps: names ?? [] };
      },
    });
    expect(calls).toEqual([['CUDAExecutionProvider'], ['CUDAExecutionProvider']]);
    expect(outcome.result?.success).toBe(true);
  });

  it('reports attempted provider rebuild names when registration fails without naming a provider', async () => {
    const calls = [];
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [{ name: 'CUDAExecutionProvider', isRegistered: false }],
      removeCache: () => false,
      downloadAndRegister: async (names) => {
        calls.push(names);
        return { success: false, failedEps: [], status: 'registration failed' };
      },
    });
    expect(calls).toEqual([['CUDAExecutionProvider'], ['CUDAExecutionProvider']]);
    expect(outcome.attempted).toEqual(['CUDAExecutionProvider']);
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.failedEps).toEqual(['CUDAExecutionProvider']);
  });

  it('registers a cached provider that discover does not list', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-ep-'));
    fs.mkdirSync(path.join(root, 'cuda-ep'));
    const calls = [];
    let listed = false;
    const outcome = await rebuildBrokenExecutionProviders({
      epRoot: root,
      discover: () => listed
        ? [{ name: 'CUDAExecutionProvider', isRegistered: true }]
        : [{ name: 'WebGpuExecutionProvider', isRegistered: true }],
      removeCache: (name) => removeProviderCache(root, name),
      downloadAndRegister: async (names) => {
        calls.push(names);
        listed = true;
        return { success: true, failedEps: [] };
      },
    });
    expect(calls).toEqual([['CUDAExecutionProvider']]);
    expect(outcome.removed).toEqual(['CUDAExecutionProvider']);
    expect(fs.existsSync(path.join(root, 'cuda-ep'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not delete a provider that the status text only lists as available', async () => {
    const removed = [];
    const calls = [];
    let cudaRegistered = false;
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [
        { name: 'WebGpuExecutionProvider', isRegistered: true },
        { name: 'CUDAExecutionProvider', isRegistered: cudaRegistered },
      ],
      removeCache: (name) => {
        removed.push(name);
        return true;
      },
      downloadAndRegister: async (names) => {
        calls.push(names);
        if (names?.includes('CUDAExecutionProvider') && calls.length > 1) cudaRegistered = true;
        return {
          success: cudaRegistered,
          failedEps: cudaRegistered ? [] : ['CUDAExecutionProvider'],
          status: cudaRegistered
            ? 'EP registration complete'
            : '1 failed (CUDAExecutionProvider). Available EPs: CPUExecutionProvider, WebGpuExecutionProvider',
        };
      },
    });
    expect(removed).toEqual(['CUDAExecutionProvider', 'CUDAExecutionProvider']);
    expect(outcome.removed).toEqual(['CUDAExecutionProvider']);
    expect(calls.every((names) => !names?.includes('WebGpuExecutionProvider'))).toBe(true);
    expect(outcome.removed).not.toContain('WebGpuExecutionProvider');
  });

  it('keeps going when a provider DLL is locked', async () => {
    const calls = [];
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [{ name: 'CUDAExecutionProvider', isRegistered: calls.length > 0 }],
      removeCache: () => {
        const error = new Error('EPERM: operation not permitted, unlink webgpu.dll');
        error.code = 'EPERM';
        throw error;
      },
      downloadAndRegister: async (names) => {
        calls.push(names);
        return { success: true, failedEps: [] };
      },
    });
    expect(calls).toEqual([]);
    expect(outcome.busy).toEqual(['CUDAExecutionProvider']);
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.failedEps).toEqual(['CUDAExecutionProvider']);
  });

  it('leaves a registered provider in place when registration succeeds', async () => {
    const removed = [];
    const calls = [];
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [{ name: 'WebGpuExecutionProvider', isRegistered: true }],
      removeCache: (name) => {
        removed.push(name);
        return true;
      },
      downloadAndRegister: async (names) => {
        calls.push(names);
        return { failedEps: [], success: true, status: 'All providers registered' };
      },
    });
    expect(calls).toEqual([]);
    expect(removed).toEqual([]);
    expect(outcome.removed).toEqual([]);
    expect(outcome.result?.success).toBe(true);
  });

  it('stays failed when deleting the cache makes Foundry drop the provider', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-ep-'));
    const cuda = path.join(root, 'cuda-ep');
    fs.mkdirSync(cuda);
    fs.writeFileSync(path.join(cuda, 'onnxruntime_providers_cuda.dll'), 'stale');
    const calls = [];
    const outcome = await rebuildBrokenExecutionProviders({
      epRoot: root,
      discover: () => fs.existsSync(cuda)
        ? [
          { name: 'WebGpuExecutionProvider', isRegistered: true },
          { name: 'CUDAExecutionProvider', isRegistered: false },
        ]
        : [{ name: 'WebGpuExecutionProvider', isRegistered: true }],
      removeCache: (name) => removeProviderCache(root, name),
      downloadAndRegister: async (names) => {
        calls.push(names);
        throw new Error('registration failed');
      },
    });
    expect(calls).toEqual([['CUDAExecutionProvider'], ['CUDAExecutionProvider']]);
    expect(outcome.removed).toEqual(['CUDAExecutionProvider']);
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.failedEps).toEqual(['CUDAExecutionProvider']);
    expect(outcome.result?.registeredEps).toEqual(['WebGpuExecutionProvider']);
    expect(fs.existsSync(cuda)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('registers each broken provider by itself so one failure does not drop the other', async () => {
    const calls = [];
    const registered = new Set(['WebGpuExecutionProvider']);
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [
        { name: 'WebGpuExecutionProvider', isRegistered: registered.has('WebGpuExecutionProvider') },
        { name: 'CUDAExecutionProvider', isRegistered: registered.has('CUDAExecutionProvider') },
        { name: 'QNNExecutionProvider', isRegistered: registered.has('QNNExecutionProvider') },
      ],
      removeCache: () => true,
      downloadAndRegister: async (names) => {
        calls.push(names);
        if (names?.includes('CUDAExecutionProvider')) {
          throw new Error('Native failure registering CUDAExecutionProvider');
        }
        for (const name of names ?? []) registered.add(name);
        return { success: true, failedEps: [], registeredEps: names };
      },
    });
    expect(calls.flat()).not.toContain('WebGpuExecutionProvider');
    expect(calls.filter((names) => names?.length !== 1)).toEqual([]);
    expect(calls.some((names) => names?.[0] === 'QNNExecutionProvider')).toBe(true);
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.failedEps).toEqual(['CUDAExecutionProvider']);
    expect(outcome.result?.status).toContain('CUDAExecutionProvider');
    expect(outcome.result?.registeredEps).toEqual([
      'WebGpuExecutionProvider',
      'QNNExecutionProvider',
    ]);
  });

  it('registers one cache once when discover spells the provider differently', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-ep-'));
    fs.mkdirSync(path.join(root, 'webgpu-ep'));
    const calls = [];
    const removed = [];
    let registered = false;
    const outcome = await rebuildBrokenExecutionProviders({
      epRoot: root,
      discover: () => [{ name: 'WebGPUExecutionProvider', isRegistered: registered }],
      removeCache: (name) => {
        removed.push(name);
        return true;
      },
      downloadAndRegister: async (names) => {
        calls.push(names);
        registered = true;
        return { success: true, failedEps: [] };
      },
    });
    expect(calls).toEqual([['WebGPUExecutionProvider']]);
    expect(removed).toEqual(['WebGPUExecutionProvider']);
    expect(outcome.result?.success).toBe(true);
    expect(outcome.result?.registeredEps).toEqual(['WebGPUExecutionProvider']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('names a provider that is still unregistered after the retry', async () => {
    const calls = [];
    const outcome = await rebuildBrokenExecutionProviders({
      discover: () => [
        { name: 'WebGpuExecutionProvider', isRegistered: true },
        { name: 'CUDAExecutionProvider', isRegistered: false },
      ],
      removeCache: () => true,
      downloadAndRegister: async (names) => {
        calls.push(names);
        return { success: true, failedEps: [], registeredEps: names };
      },
    });
    expect(calls).toEqual([['CUDAExecutionProvider'], ['CUDAExecutionProvider']]);
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.failedEps).toEqual(['CUDAExecutionProvider']);
    expect(outcome.result?.registeredEps).toEqual(['WebGpuExecutionProvider']);
  });
});

describe('Recheck Providers button', () => {
  const page = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', '+page.svelte'),
    'utf8',
  );

  it('paints the button on the panel fill with a visible border', () => {
    expect(page).toContain('class="secondary accel-recheck"');
    expect(page).toMatch(
      /button\.accel-recheck\s*\{[^}]*background:\s*var\(--panel-bg\);[^}]*color:\s*var\(--fg\);[^}]*border:\s*1px solid var\(--muted\);/s,
    );
  });

  it('disables accelerator installation during a provider recheck', () => {
    expect(page).toContain('<button onclick={ensureHardwareAccel} disabled={!state.ready || providerRecheckBusy}>');
    expect(page).toContain('{ rebuildBroken: true }');
    expect(page).toContain('Runtime changed while rechecking execution providers');
  });
});
