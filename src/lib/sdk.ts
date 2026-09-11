import { writable, type Writable } from 'svelte/store';
import { Command } from '@tauri-apps/plugin-shell';
import { resolveResource, resourceDir } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import {
  SIDECAR_PROTOCOL_VERSION,
  type LaneName,
  type EndpointProfile,
  type ModelPriority,
  type ModelPriorityEntry,
  type EvictionConfig,
  type EpInfo,
  type EpDownloadResult,
  type SidecarCommandName,
} from './ipc-contracts';
import {
  evaluateNodeProbe,
  buildNodeMissingMessage,
  pickBestNodePreflightFailure,
  type NodePreflightFailure,
  type NodePreflightResult,
} from './node-runtime';
import {
  SIDECAR_RESOURCE_CANDIDATES,
  selectSidecarSpawnPaths,
  parseNodeRuntimePreference,
  nodeRuntimeProbeOrder,
  shellProgramForNodeMode,
  type NodeRuntimeMode,
  type ResolvedSidecarCandidate,
} from './sidecar-paths';
import {
  createProgressStallWatchdog,
  type ProgressStallWatchdog,
} from './progress-stall';
export type {
  LaneName,
  EndpointProfile,
  EpInfo,
  EpDownloadResult,
  AcceleratorReadiness,
};

export { SIDECAR_PROTOCOL_VERSION };
export {
  MIN_NODE_VERSION,
  formatNodeVersion,
  type NodePreflightResult,
} from './node-runtime';
export {
  BUNDLED_NODE_SIDECAR,
  PATH_NODE_SHELL_NAME,
  type NodeRuntimeMode,
} from './sidecar-paths';
import {
  SidecarOperationError,
  certaintyFor,
  isUncertainOutcome,
  type InterruptionCause,
} from './operation-outcome';
import {
  hasRegisteredAccelerator,
  type AcceleratorReadiness,
} from './accelerator-readiness';
import { deadlineForCommand } from './ipc-deadlines';
export {
  SidecarOperationError,
  isUncertainOutcome,
  describeOutcome,
  effectOf,
  type OutcomeCertainty,
} from './operation-outcome';

// Sidecar-based implementation for clean production builds.
// We never import 'foundry-local-sdk' in the web bundle.
// All heavy work (including Node natives) happens in the sidecar process.
// Path layout helpers live in sidecar-paths.ts (unit-tested).

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
let sidecarProcess: any = null;
let sidecarReady = false;
let runtimeQuitRequested = false;
let expectedShutdownGeneration: number | null = null;
const closeObservers = new Map<number, Set<() => void>>();
/** Last successful Node runtime (bundled externalBin vs PATH). */
let activeNodeMode: NodeRuntimeMode | null = null;
type PendingRequest = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  cmd: SidecarCommandName;
  /** Whether the bytes are known to have left. Only `false` proves the request never ran. */
  dispatched: boolean;
  deadlineTimer?: ReturnType<typeof setTimeout>;
};
let pending = new Map<number, PendingRequest>();
let streamHandlers = new Map<number, (delta: string) => void>();
type ProgressHandler = {
  onProgress?: (p: number, detail?: any) => void;
  watchdog?: ProgressStallWatchdog;
};
let progressHandlers = new Map<number, ProgressHandler>();
let msgId = 0;
let currentStatus: any = { initialized: false, modelLoaded: false, serviceRunning: false };
let currentRuntimeServiceState: RuntimeServiceState = 'unknown';
export type ModelInfo = IModel & {
  isCached?: boolean;
  isLoaded?: boolean;
  contextLength?: number | null;
  supportsToolCalling?: boolean | null;
};

let managerInstance: any = null;
let managerReady = false;
/** Bumped for every sidecar child, so async work can tell whether its child is still the live one. */
let sidecarGeneration = 0;
let currentEndpoint: string | undefined = undefined;
/** Init payload of the last successful init, so a crash-respawned sidecar can be re-inited. */
let lastInitPayload: { appName: string; logLevel: string } | null = null;

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
    lower.includes('program not found') ||
    lower.includes('failed to find sidecar') ||
    lower.includes('sidecar binary')
  ) {
    return buildNodeMissingMessage(undefined, {
      bundledOnly: activeNodeMode === 'bundled',
      tried: activeNodeMode ? [activeNodeMode] : ['bundled', 'path'],
    });
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

function readNodeRuntimePreference(): ReturnType<typeof parseNodeRuntimePreference> {
  // Vite can inject at build time; default auto (bundled then PATH).
  try {
    const env = (import.meta as any)?.env;
    const fromVite = env?.VITE_FLINT_NODE_RUNTIME ?? env?.FLINT_NODE_RUNTIME;
    if (fromVite) return parseNodeRuntimePreference(String(fromVite));
  } catch {
    /* ignore */
  }
  return 'auto';
}

function createNodeVersionCommand(mode: NodeRuntimeMode) {
  const prog = shellProgramForNodeMode(mode);
  if (prog.kind === 'sidecar') {
    return Command.sidecar(prog.name, ['-v']);
  }
  return Command.create(prog.name, ['-v']);
}

function createSidecarSpawnCommand(mode: NodeRuntimeMode, script: string, opts: any) {
  const prog = shellProgramForNodeMode(mode);
  if (prog.kind === 'sidecar') {
    return Command.sidecar(prog.name, [script], opts);
  }
  return Command.create(prog.name, [script], opts);
}

async function probeNodeMode(mode: NodeRuntimeMode): Promise<NodePreflightResult> {
  let stdout = '';
  let probeError: string | null = null;
  try {
    const command = createNodeVersionCommand(mode);
    const output = await command.execute();
    stdout = decodeShellOutput(output.stdout ?? '');
    const stderr = decodeShellOutput(output.stderr ?? '').trim();
    if (output.code !== 0 && output.code !== null && output.code !== undefined) {
      probeError =
        stderr ||
        `${mode} node -v exited with code ${output.code}` +
          (stdout ? ` (stdout: ${stdout.trim()})` : '');
    } else if (!stdout.trim() && stderr) {
      // Some environments print version to stderr.
      stdout = stderr;
    }
  } catch (e: any) {
    probeError = e?.message ? String(e.message) : String(e);
  }

  return evaluateNodeProbe({
    stdout,
    probeError,
    mode,
    missingContext: { tried: [mode], bundledOnly: mode === 'bundled' },
  });
}

/**
 * Verify Node.js (bundled externalBin first, then PATH) meets MIN_NODE_VERSION
 * before spawning the sidecar.
 */
export async function ensureNodeRuntime(): Promise<NodePreflightResult> {
  const preference = readNodeRuntimePreference();
  const order = nodeRuntimeProbeOrder(preference);
  const failures: NodePreflightFailure[] = [];
  const errors: string[] = [];

  for (const mode of order) {
    const result = await probeNodeMode(mode);
    if (result.ok) {
      activeNodeMode = mode;
      console.log(`[sdk] Node preflight OK (${mode}): ${result.version.raw}`);
      return result;
    }
    failures.push(result);
    errors.push(`${mode}: ${result.code}`);
    console.warn(`[sdk] Node probe failed (${mode}): ${result.code}`);
  }

  activeNodeMode = null;
  // Keep TOO_OLD / PROBE_FAILED guidance; only use full-order MISSING when that is all we have.
  const result = pickBestNodePreflightFailure(failures, order);
  console.error(
    `[sdk] Node preflight failed (${result.code}; tried ${errors.join(', ') || 'none'}):`,
    result.message,
  );
  return result;
}

/** Last successful Node mode after ensureNodeRuntime / startSidecar. */
export function getActiveNodeRuntimeMode(): NodeRuntimeMode | null {
  return activeNodeMode;
}

export interface PoolEntry {
  alias: string;
  variantId: string;
  isLoaded: boolean | null;
  /** Epoch ms of the most recent request; drives idle eviction. */
  lastUsedAt?: number;
  /** Requests currently being served. Non-zero means the model is exempt from eviction. */
  inFlight?: number;
  priority?: ModelPriority;
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
  /** Echoed back by the sidecar so the UI shows the rules actually in force. */
  eviction?: EvictionConfig;
}

export type RuntimeProcessState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'crashed' | 'unknown';
export type RuntimeManagerState = 'unknown' | 'uninitialized' | 'initializing' | 'ready' | 'failed';
export type RuntimeServiceState = 'unknown' | 'stopped' | 'starting' | 'draining' | 'stopping' | 'running' | 'failed';
export type RuntimeModelState = 'unknown' | 'empty' | 'loading' | 'ready';

export interface RuntimeState {
  process: RuntimeProcessState;
  manager: RuntimeManagerState;
  service: RuntimeServiceState;
  models: RuntimeModelState;
  generation: number;
}

export interface FlintSDKState {
  runtime: RuntimeState;
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

export interface CacheInventoryEntry {
  path: string;
  alias: string | null;
  variantId: string | null;
  sizeBytes: number;
  partial: boolean;
  linked: boolean;
  owned: boolean;
}

export interface CacheInventory {
  entries: CacheInventoryEntry[];
  totalBytes: number;
  partialBytes: number;
  duplicateBytes: number;
  duplicateGroups: Array<{
    alias: string;
    entries: string[];
    bytes: number;
    recommendation: string;
  }>;
  partialEntries: Array<{ path: string; bytes: number; recommendation: string }>;
  scannedAt: number;
}

const initialState: FlintSDKState = {
  runtime: {
    process: 'stopped',
    manager: 'unknown',
    service: 'unknown',
    models: 'unknown',
    generation: 0,
  },
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

/**
 * Reject everything outstanding, saying what is known about each.
 *
 * The requests are not in the same position. A query that was interrupted changed nothing; a
 * mutation may have completed with its acknowledgement lost in the dead process. Rejecting them
 * all with one message would tell the user something false about the second kind.
 */
function drainPending(cause: InterruptionCause, detail: string) {
  for (const { reject, cmd, dispatched, deadlineTimer } of pending.values()) {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    const actual: InterruptionCause = dispatched ? cause : 'not-dispatched';
    reject(new SidecarOperationError(cmd, certaintyFor(cmd, actual), detail));
  }
  pending.clear();
  streamHandlers.clear();
  clearProgressHandlers();
}

function cancelUndispatchedForRuntimeQuit() {
  for (const [id, entry] of [...pending]) {
    if (!entry.dispatched) cancelBeforeDispatch(id);
  }
}

function observeSidecarClose(generation: number, timeoutMs: number): Promise<boolean> {
  if (generation !== sidecarGeneration || !sidecarProcess) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const observers = closeObservers.get(generation);
      observers?.delete(onClose);
      if (observers?.size === 0) closeObservers.delete(generation);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    const observers = closeObservers.get(generation) ?? new Set();
    observers.add(onClose);
    closeObservers.set(generation, observers);
  });
}

function notifySidecarClose(generation: number) {
  const observers = closeObservers.get(generation);
  if (!observers) return;
  closeObservers.delete(generation);
  for (const resolve of observers) resolve();
}

function deleteProgressHandler(id: number) {
  progressHandlers.get(id)?.watchdog?.stop();
  progressHandlers.delete(id);
}

function clearProgressHandlers() {
  for (const handler of progressHandlers.values()) handler.watchdog?.stop();
  progressHandlers.clear();
}

function registerProgressHandler(
  id: number,
  onProgress?: (p: number, detail?: any) => void,
  onStall?: () => void,
) {
  if (!onProgress && !onStall) return;
  progressHandlers.set(id, {
    onProgress,
    watchdog: onStall
      ? createProgressStallWatchdog(() => {
          try { onStall(); } catch {}
        })
      : undefined,
  });
}

function updateState(partial: Partial<FlintSDKState>) {
  sdkState.update((s) => ({ ...s, ...partial }));
}

function updateRuntime(partial: Partial<RuntimeState>) {
  if (partial.service) currentRuntimeServiceState = partial.service;
  sdkState.update((s) => ({ ...s, runtime: { ...s.runtime, ...partial } }));
}

export function getSDKState() {
  return sdkState;
}

let startPromise: Promise<void> | null = null;

/**
 * Spawn the sidecar, at most once at a time.
 *
 * The `sidecarProcess` guard alone is not enough: the function awaits the Node preflight and
 * resource resolution *before* assigning `sidecarProcess`, so two callers arriving together
 * would both pass the check and spawn a child. The second child's stdout is never read, and it
 * keeps a second Foundry core alive.
 */
async function startSidecar(): Promise<void> {
  if (sidecarProcess) return;
  if (startPromise) return startPromise;
  startPromise = spawnSidecar().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function spawnSidecar() {
  if (sidecarProcess) return;
  if (runtimeQuitRequested) {
    throw new Error('The runtime is shutting down.');
  }
  updateRuntime({ process: 'starting', manager: 'unknown', service: 'unknown', models: 'unknown' });

  const nodeCheck = await ensureNodeRuntime();
  if (!nodeCheck.ok) {
    updateState({ ready: false, error: nodeCheck.message });
    updateRuntime({ process: 'stopped', manager: 'unknown', service: 'unknown', models: 'unknown' });
    throw new Error(nodeCheck.message);
  }

  // Resolve resource keys via Tauri, then select layout (flattened / legacy / dev) with pure helpers.
  // IMPORTANT: resolveResource only joins paths — it does not check the file exists.
  const candidates: ResolvedSidecarCandidate[] = [];
  for (const key of SIDECAR_RESOURCE_CANDIDATES) {
    try {
      const resolvedPath = await resolveResource(key);
      let fileExists = false;
      try {
        fileExists = await exists(resolvedPath);
      } catch (e) {
        // fs scope may block; fall through with a packaged-path heuristic
        console.log(`[sdk] exists() check failed for ${resolvedPath}: ${e}`);
        fileExists = /[/\\]sidecar[/\\]foundry-sidecar\.js$/i.test(resolvedPath);
      }
      candidates.push({ key, resolvedPath, exists: fileExists });
      if (!fileExists) {
        console.log(`[sdk] Sidecar candidate missing (${key}): ${resolvedPath}`);
      }
    } catch {
      // resolveResource unavailable for this key
    }
  }

  let resourceDirPath: string | undefined;
  try {
    resourceDirPath = await resourceDir();
    console.log(`[sdk] Resource dir: ${resourceDirPath}`);
  } catch {
    console.log(`[sdk] resourceDir unavailable`);
  }

  const spawnPaths = selectSidecarSpawnPaths({
    candidates,
    resourceDir: resourceDirPath,
  });
  const { script, baseDir, isDev, nodePath } = spawnPaths;
  if (isDev) {
    console.log(`[sdk] Dev/fallback sidecar resolution: script=${script}`);
  } else {
    console.log(`[sdk] Production sidecar resolution: script=${script}`);
  }

  // NODE_PATH only; native Foundry core discovery stays in the sidecar (platform-correct).
  const env: Record<string, string> = {};
  if (nodePath) {
    env.NODE_PATH = nodePath;
  }

  const opts: any = baseDir
    ? { cwd: baseDir, env }
    : Object.keys(env).length
      ? { env }
      : undefined;

  const nodeMode: NodeRuntimeMode = activeNodeMode ?? 'path';
  console.log(
    `[sdk] Spawning sidecar - node=${nodeMode}, isDev=${isDev}, script=${script}, NODE_PATH=${env.NODE_PATH || ''}`,
  );

  const command = createSidecarSpawnCommand(nodeMode, script, opts);

  // Attach stdout listener to the command (works before/after spawn in plugin-shell)
  let stdoutBuffer = '';
  let stdoutEventFired = false;
  const stderrLines: string[] = [];
  let closeData: any = null;
  let commandError: string | null = null;
  // Set once spawn() resolves. A child keeps its own event listeners after a replacement is
  // spawned, so every incoming line must be checked against the live process generation too.
  let myGeneration: number | null = null;
  let supersededOutputLogged = false;

  const processStdoutLine = (line: string) => {
    if (!line.trim()) return;
    if (myGeneration !== null && myGeneration !== sidecarGeneration) {
      if (!supersededOutputLogged) {
        console.warn('[sdk] Ignoring stdout from a superseded sidecar child');
        supersededOutputLogged = true;
      }
      return;
    }
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
          handler.watchdog?.progress();
          try { handler.onProgress?.(Number(msg.progress), msg); } catch {}
        }
        if (msg.alias) {
          console.log(`[sdk] download progress ${msg.alias}: ${msg.progress}%`);
        }
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        // Settled here and nowhere else afterwards: a `close` following a reply, or a write
        // rejection that lands late, must not overwrite an answer the child actually gave.
        pending.delete(msg.id);
        if (p.deadlineTimer) clearTimeout(p.deadlineTimer);
        streamHandlers.delete(msg.id);
        deleteProgressHandler(msg.id);
        // The child answered, so this is not a lost acknowledgement — the operation genuinely
        // did not complete. It may still have done part of its work, which `describeOutcome`
        // says rather than implying a rollback that never happens.
        msg.error
          ? p.reject(
              new SidecarOperationError(
                p.cmd,
                msg.certainty === 'cancelled' ? 'cancelled' : 'failed',
                String(msg.error),
              ),
            )
          : p.resolve(msg);
      } else if (msg.type === 'log') {
        console.log(`[sidecar] ${msg.level}: ${msg.message}`);
        sdkState.update(s => ({ ...s, logs: [...s.logs.slice(-199), { ts: msg.timestamp ?? Date.now(), level: msg.level ?? 'info', message: msg.message, source: 'sidecar' as const }] }));
      } else if (msg.ready) {
        if (msg.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
          console.error(
            `[sdk] Unsupported sidecar protocol version: ${String(msg.protocolVersion)}`,
          );
          commandError = `Unsupported sidecar protocol version: ${String(msg.protocolVersion)}`;
          return;
        }
        console.log(`[sdk] Sidecar ready signal received (protocol ${msg.protocolVersion})!`);
        sidecarReady = true;
        updateRuntime({ process: 'ready', manager: 'uninitialized' });
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

  // Until spawn() resolves this attempt has no generation, but it is still the only attempt in
  // flight (startSidecar is single-flight), so its close/error events are ours.
  const ownsGlobalState = () => myGeneration === null || myGeneration === sidecarGeneration;

  command.on('close', (data: any) => {
    closeData = data;
    console.log(`[sdk] Sidecar process closed (exit code: ${data?.code})`);
    // A killed older child can emit `close` after Retry already spawned a replacement. Leaving
    // this unguarded would invalidate the new child and drain its pending requests.
    if (!ownsGlobalState()) {
      console.log('[sdk] Ignoring close from a superseded sidecar child');
      return;
    }
    const closedGeneration = myGeneration ?? sidecarGeneration;
    const expectedShutdown = expectedShutdownGeneration === closedGeneration;
    sidecarReady = false;
    sidecarProcess = null;
    // The manager lived inside that process. Leaving `managerInstance` set would make
    // initializeSDK() return true immediately on the next Retry, reporting "ready" without
    // ever running init — the app would look healthy against a dead child.
    managerInstance = null;
    managerReady = false;
    currentEndpoint = undefined;
    // Residency, the gateway and the native service all belonged to that process. Leaving the
    // pool populated would show models as resident — and let callers skip loading them —
    // against a child that no longer exists.
    sdkState.update((s) => ({
      ...s,
      runtime: {
        ...s.runtime,
        process: expectedShutdown ? 'stopped' : 'crashed',
        manager: 'unknown',
        service: expectedShutdown ? 'stopped' : 'unknown',
        models: expectedShutdown ? 'empty' : 'unknown',
        generation: sidecarGeneration,
      },
      ready: false,
      error: expectedShutdown ? null : 'Sidecar closed',
      serviceRunning: false,
      endpoint: undefined,
      pool: [],
      poolStats: null,
      loadedModels: [],
      models: s.models.map((m) => (m.isLoaded ? { ...m, isLoaded: false } : m)),
    }));
    drainPending('connection-lost', 'The runtime process stopped.');
    notifySidecarClose(closedGeneration);
    if (expectedShutdown) expectedShutdownGeneration = null;
  });

  command.on('error', (error: any) => {
    commandError = String(error);
    console.error(`[sdk] Sidecar error event:`, error);
    if (!ownsGlobalState()) return;
    updateState({ error: `Sidecar error: ${error}` });
    drainPending('connection-lost', `The runtime process reported an error: ${error}`);
  });

  // spawn() returns the Child process which has .write()
  console.log(`[sdk] Calling spawn()...`);
  const spawnedProcess = await command.spawn();
  if (closeData) {
    throw new Error(formatStartupFailure(stdoutEventFired, stderrLines, closeData, commandError));
  }
  sidecarProcess = spawnedProcess;
  myGeneration = ++sidecarGeneration;
  if (runtimeQuitRequested) {
    expectedShutdownGeneration = myGeneration;
    updateRuntime({ generation: myGeneration, process: 'stopping' });
    try {
      const killing = sidecarProcess.kill?.();
      Promise.resolve(killing).catch(() => {});
    } catch {}
    throw new Error('The runtime was asked to shut down while it was starting.');
  }
  updateRuntime({ generation: myGeneration, process: sidecarReady ? 'ready' : 'starting' });
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
    if (!runtimeQuitRequested) {
      try {
        const killing = sidecarProcess?.kill?.();
        Promise.resolve(killing).catch(() => {});
      } catch {}
    }
    sidecarReady = false;
    throw e;
  }
}

/**
 * Send one command and resolve when the sidecar answers it.
 *
 * Deliberately **not** `async`. The returned promise is the request's own settlement promise,
 * handed back before the runtime is started, so anything that settles the request during that
 * preparation — a cancellation, a drain on process death — reaches the caller at once. An
 * `async` wrapper would have parked the caller on the preparation instead, and a request already
 * answered as cancelled would have gone on waiting for a start it was no longer part of.
 */
function sendInternal(
  cmd: SidecarCommandName,
  payload: any = {},
  onStream?: (delta: string) => void,
  onAssignedId?: (id: number) => void,
  onDispatch?: (generation: number) => void,
): Promise<any> {
  if (runtimeQuitRequested && cmd !== 'shutdownRuntime') {
    return Promise.reject(
      new SidecarOperationError(
        cmd,
        'cancelled',
        'The runtime is shutting down, so this request was not sent.',
      ),
    );
  }
  // Allocated before anything is awaited, so a Stop arriving while the sidecar is still starting
  // has an id to name. Previously the id existed only after startup finished, so a stop during
  // that window had nothing to cancel and the request was written anyway once startup completed.
  const id = ++msgId;
  const entry: PendingRequest = {
    resolve: (_v: any) => {},
    reject: (_e: any) => {},
    cmd,
    dispatched: false,
  };

  // The promise is built, and its real handlers installed, *before* the entry is published or
  // any callback runs. Publishing first would leave a window in which the entry is cancellable
  // while `reject` is still the placeholder no-op: cancelling from inside `onAssignedId` would
  // remove the entry, call nothing, and leave a promise nobody can ever settle.
  const promise = new Promise<any>((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });

  // Registered before the entry becomes visible, so a cancellation during `onAssignedId` removes
  // the stream handler along with the entry rather than orphaning it.
  if (onStream) {
    streamHandlers.set(id, onStream);
  }

  pending.set(id, entry);

  if (onAssignedId) {
    try {
      onAssignedId(id);
    } catch (e) {
      // The callback is the caller's code. Letting it escape would abandon a published entry
      // with nothing left to settle it, so the request is retired as never sent.
      pending.delete(id);
      streamHandlers.delete(id);
      deleteProgressHandler(id);
      entry.reject(
        new SidecarOperationError(cmd, 'failed', 'The request was abandoned before it was sent.', e),
      );
      return promise;
    }
  }

  /** Settles once. A later close, or a write rejection that lands after a reply, is ignored. */
  const settle = (fn: () => void) => {
    if (pending.get(id) !== entry) return;
    pending.delete(id);
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    streamHandlers.delete(id);
    deleteProgressHandler(id);
    fn();
  };

  /**
   * Whether this request may still act.
   *
   * Settling removes the entry, and this is checked after every await and immediately before the
   * write. Settling has to revoke permission to dispatch, not merely fix the answer: a request
   * drained as "never sent" while the runtime was starting would otherwise carry on and write
   * itself to the child that the drain did not kill, so a deletion could be reported as not
   * having happened and then happen.
   */
  const active = () => pending.get(id) === entry;

  const deadlineMs = deadlineForCommand(cmd);
  if (deadlineMs !== null) {
    entry.deadlineTimer = setTimeout(() => {
      const cause: InterruptionCause = entry.dispatched ? 'deadline-expired' : 'not-dispatched';
      settle(() =>
        entry.reject(
          new SidecarOperationError(
            cmd,
            certaintyFor(cmd, cause),
            `The runtime did not answer within ${deadlineMs / 1000} seconds.`,
          ),
        ),
      );
    }, deadlineMs);
  }

  void (async () => {
    // Cancelled from inside `onAssignedId`, before this continuation began.
    if (!active()) return;
    try {
      if (!sidecarProcess || !sidecarReady) {
        await startSidecar();
        if (!active()) return;
        if (!sidecarProcess || !sidecarReady) {
          settle(() =>
            entry.reject(
              new SidecarOperationError(
                cmd,
                'failed',
                'The runtime process did not become ready.',
              ),
            ),
          );
          return;
        }
        // A fresh sidecar process has no SDK manager. If we had initialized before — i.e. this
        // spawn is a respawn after a crash — re-init transparently, or every catalog-touching
        // command would fail until the whole app restarts. This re-initializes a *new* process
        // whose native manager never existed; it does not replay the request that was lost.
        if (lastInitPayload && cmd !== 'init' && !initializing) {
          try {
            await ensureInitialized(lastInitPayload);
            console.log('[sdk] Sidecar respawned — SDK re-initialized');
          } catch (e) {
            // Not swallowed. This command needs the manager that re-init was creating, so a
            // failure here is a failure of the command — sending it anyway would ask a child
            // with no manager to do the work and report whatever it made of that.
            console.warn('[sdk] Sidecar respawn re-init failed', e);
            settle(() =>
              entry.reject(
                new SidecarOperationError(
                  cmd,
                  'failed',
                  'The runtime restarted and could not be prepared, so the request was not sent.',
                  e,
                ),
              ),
            );
            return;
          }
          if (!active()) return;
        }
      }
      if (!active()) return;

      let line: string;
      try {
        line = JSON.stringify({
          id,
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          cmd,
          ...payload,
        }) + '\n';
      } catch (e) {
        // Nothing reached the pipe, so nothing ran.
        settle(() =>
          entry.reject(
            new SidecarOperationError(cmd, 'failed', 'The request could not be encoded.', e),
          ),
        );
        return;
      }
      if (!sidecarProcess) {
        settle(() =>
          entry.reject(
            new SidecarOperationError(cmd, 'failed', 'The runtime process is not running.'),
          ),
        );
        return;
      }

      // Last check before the bytes can move. Nothing is awaited between here and `write()`, so
      // no handler can settle the entry in between.
      if (!active()) return;

      if (onDispatch) {
        try {
          onDispatch(sidecarGeneration);
        } catch (e) {
          settle(() =>
            entry.reject(
              new SidecarOperationError(
                cmd,
                'failed',
                'The request was abandoned before it was sent.',
                e,
              ),
            ),
          );
          return;
        }
      }

      // From here the bytes may reach the child, so the outcome stops being provably negative.
      entry.dispatched = true;
      progressHandlers.get(id)?.watchdog?.start();
      sidecarProcess.write(line).catch((e: any) => {
        // A rejected write does not prove the bytes never arrived — it resolves when they reach
        // the pipe, and rejecting says nothing about what the child had already read. So this
        // is classified by what the command would have done, not treated as a clean failure.
        settle(() =>
          entry.reject(
            new SidecarOperationError(cmd, certaintyFor(cmd, 'write-failed'), String(e), e),
          ),
        );
      });
    } catch (e) {
      // Startup itself failed, so the request was never written.
      settle(() =>
        entry.reject(
          e instanceof SidecarOperationError
            ? e
            : new SidecarOperationError(cmd, 'failed', String((e as any)?.message ?? e), e),
        ),
      );
    }
  })();

  return promise;
}

/**
 * Abandon a request that has not been written yet.
 *
 * Returns true only when the request is known not to have been sent. Once it is dispatched,
 * stopping it is a request to the sidecar rather than something the transport can guarantee.
 *
 * Settles immediately rather than leaving a flag for the send path to notice. That path may be
 * parked on a runtime start that never finishes, and a caller told its request was cancelled
 * must not go on waiting for it — nor later receive `failed` because the start it was no longer
 * part of eventually gave up.
 */
export function cancelBeforeDispatch(id: number): boolean {
  const entry = pending.get(id);
  if (!entry || entry.dispatched) return false;
  pending.delete(id);
  if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
  streamHandlers.delete(id);
  deleteProgressHandler(id);
  entry.reject(new SidecarOperationError(entry.cmd, 'cancelled'));
  return true;
}

async function send(cmd: SidecarCommandName, payload: any = {}): Promise<any> {
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

let initPromise: Promise<void> | null = null;
// True while performInit is running, so the crash-recovery path in sendInternal does not try to
// recover the very commands init itself is issuing (which would await its own promise forever).
let initializing = false;

async function performInit(payload: { appName: string; logLevel: string }) {
  initializing = true;
  updateRuntime({ manager: 'initializing' });
  try {
    // Ensure the child exists *before* capturing its generation — otherwise `sendInternal`
    // would spawn one below, bump the generation, and the check would always fail on a normal
    // cold start.
    await startSidecar();
    // Initialization belongs to one specific child. If that child dies mid-init, a replacement
    // is spawned that has never seen `init`, and the remaining steps would succeed against it
    // while its native manager is absent — leaving `ready: true` on an uninitialized process.
    const generation = sidecarGeneration;
    const stillOurChild = () =>
      generation === sidecarGeneration && !!sidecarProcess && sidecarReady;

    await sendInternal('init', payload);
    if (!stillOurChild()) {
      throw new Error('Sidecar was replaced during initialization');
    }
    await sendInternal('setLogLevel', { level: payload.logLevel });
    if (!stillOurChild()) {
      throw new Error('Sidecar was replaced during initialization');
    }
    lastInitPayload = payload;
    managerInstance = true;
    updateRuntime({ manager: 'ready', models: 'unknown' });
    // The previous child's residency is meaningless; refresh before anyone reads the pool.
    await refreshModels();
    if (!stillOurChild()) {
      throw new Error('Sidecar was replaced while establishing manager readiness');
    }
    managerReady = true;
    updateState({ ready: true, error: null });
  } finally {
    initializing = false;
  }
}

/**
 * Initialize the SDK against the current sidecar child, at most once at a time.
 *
 * Foundry Local's native core initializes once per process — a second `init` throws
 * "already initialized". After a crash several concurrent commands (plus a user-pressed Retry)
 * can all reach for recovery simultaneously, so every path must share one attempt.
 */
function ensureInitialized(payload: { appName: string; logLevel: string }): Promise<void> {
  if (managerInstance && managerReady) return Promise.resolve();
  if (managerInstance) {
    if (initPromise) return initPromise;
    const generation = sidecarGeneration;
    initPromise = (async () => {
      initializing = true;
      updateRuntime({ manager: 'initializing' });
      try {
        await refreshModels();
        if (
          generation !== sidecarGeneration ||
          !sidecarProcess ||
          !sidecarReady ||
          !managerInstance
        ) {
          throw new Error('Sidecar was replaced while restoring manager readiness');
        }
        managerReady = true;
        updateState({ ready: true, error: null });
        updateRuntime({ manager: 'ready' });
      } finally {
        initializing = false;
      }
    })()
      .finally(() => {
        initPromise = null;
      });
    return initPromise;
  }
  if (initPromise) return initPromise;
  initPromise = performInit(payload).finally(() => {
    initPromise = null;
  });
  return initPromise;
}

let initializeSDKPromise: Promise<boolean> | null = null;

/**
 * Bring the SDK up: initialize the core, then start or adopt the local service.
 *
 * Single-flighted as a whole, not just around the core init — otherwise a double Retry would
 * share the init but each caller would still run its own autostart, and `startService` is a
 * destructive restart that would clear the pool out from under the first caller.
 */
export async function initializeSDK(config: Partial<any> = {}): Promise<boolean> {
  if (initializeSDKPromise) return initializeSDKPromise;
  initializeSDKPromise = performInitializeSDK(config).finally(() => {
    initializeSDKPromise = null;
  });
  return initializeSDKPromise;
}

async function performInitializeSDK(config: Partial<any>): Promise<boolean> {
  const initPayload = { appName: config.appName || 'flint', logLevel: config.logLevel || 'info' };
  const alreadyInitialized = !!managerInstance;
  updateState({ error: null });

  try {
    await ensureInitialized(initPayload);
    const readyGeneration = sidecarGeneration;
    // Autostart is a user setting, and the port/bind address belong to the frontend. Starting
    // the service here unconditionally on a hardcoded 5272 both ignored "don't autostart" and
    // opened a port the user had not configured. A repeat call against an already-initialized
    // manager must not restart the service either — that would clear the pool.
    try {
      if (config.autoStartService && !alreadyInitialized) {
        await startService(
          config.servicePort || 5272,
          undefined,
          undefined,
          config.bindAddress || undefined,
          // Automatic, not user-driven: it must both respect an earlier unestablished outcome
          // and record its own, since the error is swallowed just below.
          { convenience: true },
        );
      } else {
        // Adopt whatever is actually running — including a service started before this init.
        const status = await send('getStatus');
        if (status.result?.endpoint) {
          currentEndpoint = status.result.endpoint;
          updateState({ endpoint: status.result.endpoint, serviceRunning: true });
        }
      }
    } catch (e) {
      console.warn('Service start/probe failed (can be started manually)', e);
    }
    if (
      readyGeneration !== sidecarGeneration ||
      !sidecarProcess ||
      !sidecarReady ||
      !managerInstance ||
      !managerReady
    ) {
      throw new Error('Sidecar became unavailable during initialization');
    }
    return true;
  } catch (e: any) {
    const raw = String(e?.message || e || 'Unknown error');
    // Node preflight messages are already complete user guidance — don't wrap them.
    const errMsg =
      raw.includes('Node.js')
        ? raw
        : `Sidecar init failed: ${raw}`;
    updateState({ error: errMsg, ready: false });
    updateRuntime({ manager: 'failed', service: 'unknown', models: 'unknown' });
    return false;
  }
}

export async function refreshModels(): Promise<void> {
  updateRuntime({ models: 'loading' });
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
    updateRuntime({ models: models.some((m: ModelInfo) => m.isLoaded) ? 'ready' : 'empty' });

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
    updateRuntime({ models: 'unknown' });
    throw e;
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
    eviction: result.eviction ?? undefined,
  };
}

export async function getModel(alias: string) {
  // We don't keep full model objects client-side with sidecar.
  // Return a minimal handle; heavy ops go through sidecar.
  return { alias } as any;
}

export async function downloadModel(
  model: any,
  onProgress?: (p: number) => void,
  variantId?: string,
  onStall?: () => void,
) {
  const payload: any = { alias: model.alias };
  if (variantId) payload.variantId = variantId;
  await sendInternal('download', payload, undefined, (id: number) => {
    registerProgressHandler(id, onProgress, onStall);
  });
  // Sidecar sends progress messages via stdout; onAssignedId registers the handler above.
  // The pending promise resolves only on the final reply (see stdout processing).
  await refreshModels();
}

export async function loadModel(model: any, lane?: LaneName, variantId?: string) {
  const payload: any = { alias: model.alias };
  if (lane) payload.lane = lane;
  if (variantId) payload.variantId = variantId;
  let generation: number | null = null;
  const res = await sendInternal(
    'load',
    payload,
    undefined,
    undefined,
    (dispatchedGeneration) => {
      generation = dispatchedGeneration;
    },
  );
  if (!sidecarProcess || !sidecarReady) {
    throw new Error('Sidecar was lost after loading the model');
  }
  await refreshModels();
  if (
    generation === null ||
    generation !== sidecarGeneration ||
    !sidecarProcess ||
    !sidecarReady
  ) {
    throw new Error('Sidecar was replaced while confirming the loaded model');
  }
  return res.result;
}

export async function unloadModel(model: any, lane?: LaneName) {
  const payload: any = { alias: model.alias };
  if (lane) payload.lane = lane;
  await send('unload', payload);
  await refreshModels();
}

/**
 * Pushes the eviction rules to the sidecar, which owns the sweep. The UI is the source of
 * truth for the settings; the sidecar holds them only while it runs.
 */
export async function setEvictionConfig(
  config: Partial<EvictionConfig>,
  opts: { refresh?: boolean } = {},
): Promise<EvictionConfig | null> {
  const payload: any = {};
  if (typeof config.idleUnloadEnabled === 'boolean') payload.idleUnloadEnabled = config.idleUnloadEnabled;
  if (typeof config.idleTimeoutMs === 'number') payload.idleTimeoutMs = config.idleTimeoutMs;
  if (typeof config.maxResidentEnabled === 'boolean') payload.maxResidentEnabled = config.maxResidentEnabled;
  if (typeof config.maxResident === 'number') payload.maxResident = config.maxResident;
  const res = await send('setEvictionConfig', payload);
  // Applying the rules can unload models, so the pool view is stale the moment this returns.
  // Callers that immediately follow up with another refreshing call can skip this one.
  if (opts.refresh !== false) await refreshModels();
  return res.result?.config ?? null;
}

/** Replaces the whole priority map; anything omitted goes back to 'normal'. */
export async function setModelPriorities(
  priorities: ModelPriorityEntry[],
  opts: { refresh?: boolean } = {},
): Promise<void> {
  await send('setModelPriorities', { priorities });
  if (opts.refresh !== false) await refreshModels();
}

/**
 * Install eviction rules and model priorities together.
 *
 * One command because each of the two older commands sweeps immediately: sending them
 * separately means the first sweep runs under half-updated settings and can unload a model the
 * user just pinned.
 */
export async function applyMemorySettings(
  priorities: ModelPriorityEntry[],
  eviction?: Partial<EvictionConfig>,
): Promise<EvictionConfig | null> {
  const res = await send('applyMemorySettings', {
    priorities,
    ...(eviction ? { eviction } : {}),
  });
  await refreshModels();
  return res.result?.config ?? null;
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

export async function getCacheInventory(): Promise<CacheInventory> {
  const res = await send('getCacheInventory');
  if (!res?.result) throw new Error('getCacheInventory returned no result');
  return res.result as CacheInventory;
}

/** State of WSL on this machine, for Settings → Network → WSL clients. */
export interface WslStatusInfo {
  platform: string;
  wslPresent: boolean;
  wslVersion: string | null;
  windowsBuild: number | null;
  /** WSL >= 2.0 on Windows 11 22H2+, i.e. mirrored networking is available. */
  mirroredSupported: boolean;
  networkingMode: string | null;
  mirrored: boolean;
  configPath: string | null;
  configExists: boolean;
}

export interface WslEnableMirroredResult {
  changed: boolean;
  configPath: string;
  backupPath: string | null;
  restartRequired: boolean;
}

export async function getWslStatus(): Promise<WslStatusInfo | null> {
  const res = await send('wslStatus');
  return res?.result ?? null;
}

/** Writes networkingMode=mirrored into %UserProfile%\.wslconfig (backing up the original first). */
export async function enableWslMirroredNetworking(): Promise<WslEnableMirroredResult> {
  const res = await send('wslEnableMirrored');
  if (!res?.result) throw new Error('wslEnableMirrored returned no result');
  return res.result as WslEnableMirroredResult;
}

/** Runs `wsl --shutdown` — terminates all running WSL distros so the config change applies. */
export async function shutdownWsl(): Promise<void> {
  await send('wslShutdown');
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

/**
 * Serializes every service lifecycle transition.
 *
 * The sidecar's `startService` is a *destructive restart*: it tears down the gateway and clears
 * the model pool and usage counters. Overlapping a start with a stop, a settings re-apply or a
 * second start strands in-flight work against an endpoint that is being replaced, so all of
 * them queue here rather than each caller guarding itself.
 */
let serviceTransition: Promise<unknown> = Promise.resolve();

function queueServiceTransition<T>(fn: () => Promise<T>): Promise<T> {
  const next = serviceTransition.then(fn, fn);
  // Keep the chain alive even when a transition fails; a rejected tail would reject every
  // subsequent transition.
  serviceTransition = next.catch(() => {});
  return next;
}

/** True while a start/stop/restart is in progress, for disabling UI that would overlap it. */
export function isServiceTransitioning(): boolean {
  return serviceTransitionDepth > 0;
}

let serviceTransitionDepth = 0;
/** Invalidates starts that were queued before the most recent Stop request. */
let serviceStopFence = 0;

/**
 * Set when a start's outcome could not be established — the acknowledgement was lost, so the
 * service may well be running.
 *
 * Held here rather than in the UI because the check has to happen *inside* the transition lock.
 * A flag consulted before queuing lets two convenience starts both pass while neither has run,
 * so the first one's uncertainty cannot stop the second. Starting is a destructive restart: it
 * tears down the gateway and clears the pool, so repeating one blindly is the specific harm.
 *
 * Deliberately **not** clearable from outside. An explicit start is authorized by passing no
 * `convenience` flag, which bypasses the guard for that one attempt; clearing the shared latch
 * instead would also release every convenience start already queued behind the lock, so one
 * authorized retry would license several destructive restarts. The latch is updated only by an
 * attempt's own outcome.
 */
let serviceStartUncertain = false;

/** Whether convenience starts are currently standing down after an unestablished outcome. */
export function isServiceStartUncertain(): boolean {
  return serviceStartUncertain;
}

/**
 * Start the service *without* taking the transition lock. Only reachable through the
 * `startNow` handle `withServiceTransition` passes to its callback, so the serialization
 * invariant cannot be bypassed from outside this module.
 */
async function startServiceLocked(
  port = 5272,
  alias?: string,
  preferredEp?: string,
  bindAddress?: string,
  opts?: { convenience?: boolean },
  fence?: number,
): Promise<string> {
  if (fence !== undefined && fence !== serviceStopFence) {
    throw new SidecarOperationError(
      'startService',
      'cancelled',
      'This start was queued before a Stop request and was cancelled before dispatch.',
    );
  }
  // Evaluated here, at execution time under the lock, so a start queued before an earlier one
  // reported uncertainty still sees that uncertainty.
  if (opts?.convenience && serviceStartUncertain) {
    throw new SidecarOperationError(
      'startService',
      'unknown',
      'A previous start did not report its outcome, so the service may already be running. Start it explicitly from Settings to try again.',
    );
  }
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
  let res: any;
  let generation: number | null = null;
  updateRuntime({ service: 'starting' });
  try {
    res = await sendInternal(
      'startService',
      payload,
      undefined,
      undefined,
      (dispatchedGeneration) => {
        generation = dispatchedGeneration;
      },
    );
  } catch (e) {
    currentEndpoint = undefined;
    updateState({ endpoint: undefined, serviceRunning: false });
    // Recorded before the lock is released, so the next transition in the queue sees it.
    if (isUncertainOutcome(e)) {
      serviceStartUncertain = true;
      updateRuntime({ service: 'unknown' });
    } else {
      updateRuntime({ service: 'failed' });
    }
    throw e;
  }
  if (
    generation === null ||
    generation !== sidecarGeneration ||
    !sidecarProcess ||
    !sidecarReady
  ) {
    currentEndpoint = undefined;
    updateState({ endpoint: undefined, serviceRunning: false });
    throw new SidecarOperationError(
      'startService',
      'failed',
      'The sidecar exited after starting the service, so its endpoint is no longer available.',
    );
  }
  // A confirmed start settles the question the flag existed to represent.
  serviceStartUncertain = false;
  currentEndpoint = res.endpoint;
  updateState({ endpoint: currentEndpoint, serviceRunning: true });
  updateRuntime({ service: 'running' });
  return currentEndpoint!;
}

export async function startService(
  port = 5272,
  alias?: string,
  preferredEp?: string,
  bindAddress?: string,
  opts?: { convenience?: boolean }
): Promise<string> {
  const fence = serviceStopFence;
  return withServiceTransition(() =>
    startServiceLocked(port, alias, preferredEp, bindAddress, opts, fence),
  );
}

/**
 * Ensure the HTTP service is running without restarting a healthy endpoint.
 *
 * The status probe and possible start share the transition lock, so a concurrent Stop or
 * explicit restart cannot make the decision against a stale endpoint.
 */
export async function ensureServiceRunning(
  port = 5272,
  alias?: string,
  preferredEp?: string,
  bindAddress?: string,
  opts?: { convenience?: boolean; expectedGeneration?: number },
): Promise<{ endpoint: string; started: boolean }> {
  const authorizationFence = serviceStopFence;
  return withServiceTransition(async ({ startNow }) => {
    const assertAuthorized = () => {
      if (authorizationFence !== serviceStopFence) {
        throw new SidecarOperationError(
          'startService',
          'cancelled',
          'This service ensure was queued before a Stop request and was cancelled.',
        );
      }
      if (
        opts?.expectedGeneration !== undefined &&
        (
          opts.expectedGeneration !== sidecarGeneration ||
          !sidecarProcess ||
          !sidecarReady
        )
      ) {
        throw new SidecarOperationError(
          'startService',
          'cancelled',
          'Runtime changed before the service could start.',
        );
      }
    };
    assertAuthorized();
    if (currentEndpoint && currentRuntimeServiceState === 'running') {
      return { endpoint: currentEndpoint, started: false };
    }

    try {
      const status = await send('getStatus');
      const endpoint = status.result?.endpoint;
      if (status.result?.serviceRunning && endpoint) {
        assertAuthorized();
        currentEndpoint = endpoint;
        updateState({ endpoint, serviceRunning: true });
        updateRuntime({ service: 'running' });
        return { endpoint, started: false };
      }
    } catch (e) {
      // A failed probe is not proof that the service is stopped; startService below preserves
      // the existing uncertainty rules if it must attempt a destructive transition.
      console.warn('[sdk] service status probe failed during ensure', e);
    }

    assertAuthorized();
    return {
      endpoint: await startNow(port, alias, preferredEp, bindAddress, opts),
      started: true,
    };
  });
}

export async function stopService(): Promise<void> {
  serviceStopFence += 1;
  return withServiceTransition(async () => {
    updateRuntime({ service: 'stopping' });
    try {
      await send('stopService');
    } catch (e) {
      currentEndpoint = undefined;
      updateState({ endpoint: undefined, serviceRunning: false });
      updateRuntime({ service: isUncertainOutcome(e) ? 'unknown' : 'failed' });
      throw e;
    }
    // The latch is deliberately **not** cleared here. A Stop acknowledgement is not a quiescence
    // guarantee: the sidecar handles commands concurrently, so a start whose acknowledgement was
    // lost may still be inside `startWebService()` and can bring the service up again after Stop
    // has replied. The sidecar also reports Stop as successful when the native stop throws. Only
    // a start that reports its own outcome can retire the uncertainty.
    currentEndpoint = undefined;
    updateState({ endpoint: undefined, serviceRunning: false });
    updateRuntime({ service: 'stopped' });
  });
}

export interface RuntimeShutdownCleanup {
  endpointWithdrawn: boolean;
  serviceStopped: boolean;
  drained: boolean;
  activeOperations: Array<{ id: number | string; command: string }>;
  modelsUnloaded: string[];
  unloadFailures: string[];
  nativeServiceStopped: boolean;
  cleanup: 'confirmed' | 'timed-out' | 'failed';
}

export interface RuntimeQuitResult {
  cleanup: RuntimeShutdownCleanup | null;
  termination: 'confirmed' | 'escalated-confirmed' | 'unconfirmed';
}

let runtimeQuitPromise: Promise<RuntimeQuitResult> | null = null;

function normalizeRuntimeTimeout(value: number | undefined, fallback: number, minimum: number): number {
  return Number.isFinite(value) && value! >= 0
    ? Math.max(minimum, Math.floor(value!))
    : fallback;
}

/** Stop HTTP traffic and unload models after already-admitted work drains. */
export async function stopAndUnload(options: {
  drainTimeoutMs?: number;
} = {}): Promise<RuntimeShutdownCleanup> {
  serviceStopFence += 1;
  return withServiceTransition(async () => {
    updateRuntime({ service: 'draining' });
    const drainTimeoutMs = normalizeRuntimeTimeout(options.drainTimeoutMs, 5_000, 0);
    let result: RuntimeShutdownCleanup;
    try {
      const response = await send('stopAndUnload', { drainTimeoutMs });
      result = response.result as RuntimeShutdownCleanup;
    } catch (e) {
      currentEndpoint = undefined;
      updateState({ endpoint: undefined, serviceRunning: false });
      updateRuntime({
        service: isUncertainOutcome(e) ? 'unknown' : 'failed',
        models: 'unknown',
      });
      throw e;
    }

    const unloaded = new Set(result.modelsUnloaded);
    currentEndpoint = undefined;
    currentRuntimeServiceState = result.serviceStopped ? 'stopped' : 'failed';
    sdkState.update((state) => ({
      ...state,
      endpoint: undefined,
      serviceRunning: false,
      pool: state.pool.filter((entry) => !unloaded.has(entry.alias)),
      loadedModels: state.loadedModels.filter((model) => !unloaded.has(model.alias)),
      models: state.models.map((model) =>
        unloaded.has(model.alias) ? { ...model, isLoaded: false } : model
      ),
      runtime: {
        ...state.runtime,
        service: result.serviceStopped ? 'stopped' : 'failed',
        models: result.drained && result.unloadFailures.length === 0 ? 'empty' : 'unknown',
      },
    }));
    return result;
  });
}

/**
 * Shut down the runtime process, escalating to the owned child handle only when graceful cleanup
 * does not produce a close event. Process termination is reported only from that close event.
 */
export function quitRuntime(options: {
  drainTimeoutMs?: number;
  gracefulTimeoutMs?: number;
  killTimeoutMs?: number;
} = {}): Promise<RuntimeQuitResult> {
  if (runtimeQuitPromise) return runtimeQuitPromise;

  runtimeQuitRequested = true;
  serviceStopFence += 1;
  cancelUndispatchedForRuntimeQuit();

  const quitting = (async (): Promise<RuntimeQuitResult> => {
    const gracefulTimeoutMs = normalizeRuntimeTimeout(options.gracefulTimeoutMs, 6_000, 1);
    if (!sidecarProcess && startPromise) {
      await Promise.race([
        startPromise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, gracefulTimeoutMs)),
      ]);
    }

    const processToStop = sidecarProcess;
    const generation = sidecarGeneration;
    if (!processToStop) {
      if (startPromise) {
        updateRuntime({ process: 'unknown', service: 'unknown', models: 'unknown' });
        updateState({ ready: false, error: 'Runtime termination could not be confirmed.' });
        return { cleanup: null, termination: 'unconfirmed' };
      }
      updateRuntime({ process: 'stopped', service: 'stopped', models: 'empty' });
      updateState({
        ready: false,
        error: null,
        endpoint: undefined,
        serviceRunning: false,
        pool: [],
        poolStats: null,
        loadedModels: [],
      });
      return { cleanup: null, termination: 'confirmed' };
    }

    const drainTimeoutMs = normalizeRuntimeTimeout(options.drainTimeoutMs, 4_000, 0);
    const killTimeoutMs = normalizeRuntimeTimeout(options.killTimeoutMs, 2_000, 1);
    expectedShutdownGeneration = generation;
    updateRuntime({ process: 'stopping', service: 'draining' });

    if (!sidecarReady) {
      const forcedClose = observeSidecarClose(generation, killTimeoutMs);
      try {
        const killing = processToStop.kill?.();
        Promise.resolve(killing).catch((e) => {
          console.warn('[sdk] Failed to terminate sidecar while it was starting', e);
        });
      } catch (e) {
        console.warn('[sdk] Failed to terminate sidecar while it was starting', e);
      }
      if (await forcedClose) {
        return { cleanup: null, termination: 'escalated-confirmed' };
      }
      updateRuntime({ process: 'unknown', service: 'unknown', models: 'unknown' });
      updateState({ ready: false, error: 'Runtime termination could not be confirmed.' });
      return { cleanup: null, termination: 'unconfirmed' };
    }

    const gracefulClose = observeSidecarClose(generation, gracefulTimeoutMs);
    const command = sendInternal('shutdownRuntime', { drainTimeoutMs }).then(
      (response) => ({ kind: 'reply' as const, cleanup: response.result as RuntimeShutdownCleanup }),
      (error) => ({ kind: 'error' as const, error }),
    );
    const first = await Promise.race([
      gracefulClose.then((closed) => ({ kind: 'close' as const, closed })),
      command,
    ]);

    const cleanup: RuntimeShutdownCleanup | null =
      first.kind === 'reply' ? first.cleanup : null;
    let closed = first.kind === 'close' ? first.closed : await gracefulClose;
    if (closed) return { cleanup, termination: 'confirmed' };

    const forcedClose = observeSidecarClose(generation, killTimeoutMs);
    try {
      const killing = processToStop.kill?.();
      Promise.resolve(killing).catch((e) => {
        console.warn('[sdk] Failed to terminate sidecar after graceful shutdown timed out', e);
      });
    } catch (e) {
      console.warn('[sdk] Failed to terminate sidecar after graceful shutdown timed out', e);
    }
    closed = await forcedClose;
    if (closed) return { cleanup, termination: 'escalated-confirmed' };

    updateRuntime({ process: 'unknown', service: 'unknown', models: 'unknown' });
    updateState({
      ready: false,
      error: 'Runtime termination could not be confirmed.',
      endpoint: undefined,
      serviceRunning: false,
    });
    return { cleanup, termination: 'unconfirmed' };
  })();
  const resultPromise = quitting.finally(() => {
    runtimeQuitPromise = null;
  });
  runtimeQuitPromise = resultPromise;
  return resultPromise;
}

/** The lock-free lifecycle operations handed to a `withServiceTransition` callback. */
export interface ServiceTransitionHandle {
  startNow(
    port?: number,
    alias?: string,
    preferredEp?: string,
    bindAddress?: string,
    opts?: { convenience?: boolean },
  ): Promise<string>;
}

/**
 * Run `fn` while holding the service-transition lock, so work that depends on the service
 * staying up (e.g. loading an STT model before transcribing) cannot be torn down mid-flight by
 * a concurrent restart.
 *
 * `fn` must never call the queued `startService` / `stopService` — that would enqueue behind
 * the lock it already holds and deadlock. Use the passed handle instead.
 */
export async function withServiceTransition<T>(
  fn: (handle: ServiceTransitionHandle) => Promise<T>
): Promise<T> {
  return queueServiceTransition(async () => {
    serviceTransitionDepth += 1;
    const transitionFence = serviceStopFence;
    // The handle is only valid for the duration of the callback. Retaining it and calling
    // startNow() later would run a destructive restart with no lock held.
    let handleActive = true;
    try {
      return await fn({
        startNow(port, alias, preferredEp, bindAddress, opts) {
          if (!handleActive) {
            return Promise.reject(
              new Error('Service transition handle used after its transition completed'),
            );
          }
          return startServiceLocked(port, alias, preferredEp, bindAddress, opts, transitionFence);
        },
      });
    } finally {
      handleActive = false;
      serviceTransitionDepth -= 1;
    }
  });
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

/** The four turn wrappers Foundry substitutes `{Content}` into when building a prompt. */
export interface PromptTemplate {
  system: string;
  user: string;
  assistant: string;
  prompt: string;
}

export interface TemplatePreset { label: string; template: PromptTemplate }

/**
 * Re-exported from the sidecar's Node-free template module so the editor validates with
 * exactly the rules the sidecar enforces — a second copy of these rules would drift.
 */
export {
  validatePromptTemplate,
  selectPromptTemplate,
  TEMPLATE_ROLES,
  TEMPLATE_PRESETS,
} from '../../sidecar/prompt-template.js';

export interface InspectFolderResult {
  ok: boolean;
  reasons: string[];
  warnings: string[];
  detected: {
    architecture: string | null;
    contextLength: number | null;
    hasInferenceModel: boolean;
    templateSource: string;
    templateConfident: boolean;
    promptTemplate: PromptTemplate;
  };
  modelDir: string;
  nested: boolean;
  sizeBytes: number;
  suggestedName: string;
  presets: Record<string, TemplatePreset>;
}

export async function inspectModelFolder(folderPath: string): Promise<InspectFolderResult> {
  const res = await send('inspectModelFolder', { folderPath });
  return res.result as InspectFolderResult;
}

export async function importModelFolder(options: {
  folderPath: string;
  name: string;
  publisher?: string;
  version?: number;
  promptTemplate?: PromptTemplate;
}): Promise<any> {
  const res = await send('importModelFolder', options);
  await refreshModels();
  return res.result;
}

export async function linkModelFolder(options: {
  folderPath: string;
  name: string;
  publisher?: string;
}): Promise<any> {
  const res = await send('linkModelFolder', options);
  await refreshModels();
  return res.result;
}

export interface ModelTemplateResult {
  name: string;
  modelName: string | null;
  promptTemplate: PromptTemplate | null;
  templateSource: string | null;
  presets: Record<string, TemplatePreset>;
  path: string;
}

export async function getModelTemplate(name: string): Promise<ModelTemplateResult> {
  const res = await send('getModelTemplate', { name });
  return res.result as ModelTemplateResult;
}

export async function setModelTemplate(name: string, promptTemplate: PromptTemplate): Promise<any> {
  const res = await send('setModelTemplate', { name, promptTemplate });
  await refreshModels();
  return res.result;
}

export function appendAppLog(message: string, level: LogEntry['level'] = 'info') {
  sdkState.update(s => ({ ...s, logs: [...s.logs.slice(-199), { ts: Date.now(), level, message, source: 'app' as const }] }));
}

export function getManager(): any {
  return null; // No direct manager when using sidecar
}

export function resetSDK() {
  drainPending('connection-lost', 'The runtime was reset before answering.');
  sidecarGeneration += 1;
  if (sidecarProcess) {
    try { sidecarProcess.kill(); } catch {}
  }
  sidecarProcess = null;
  sidecarReady = false;
  managerInstance = null;
  managerReady = false;
  lastInitPayload = null; // a deliberate reset must not auto-re-init on the next send
  currentEndpoint = undefined;
  runtimeQuitRequested = false;
  runtimeQuitPromise = null;
  expectedShutdownGeneration = null;
  closeObservers.clear();
  sdkState.set(initialState);
}

/**
 * Discover available execution providers (accelerators like CPU, CUDA, QNN for NPU, etc.)
 */
export async function getEps(): Promise<EpInfo[]> {
  const res = await send('getEps');
  const eps = res.result || [];
  updateState({ eps, acceleratorsReady: hasRegisteredAccelerator(eps) });
  return eps;
}

export async function ensureAccelerators(
  onProgress?: (epName: string, percent: number) => void,
  onStall?: () => void,
): Promise<AcceleratorReadiness> {
  let generation: number | null = null;
  const res = await sendInternal(
    'ensureAccelerators',
    {},
    undefined,
    (id: number) => {
      registerProgressHandler(
        id,
        onProgress
          ? (percent, detail) => {
              onProgress(String(detail?.ep || 'accelerator'), percent);
            }
          : undefined,
        onStall,
      );
    },
    (dispatchedGeneration) => {
      generation = dispatchedGeneration;
    },
  );
  if (!sidecarProcess || !sidecarReady) {
    throw new Error('Sidecar was lost after accelerator registration');
  }
  const providers = await getEps();
  if (
    generation === null ||
    generation !== sidecarGeneration ||
    !sidecarProcess ||
    !sidecarReady
  ) {
    throw new Error('Sidecar was replaced while confirming accelerator readiness');
  }
  return {
    generation,
    registration: res.result ?? null,
    providers,
  };
}

export function isAcceleratorReadinessCurrent(
  readiness: AcceleratorReadiness,
): boolean {
  return readiness.generation === sidecarGeneration && !!sidecarProcess && sidecarReady;
}

/**
 * Returns context length info for a model if available from the catalog.
 * Falls back to null if unknown.
 */
export function getModelContextInfo(alias: string): ModelContextInfo | null {
  // This is a lightweight helper; the real data lives in sdkState.models
  return null; // caller should use state.models
}

/** Returns catalog models identified as vision-capable by the sidecar metadata filter. */
export async function getVisionModels(): Promise<ModelInfo[]> {
  const res = await send('getVisionModels');
  return (res.result || []).map((m: any) => ({ ...m, isCached: !!m.cached } as ModelInfo));
}

/**
 * Returns models that support Speech-to-Text / automatic speech recognition.
 * Uses the `task` field and capabilities to avoid hardcoding families (Whisper, Nemotron Speech, etc.).
 */
export async function getSTTModels(): Promise<ModelInfo[]> {
  const res = await send('getSTTModels');
  return (res.result || []).map((m: any) => ({ ...m, isCached: !!m.cached } as ModelInfo));
}

/**
 * Get recommended small starter models based on current hardware/EPs and available catalog.
 * Returns up to `count` suitable lightweight models.
 * Prefers models good for the detected acceleration.
 */
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
