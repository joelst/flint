import { writable, type Writable } from 'svelte/store';
import { Command } from '@tauri-apps/plugin-shell';
import { resolveResource, resourceDir } from '@tauri-apps/api/path';
import type { LaneName, EndpointProfile } from './ipc-contracts';
import {
  evaluateNodeProbe,
  buildNodeMissingMessage,
  type NodePreflightResult,
} from './node-runtime';
export type { LaneName, EndpointProfile };
export {
  MIN_NODE_VERSION,
  formatNodeVersion,
  type NodePreflightResult,
} from './node-runtime';

// Sidecar-based implementation for clean production builds.
// We never import 'foundry-local-sdk' in the web bundle.
// All heavy work (including Node natives) happens in the sidecar process.

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source: 'sidecar' | 'sdk' | 'app';
}

export interface ModelVariantUpdate {
  currentVersion: number;
  latestVersion: number;
  latestVariantId: string;
  deviceType?: string | null;
  executionProvider?: string | null;
}
export interface ModelVariantInfo {
  id: string;
  deviceType?: string | null;
  executionProvider?: string | null;
  fileSizeMb?: number | null;
  cached: boolean;
  name?: string | null;
  version?: number | null;
  update?: ModelVariantUpdate | null;
}
export interface IModel {
  alias: string;
  isCached?: boolean;
  isLoaded?: boolean;
  info?: any;
  variants?: ModelVariantInfo[];
  updates?: Array<ModelVariantUpdate & { sourceVariantId: string }>;
}
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
let streamHandlers = new Map<number, (delta: string) => void>();
let progressHandlers = new Map<number, (p: number) => void>();
let msgId = 0;
let currentStatus: any = { initialized: false, modelLoaded: false, serviceRunning: false };
export type ModelInfo = IModel & {
  isCached?: boolean;
  isLoaded?: boolean;
};

let managerInstance: any = null;
let currentEndpoint: string | undefined = undefined;
const sidecarResourcePath = 'sidecar/foundry-sidecar.js';

function decodeShellOutput(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

function formatStartupFailure(
  stdoutEventFired: boolean,
  stderrLines: string[],
  closeData: any,
  commandError: string | null
): string {
  const combined = [commandError, ...stderrLines].filter(Boolean).join(' ');
  const lower = combined.toLowerCase();
  if (
    lower.includes('enoent') ||
    lower.includes('not found') ||
    lower.includes('is not recognized') ||
    lower.includes('program not found')
  ) {
    return buildNodeMissingMessage();
  }

  const details: string[] = [`stdout listener fired: ${stdoutEventFired}`];

  if (commandError) {
    details.push(`shell error: ${commandError}`);
  }

  if (closeData) {
    details.push(`exit code: ${closeData.code ?? 'unknown'}`);
    if (closeData.signal) {
      details.push(`signal: ${closeData.signal}`);
    }
  }

  const lastStderr = stderrLines.at(-1);
  if (lastStderr) {
    details.push(`last stderr: ${lastStderr}`);
  }

  return `Sidecar did not emit ready signal (${details.join(', ')})`;
}

/**
 * Verify Node.js is on PATH and meets MIN_NODE_VERSION before spawning the sidecar.
 */
export async function ensureNodeRuntime(): Promise<NodePreflightResult> {
  let stdout = '';
  let probeError: string | null = null;
  try {
    const command = Command.create('node', ['-v']);
    const output = await command.execute();
    stdout = decodeShellOutput(output.stdout ?? '');
    const stderr = decodeShellOutput(output.stderr ?? '').trim();
    if (output.code !== 0 && output.code !== null && output.code !== undefined) {
      probeError =
        stderr ||
        `node -v exited with code ${output.code}` +
          (stdout ? ` (stdout: ${stdout.trim()})` : '');
    } else if (!stdout.trim() && stderr) {
      // Some environments print version to stderr.
      stdout = stderr;
    }
  } catch (e: any) {
    probeError = e?.message ? String(e.message) : String(e);
  }

  const result = evaluateNodeProbe({ stdout, probeError });
  if (result.ok) {
    console.log(`[sdk] Node preflight OK: ${result.version.raw}`);
  } else {
    console.error(`[sdk] Node preflight failed (${result.code}):`, result.message);
  }
  return result;
}

function getTauriDevRepoRoot(resolvedResourcePath: string): string | null {
  const normalized = resolvedResourcePath.replace(/\\/g, '/');
  const marker = '/src-tauri/target/';
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const repoRoot = normalized.slice(0, markerIndex);
  return resolvedResourcePath.includes('\\') ? repoRoot.replace(/\//g, '\\') : repoRoot;
}

function joinResourcePath(basePath: string, relativePath: string): string {
  const separator = basePath.includes('\\') ? '\\' : '/';
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(/\//g, separator)}`;
}

export interface PoolEntry {
  alias: string;
  variantId: string;
  isLoaded: boolean | null;
}

export interface StreamingStatus {
  active: boolean;
  type: 'chat' | 'audio' | null;
  modelAlias: string | null;
  elapsedMs: number | null;
  count: number;
}

export interface AcceleratorMemory {
  kind: 'gpu' | 'npu';
  name: string;
  vendor?: string | null;
  totalMb: number | null;
  usedMb: number | null;
  freeMb: number | null;
  source: string;
}

export interface HostInfo {
  platform?: string; // process.platform: darwin | win32 | linux
  arch?: string;     // process.arch: arm64 | x64 | ...
}

export interface PoolStats {
  usedMemMb: number;
  totalMemMb: number;
  freeMemMb: number;
  host?: HostInfo;
  accelerators?: AcceleratorMemory[];
  tokenTotals: Array<{ alias: string; tokensIn: number; tokensOut: number }>;
  streaming: StreamingStatus | null;
}

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
  logs: LogEntry[];
  chatLaneModel?: string;
  audioLaneModel?: string;
  pool: PoolEntry[];
  poolStats: PoolStats | null;
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
  chatLaneModel: undefined,
  audioLaneModel: undefined,
  pool: [],
  poolStats: null,
};

export const sdkState: Writable<FlintSDKState> = writable(initialState);

function drainPending(reason: Error) {
  for (const { reject } of pending.values()) {
    reject(reason);
  }
  pending.clear();
  streamHandlers.clear();
  progressHandlers.clear();
}

function updateState(partial: Partial<FlintSDKState>) {
  sdkState.update((s) => ({ ...s, ...partial }));
}

export function getSDKState() {
  return sdkState;
}

async function startSidecar() {
  if (sidecarProcess) return;

  const nodeCheck = await ensureNodeRuntime();
  if (!nodeCheck.ok) {
    updateState({ ready: false, error: nodeCheck.message });
    throw new Error(nodeCheck.message);
  }

  // Resolve sidecar script path using resolveResource (handles dev + prod bundles correctly)
  let script: string;
  let isDev = false;
  let baseDir: string | undefined;
  try {
    const resolvedScript = await resolveResource(sidecarResourcePath);
    const devRepoRoot = getTauriDevRepoRoot(resolvedScript);
    if (devRepoRoot) {
      script = joinResourcePath(devRepoRoot, sidecarResourcePath);
      baseDir = devRepoRoot;
      isDev = true;
      console.log(`[sdk] Dev mode: resolved sidecar resource points at target dir, using repo path: ${script}`);
    } else {
      script = resolvedScript;
      console.log(`[sdk] Resolved sidecar resource path: ${script}`);
    }
  } catch {
    // In dev mode, resolveResource fails; use relative path from cwd
    script = sidecarResourcePath;
    isDev = true;
    console.log(`[sdk] Dev mode: using relative sidecar path`);
  }

  // Determine base dir for cwd (helps node resolve sibling 'foundry-local-sdk' in prod bundle)
  if (!baseDir) {
    try {
      baseDir = await resourceDir();
      console.log(`[sdk] Resource dir: ${baseDir}`);
    } catch (e) {
      console.log(`[sdk] resourceDir unavailable`);
    }
  }

  if (isDev && baseDir && script === sidecarResourcePath) {
    const devRepoRoot = getTauriDevRepoRoot(joinResourcePath(baseDir, sidecarResourcePath));
    if (devRepoRoot) {
      script = joinResourcePath(devRepoRoot, sidecarResourcePath);
      baseDir = devRepoRoot;
      console.log(`[sdk] Dev mode: using repo sidecar path from resource dir: ${script}`);
    }
  }

  const opts: any = baseDir
    ? { cwd: baseDir, env: { NODE_PATH: baseDir } }
    : undefined;

  console.log(`[sdk] Spawning sidecar - isDev=${isDev}, script=${script}`);

  const command = Command.create('node', [script], opts);

  // Attach stdout listener to the command (works before/after spawn in plugin-shell)
  let stdoutBuffer = '';
  let stdoutEventFired = false;
  const stderrLines: string[] = [];
  let closeData: any = null;
  let commandError: string | null = null;

  const processStdoutLine = (line: string) => {
    if (!line.trim()) return;
    console.log(`[sidecar stdout] ${line}`);
    try {
      const msg = JSON.parse(line);
      if (msg.id && msg.stream) {
        const onStream = streamHandlers.get(msg.id);
        if (onStream) {
          const delta = String(
            msg.delta ??
            msg.chunk?.choices?.[0]?.delta?.content ??
            msg.chunk?.choices?.[0]?.message?.content ??
            ''
          );
          if (delta) onStream(delta);
        }
        return;
      }
      if (msg.id && msg.progress !== undefined) {
        // Progress messages (e.g. from download) should not resolve the pending promise.
        // The final reply (with ok or error) will do that.
        const handler = progressHandlers.get(msg.id);
        if (handler) {
          try { handler(Number(msg.progress)); } catch {}
        }
        if (msg.alias) {
          console.log(`[sdk] download progress ${msg.alias}: ${msg.progress}%`);
        }
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        streamHandlers.delete(msg.id);
        progressHandlers.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg);
      } else if (msg.type === 'log') {
        console.log(`[sidecar] ${msg.level}: ${msg.message}`);
        sdkState.update(s => ({ ...s, logs: [...s.logs.slice(-199), { ts: msg.timestamp ?? Date.now(), level: msg.level ?? 'info', message: msg.message, source: 'sidecar' as const }] }));
      } else if (msg.ready) {
        console.log(`[sdk] Sidecar ready signal received!`);
        sidecarReady = true;
      }
    } catch (e) {
      // Ignore parse errors for non-json lines
    }
  };

  const processStdoutText = (text: string) => {
    stdoutBuffer += text;

    // The Tauri shell plugin usually emits strings, and depending on platform
    // those strings may be line-oriented with the newline already stripped.
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines[lines.length - 1]; // Keep incomplete line

    lines.slice(0, -1).forEach(processStdoutLine);

    const buffered = stdoutBuffer.trim();
    if (buffered.startsWith('{') && buffered.endsWith('}')) {
      processStdoutLine(stdoutBuffer);
      stdoutBuffer = '';
    }
  };

  command.stdout.on('data', (data: string | Uint8Array) => {
    stdoutEventFired = true;
    const text = decodeShellOutput(data);
    console.log(`[sdk] stdout.on('data') fired: ${text.length} bytes`);
    processStdoutText(text);
  });

  // Add listener event to detect if listener is even attached
  console.log(`[sdk] stdout listeners count: ${command.stdout.listenerCount('data')}`);
  command.stderr.on('data', (data: string | Uint8Array) => {
    const text = decodeShellOutput(data).trim();
    if (!text) return;
    stderrLines.push(text);
    if (stderrLines.length > 10) {
      stderrLines.shift();
    }
    console.error(`[sidecar stderr] ${text}`);
    sdkState.update(s => ({ ...s, logs: [...s.logs.slice(-199), { ts: Date.now(), level: 'error' as const, message: text, source: 'sdk' as const }] }));
  });

  command.on('close', (data: any) => {
    closeData = data;
    console.log(`[sdk] Sidecar process closed (exit code: ${data?.code})`);
    sidecarReady = false;
    sidecarProcess = null;
    updateState({ ready: false, error: 'Sidecar closed' });
    drainPending(new Error('Sidecar closed'));
  });

  command.on('error', (error: any) => {
    commandError = String(error);
    console.error(`[sdk] Sidecar error event:`, error);
    updateState({ error: `Sidecar error: ${error}` });
    drainPending(new Error(`Sidecar error: ${error}`));
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
          : formatStartupFailure(stdoutEventFired, stderrLines, closeData, commandError);
        reject(new Error(msg));
      }, 20000); // 20s timeout to be extra patient on first startup

      const checkReady = () => {
        if (sidecarReady) {
          console.log(`[sdk] Init complete: sidecar is ready!`);
          if (readyTimeout) clearTimeout(readyTimeout);
          resolve();
        } else if (closeData || commandError) {
          if (readyTimeout) clearTimeout(readyTimeout);
          reject(new Error(formatStartupFailure(stdoutEventFired, stderrLines, closeData, commandError)));
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

async function sendInternal(
  cmd: string,
  payload: any = {},
  onStream?: (delta: string) => void,
  onAssignedId?: (id: number) => void
): Promise<any> {
  if (!sidecarProcess || !sidecarReady) {
    await startSidecar();
  }
  const id = ++msgId;
  if (onAssignedId) {
    onAssignedId(id);
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (onStream) {
      streamHandlers.set(id, onStream);
    }
    // write is async in recent plugin-shell
    // write returns Promise<void>
    sidecarProcess.write(JSON.stringify({ id, cmd, ...payload }) + '\n')
      .then(() => { /* written */ })
      .catch((e: any) => {
        pending.delete(id);
        streamHandlers.delete(id);
        progressHandlers.delete(id);
        reject(e);
      });
  });
}

async function send(cmd: string, payload: any = {}): Promise<any> {
  return sendInternal(cmd, payload);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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

    managerInstance = true;
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
    const raw = String(e?.message || e || 'Unknown error');
    // Node preflight messages are already complete user guidance — don't wrap them.
    const errMsg =
      raw.includes('nodejs.org') || raw.includes('Node.js')
        ? raw
        : `Sidecar init failed: ${raw}`;
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
    let currentLoadedAlias: string | undefined;

    // Also refresh status first so loaded-model state is accurate for UI + actions
    const status = await send('getStatus');
    if (status.result) {
      currentEndpoint = status.result.endpoint;
      const chatLaneModel: string | undefined = status.result.chatLane?.model || status.result.currentModel || undefined;
      const audioLaneModel: string | undefined = status.result.audioLane?.model || undefined;
      currentLoadedAlias = chatLaneModel;
      updateState({
        endpoint: currentEndpoint || undefined,
        serviceRunning: !!status.result.serviceRunning,
        acceleratorsReady: true, // simplified
        chatLaneModel,
        audioLaneModel,
      });
    }

    const loadedAliases = new Set(
      (status?.result?.pool ?? []).map((e: any) => e.alias).filter(Boolean)
    );

    const models = list.map((m: any) => ({
      ...m,
      alias: m.alias,
      isCached: m.cached,
      isLoaded: loadedAliases.has(m.alias),
      info: m
    } as ModelInfo));

    updateState({
      models,
      cachedModels: models.filter((m: ModelInfo) => m.isCached),
      loadedModels: models.filter((m: ModelInfo) => m.isLoaded),
    });

    // Refresh pool detail + memory stats
    try {
      const ps = await send('poolStatus');
      if (ps.result) {
        updateState({
          pool: ps.result.models ?? [],
          poolStats: mapPoolStats(ps.result),
        });
      }
    } catch (e) {
      console.warn('[sdk] poolStatus refresh failed', e);
    }
  } catch (e) {
    console.error('refreshModels via sidecar failed', e);
  }
}

function mapPoolStats(result: any): PoolStats {
  const accelerators = Array.isArray(result?.accelerators)
    ? result.accelerators
        .map((a: any) => ({
          kind: a?.kind === 'npu' ? 'npu' as const : 'gpu' as const,
          name: String(a?.name || ''),
          vendor: a?.vendor ?? null,
          totalMb: a?.totalMb == null ? null : Number(a.totalMb),
          usedMb: a?.usedMb == null ? null : Number(a.usedMb),
          freeMb: a?.freeMb == null ? null : Number(a.freeMb),
          source: String(a?.source || 'unknown'),
        }))
        .filter((a: AcceleratorMemory) => !!a.name)
    : [];
  const hostRaw = result?.host && typeof result.host === 'object' ? result.host : null;
  const host: HostInfo | undefined = hostRaw
    ? {
        platform: hostRaw.platform ? String(hostRaw.platform) : undefined,
        arch: hostRaw.arch ? String(hostRaw.arch) : undefined,
      }
    : undefined;
  return {
    usedMemMb:
      result.usedMemMb ??
      (result.totalMemMb != null && result.freeMemMb != null
        ? Math.max(0, Number(result.totalMemMb) - Number(result.freeMemMb))
        : 0),
    totalMemMb: result.totalMemMb ?? 0,
    freeMemMb: result.freeMemMb ?? 0,
    host,
    accelerators,
    tokenTotals: result.tokenTotals ?? [],
    streaming: result.streaming ?? null,
  };
}

export async function getModel(alias: string) {
  // We don't keep full model objects client-side with sidecar.
  // Return a minimal handle; heavy ops go through sidecar.
  return { alias } as any;
}

export async function downloadModel(model: any, onProgress?: (p: number) => void, variantId?: string) {
  const payload: any = { alias: model.alias };
  if (variantId) payload.variantId = variantId;
  await sendInternal('download', payload, undefined, (id: number) => {
    if (onProgress) {
      progressHandlers.set(id, onProgress);
    }
  });
  // Sidecar sends progress messages via stdout; onAssignedId registers the handler above.
  // The pending promise resolves only on the final reply (see stdout processing).
  await refreshModels();
}

export async function loadModel(model: any, lane?: LaneName, variantId?: string) {
  const payload: any = { alias: model.alias };
  if (lane) payload.lane = lane;
  if (variantId) payload.variantId = variantId;
  const res = await send('load', payload);
  await refreshModels();
  return res.result;
}

export async function unloadModel(model: any, lane?: LaneName) {
  const payload: any = { alias: model.alias };
  if (lane) payload.lane = lane;
  await send('unload', payload);
  await refreshModels();
}

export async function deleteModel(model: any, variantId?: string) {
  const payload: any = { alias: model.alias };
  if (variantId) payload.variantId = variantId;
  await send('deleteModel', payload);
  await refreshModels();
}

export async function removeFromCache(alias: string, variantId?: string) {
  await deleteModel({ alias }, variantId);
}

export async function getAccessLog(): Promise<any[]> {
  const res = await send('getAccessLog');
  return res?.result ?? [];
}

export async function pollPoolStatus(): Promise<void> {
  const ps = await send('poolStatus');
  if (ps?.result) {
    updateState({
      pool: ps.result.models ?? [],
      poolStats: mapPoolStats(ps.result),
    });
  }
}

export async function getLocalEndpoint(): Promise<string | undefined> {
  const res = await send('getEndpoint');
  return res.endpoint;
}

export async function startService(
  port = 5272,
  alias?: string,
  preferredEp?: string,
  bindAddress?: string
): Promise<string> {
  const payload: any = { port };
  if (alias) {
    payload.alias = alias;
  }
  if (preferredEp) {
    payload.preferredEp = preferredEp;
  }
  if (bindAddress) {
    payload.bindAddress = bindAddress;
  }
  const res = await send('startService', payload);
  currentEndpoint = res.endpoint;
  updateState({ endpoint: currentEndpoint, serviceRunning: true });
  return currentEndpoint!;
}

export async function stopService(): Promise<void> {
  await send('stopService');
  currentEndpoint = undefined;
  updateState({ endpoint: undefined, serviceRunning: false });
}

export async function chatCompletion(
  model: string,
  messages: Array<{ role: string; content: any }>,
  options?: { maxTokens?: number; temperature?: number; preferredEp?: string }
): Promise<any> {
  const res = await send('chatCompletion', {
    model,
    messages,
    maxTokens: options?.maxTokens,
    temperature: options?.temperature,
    preferredEp: options?.preferredEp
  });
  return res.result;
}

export async function chatCompletionStream(
  model: string,
  messages: Array<{ role: string; content: any }>,
  onDelta: (delta: string) => void,
  options?: { maxTokens?: number; temperature?: number; preferredEp?: string },
  onAssignedId?: (id: number) => void
): Promise<any> {
  const res = await sendInternal(
    'chatCompletion',
    {
      model,
      messages,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      preferredEp: options?.preferredEp,
      stream: true
    },
    onDelta,
    onAssignedId
  );
  return res.result;
}

export async function cancelChatRequest(requestId: number): Promise<void> {
  await send('cancelChatRequest', { requestId });
}

export interface FetchUrlResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  charCount: number;
}

export async function fetchUrl(url: string, maxChars = 50000): Promise<FetchUrlResult> {
  const res = await send('fetchUrl', { url, maxChars });
  return res.result as FetchUrlResult;
}

export async function transcribeAudio(
  audioBlob: Blob,
  model: string,
  language = 'auto',
  fileName = 'audio.webm',
  options?: { temperature?: number; preferredEp?: string }
): Promise<any> {
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioBase64 = arrayBufferToBase64(arrayBuffer);
  const res = await send('transcribeAudio', {
    audioBase64,
    mimeType: audioBlob.type || 'application/octet-stream',
    fileName,
    model,
    language,
    temperature: options?.temperature,
    preferredEp: options?.preferredEp
  });
  return res.result;
}

export function appendAppLog(message: string, level: LogEntry['level'] = 'info') {
  sdkState.update(s => ({ ...s, logs: [...s.logs.slice(-199), { ts: Date.now(), level, message, source: 'app' as const }] }));
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

// ---------------------------------------------------------------------------
// Endpoint profile management
// Auth credentials are intentionally excluded from profiles and must be stored
// separately in secure OS keychain storage — never in localStorage.
// ---------------------------------------------------------------------------

const ENDPOINT_PROFILES_KEY = 'flint_endpoint_profiles_v1';

export function loadEndpointProfiles(): EndpointProfile[] {
  try {
    const raw = localStorage.getItem(ENDPOINT_PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveEndpointProfiles(profiles: EndpointProfile[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ENDPOINT_PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // Silently no-op in SSR or sandboxed environments
  }
}

function generateProfileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ep_${crypto.randomUUID()}`;
  }
  return `ep_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export function addEndpointProfile(profile: Omit<EndpointProfile, 'id'>): EndpointProfile {
  const existing = loadEndpointProfiles();
  const created: EndpointProfile = {
    ...profile,
    id: generateProfileId(),
  };
  saveEndpointProfiles([...existing, created]);
  return created;
}

export function removeEndpointProfile(id: string): void {
  const existing = loadEndpointProfiles();
  saveEndpointProfiles(existing.filter((p) => p.id !== id));
}

export function updateEndpointProfile(id: string, patch: Partial<Omit<EndpointProfile, 'id'>>): void {
  const existing = loadEndpointProfiles();
  saveEndpointProfiles(existing.map((p) => (p.id === id ? { ...p, ...patch } : p)));
}
