import { writable, type Writable } from 'svelte/store';
import { Command } from '@tauri-apps/plugin-shell';
import { resolveResource } from '@tauri-apps/api/path';

// Sidecar-based implementation for clean production builds.
// We never import 'foundry-local-sdk' in the web bundle.
// All heavy work (including Node natives) happens in the sidecar process.

export interface IModel { alias: string; isCached?: boolean; isLoaded?: boolean; info?: any; }
export interface ModelContextInfo {
  alias: string;
  contextLength: number | null;
  family: string | null;
}
export interface EpInfo { name: string; isRegistered: boolean; }
export interface EpDownloadResult { success: boolean; status: string; registeredEps?: string[]; failedEps?: string[]; }

let sidecarProcess: any = null;
let sidecarReady = false;
let pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let msgId = 0;
let currentStatus: any = { initialized: false, modelLoaded: false, serviceRunning: false };
export type ModelInfo = IModel & {
  isCached?: boolean;
  isLoaded?: boolean;
};

let managerInstance: any = null;
let currentEndpoint: string | undefined = undefined;

export interface FlintSDKState {
  ready: boolean;
  error: string | null;
  models: ModelInfo[];
  cachedModels: ModelInfo[];
  loadedModels: ModelInfo[];
  endpoint?: string;
  eps: EpInfo[];
  acceleratorsReady: boolean;
  serviceRunning: boolean;
  logs: string[];
}

const initialState: FlintSDKState = {
  ready: false,
  error: null,
  models: [],
  cachedModels: [],
  loadedModels: [],
  endpoint: undefined,
  eps: [],
  acceleratorsReady: false,
  serviceRunning: false,
  logs: [],
};

export const sdkState: Writable<FlintSDKState> = writable(initialState);

function updateState(partial: Partial<FlintSDKState>) {
  sdkState.update((s) => ({ ...s, ...partial }));
}

export function getSDKState() {
  return sdkState;
}

async function startSidecar() {
  if (sidecarProcess) return;

  // Resolve sidecar script path using resolveResource (handles dev + prod bundles correctly)
  let script: string;
  let isDev = false;
  try {
    script = await resolveResource('sidecar/foundry-sidecar.js');
    console.log(`[sdk] Resolved sidecar resource path: ${script}`);
  } catch {
    // In dev mode, resolveResource fails; use relative path from cwd
    script = 'sidecar/foundry-sidecar.js';
    isDev = true;
    console.log(`[sdk] Dev mode: using relative sidecar path`);
  }

  // Determine base dir for cwd (helps node resolve sibling 'foundry-local-sdk' in prod bundle)
  let baseDir: string | undefined;
  try {
    const { resourceDir } = await import('@tauri-apps/api/path');
    baseDir = await resourceDir();
    console.log(`[sdk] Resource dir: ${baseDir}`);
  } catch (e) {
    console.log(`[sdk] resourceDir unavailable`);
  }

  const opts: any = baseDir
    ? { cwd: baseDir, env: { NODE_PATH: baseDir } }
    : undefined;

  console.log(`[sdk] Spawning sidecar - isDev=${isDev}, script=${script}`);

  const command = Command.create('node', [script], opts);

  // Attach stdout listener to the command (works before/after spawn in plugin-shell)
  let stdoutBuffer = '';
  let stdoutEventFired = false;
  command.stdout.on('data', (data: Uint8Array) => {
    stdoutEventFired = true;
    const text = new TextDecoder().decode(data);
    console.log(`[sdk] stdout.on('data') fired: ${text.length} bytes`);
    stdoutBuffer += text;

    // Process complete lines
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines[lines.length - 1]; // Keep incomplete line

    lines.slice(0, -1).forEach((line: string) => {
      if (!line.trim()) return;
      console.log(`[sidecar stdout] ${line}`);
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg);
        } else if (msg.type === 'log') {
          console.log(`[sidecar] ${msg.level}: ${msg.message}`);
          sdkState.update(s => ({ ...s, logs: [...s.logs.slice(-50), `[${msg.level}] ${msg.message}`] }));
        } else if (msg.ready) {
          console.log(`[sdk] Sidecar ready signal received!`);
          sidecarReady = true;
        }
      } catch (e) {
        // Ignore parse errors for non-json lines
      }
    });
  });

  // Add listener event to detect if listener is even attached
  console.log(`[sdk] stdout listeners count: ${command.stdout.listenerCount('data')}`);
  command.stderr.on('data', (data: Uint8Array) => {
    const text = new TextDecoder().decode(data).trim();
    if (!text) return;
    console.error(`[sidecar stderr] ${text}`);
    sdkState.update(s => ({ ...s, logs: [...s.logs.slice(-50), `[stderr] ${text}`] }));
  });

  command.on('close', (data: any) => {
    console.log(`[sdk] Sidecar process closed (exit code: ${data?.code})`);
    sidecarReady = false;
    sidecarProcess = null;
    updateState({ ready: false, error: 'Sidecar closed' });
  });

  command.on('error', (error: any) => {
    console.error(`[sdk] Sidecar error event:`, error);
    updateState({ error: `Sidecar error: ${error}` });
  });

  // spawn() returns the Child process which has .write()
  console.log(`[sdk] Calling spawn()...`);
  sidecarProcess = await command.spawn();
  console.log(`[sdk] Sidecar process spawned, waiting for ready signal...`);

  // Wait for the sidecar to signal ready (it sends { ready: true } on startup)
  // Extended timeout for first cold start / node + resource loads (especially on Windows with antivirus).
  let readyTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      readyTimeout = setTimeout(() => {
        const msg = sidecarReady
          ? 'Sidecar ready signal received but not processed'
          : `Sidecar did not emit ready signal (stdout listener fired: ${stdoutEventFired}, check browser console for stderr logs)`;
        reject(new Error(msg));
      }, 20000); // 20s timeout to be extra patient on first startup

      const checkReady = () => {
        if (sidecarReady) {
          console.log(`[sdk] Init complete: sidecar is ready!`);
          if (readyTimeout) clearTimeout(readyTimeout);
          resolve();
        } else {
          // poll briefly
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });
  } catch (e) {
    // Best effort cleanup so next attempt can retry fresh
    if (readyTimeout) clearTimeout(readyTimeout);
    try { sidecarProcess?.kill?.(); } catch {}
    sidecarProcess = null;
    sidecarReady = false;
    throw e;
  }
}

async function send(cmd: string, payload: any = {}): Promise<any> {
  if (!sidecarProcess || !sidecarReady) {
    await startSidecar();
  }
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // write is async in recent plugin-shell
    // write returns Promise<void>
    sidecarProcess.write(JSON.stringify({ id, cmd, ...payload }) + '\n')
      .then(() => { /* written */ })
      .catch((e: any) => {
        pending.delete(id);
        reject(e);
      });
  });
}

let isInitializing = false;

export async function initializeSDK(config: Partial<any> = {}): Promise<boolean> {
  if (managerInstance) {
    updateState({ ready: true });
    return true;
  }
  if (isInitializing) return false;
  isInitializing = true;
  updateState({ error: null });

  try {
    await send('init', { appName: config.appName || 'flint', logLevel: config.logLevel || 'info' });
    await send('setLogLevel', { level: 'info' }); // at least enabling logging

    updateState({ ready: true, error: null });
    await refreshModels();
    // Auto start service for endpoint exposure (MVP requirement)
    try {
      await send('startService', { port: 5272 });
      const status = await send('getStatus');
      if (status.result?.endpoint) {
        updateState({ endpoint: status.result.endpoint, serviceRunning: true });
      }
    } catch (e) {
      console.warn('Auto-start service failed (can be started manually)', e);
    }
    return true;
  } catch (e: any) {
    const errMsg = `Sidecar init failed: ${e?.message || e}`;
    updateState({ error: errMsg, ready: false });
    return false;
  } finally {
    isInitializing = false;
  }
}

export async function refreshModels(): Promise<void> {
  try {
    const res = await send('listModels');
    const list = res.result || [];
    const models = list.map((m: any) => ({ alias: m.alias, isCached: m.cached, info: m } as ModelInfo));

    updateState({
      models,
      cachedModels: models.filter((m: ModelInfo) => m.isCached),
      loadedModels: [], // sidecar tracks current model
    });

    // Also refresh status
    const status = await send('getStatus');
    if (status.result) {
      currentEndpoint = status.result.endpoint;
      updateState({
        endpoint: currentEndpoint || undefined,
        serviceRunning: !!status.result.serviceRunning,
        acceleratorsReady: true, // simplified
      });
    }
  } catch (e) {
    console.error('refreshModels via sidecar failed', e);
  }
}

export async function getModel(alias: string) {
  // We don't keep full model objects client-side with sidecar.
  // Return a minimal handle; heavy ops go through sidecar.
  return { alias } as any;
}

export async function downloadModel(model: any, onProgress?: (p: number) => void, signal?: AbortSignal) {
  await send('download', { alias: model.alias });
  // Sidecar sends progress messages (we can listen in real impl)
  await refreshModels();
}

export async function loadModel(model: any) {
  await send('load', { alias: model.alias });
  await refreshModels();
}

export async function unloadModel(model: any) {
  await send('unload', { alias: model.alias });
  await refreshModels();
}

export async function removeFromCache(alias: string) {
  // Not implemented in current sidecar for safety; can be added
  console.warn('removeFromCache not wired to sidecar yet');
  await refreshModels();
}

export async function getLocalEndpoint(): Promise<string | undefined> {
  const res = await send('getEndpoint');
  return res.endpoint;
}

export async function startService(port = 5272): Promise<string> {
  const res = await send('startService', { port });
  currentEndpoint = res.endpoint;
  updateState({ endpoint: currentEndpoint, serviceRunning: true });
  return currentEndpoint!;
}

export async function stopService(): Promise<void> {
  await send('stopService');
  currentEndpoint = undefined;
  updateState({ endpoint: undefined, serviceRunning: false });
}

export function getManager(): any {
  return null; // No direct manager when using sidecar
}

export function resetSDK() {
  if (sidecarProcess) {
    // best effort
    sidecarProcess.kill();
  }
  sidecarProcess = null;
  sidecarReady = false;
  managerInstance = null;
  currentEndpoint = undefined;
  sdkState.set(initialState);
}

/**
 * Discover available execution providers (accelerators like CPU, CUDA, QNN for NPU, etc.)
 */
export async function getEps(): Promise<EpInfo[]> {
  const res = await send('getEps');
  const eps = res.result || [];
  updateState({ eps, acceleratorsReady: eps.some((e: EpInfo) => e.isRegistered) });
  return eps;
}

export async function ensureAccelerators(): Promise<void> {
  await send('ensureAccelerators');
  await getEps();
}

/**
 * Returns context length info for a model if available from the catalog.
 * Falls back to null if unknown.
 */
export function getModelContextInfo(alias: string): ModelContextInfo | null {
  // This is a lightweight helper; the real data lives in sdkState.models
  return null; // caller should use state.models
}

/**
 * Get recommended small starter models based on current hardware/EPs and available catalog.
 * Returns up to `count` suitable lightweight models.
 * Prefers models good for the detected acceleration.
 */
/**
 * Returns models that support Speech-to-Text / automatic speech recognition.
 * Uses the `task` field and capabilities to avoid hardcoding families (Whisper, Nemotron Speech, etc.).
 */
export async function getVisionModels(): Promise<ModelInfo[]> {
  try {
    const res = await send('getVisionModels');
    return (res.result || []).map((m: any) => ({ ...m, isCached: !!m.cached } as ModelInfo));
  } catch { return []; }
}

export async function getSTTModels(): Promise<ModelInfo[]> {
  try {
    const res = await send('getSTTModels');
    return (res.result || []).map((m: any) => ({ ...m, isCached: !!m.cached } as ModelInfo));
  } catch (e) {
    console.warn('Failed to get STT models', e);
    return [];
  }
}

export async function getRecommendedStarterModels(count: number = 3): Promise<ModelInfo[]> {
  try {
    const res = await send('listModels');
    const allModels = (res.result || []) as any[];

    let current: FlintSDKState | undefined;
    sdkState.subscribe((s) => (current = s))();
    const eps = current?.eps || [];
    const hasAccel = eps.some((e: EpInfo) => e.isRegistered && !/cpu/i.test(e.name));

    let candidates = allModels.filter((m: any) => {
      const alias = (m.alias || '').toLowerCase();
      const sizeMb = m.size || 0;
      const isSmall = sizeMb > 0 ? sizeMb < (hasAccel ? 4500 : 2500) : /0\.5b|1b|1\.5b|2b|3b|mini|tiny|small|phi-?3|qwen2\.?5-0/i.test(alias);
      return isSmall && !alias.includes('embedding') && !alias.includes('whisper');
    });

    candidates.sort((a: any, b: any) => {
      const sizeA = a.size || 99999;
      const sizeB = b.size || 99999;
      const scoreA = /phi|qwen2\.5-0\.5|qwen2\.5-1|gemma.*2b/i.test(a.alias || '') ? -100 : 0;
      const scoreB = /phi|qwen2\.5-0\.5|qwen2\.5-1|gemma.*2b/i.test(b.alias || '') ? -100 : 0;
      return (sizeA + scoreA) - (sizeB + scoreB);
    });

    return candidates.slice(0, count).map((m: any) => ({ alias: m.alias, isCached: m.cached } as ModelInfo));
  } catch (e) {
    console.warn('Could not compute recommended starters', e);
    return [];
  }
}
