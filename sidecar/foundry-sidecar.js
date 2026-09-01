#!/usr/bin/env node
/**
 * Example sidecar wrapper for Foundry Local SDK.
 * Run with: node sidecar/foundry-sidecar.js
 *
 * Communicates over stdio with JSON lines for Tauri shell plugin.
 *
 * In real use:
 * - Bundle this as sidecar binary? (use pkg or vercel/pkg for portable node)
 * - Or better: port to Rust SDK in src-tauri and use invoke.
 *
 * Commands:
 * { "cmd": "init", "appName": "flint" }
 * { "cmd": "listModels" }
 * { "cmd": "download", "alias": "..." }
 * etc.
 */

import readline from 'readline';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { annotateVariantUpdates } from './model-updates.js';
import { assertWavBuffer } from './audio-format.js';
import { createGateway } from './gateway.js';
import { buildModelIndex, resolveModelId } from './model-registry.js';
import {
  detectConfigEncoding,
  decodeConfig,
  encodeConfig,
  getWsl2Setting,
  upsertWsl2Setting,
  parseWslVersionOutput,
  supportsMirrored,
  decodeWslOutput,
} from './wsl-config.js';
import {
  selectEvictions,
  normalizeEvictionConfig,
  normalizePriority,
  describeEviction,
  DEFAULT_EVICTION_CONFIG,
} from './pool-eviction.js';
import {
  validateModelFolder,
  buildInferenceModel,
  validatePromptTemplate,
  sanitizeModelName,
  isInsideRoot,
  TEMPLATE_PRESETS,
  OWNERSHIP_MARKER,
} from './byom-import.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// --- Command allowlist and schema (mirrors src/lib/ipc-contracts.ts) ---
const KNOWN_COMMANDS = new Set([
  'init', 'setLogLevel', 'startService', 'stopService', 'getStatus',
  'listModels', 'download', 'load', 'unload', 'deleteModel', 'getEndpoint',
  'chatCompletion', 'cancelChatRequest', 'transcribeAudio',
  'getEps', 'ensureAccelerators', 'getVisionModels', 'getSTTModels',
  'poolStatus', 'getAccessLog', 'fetchUrl',
  'inspectModelFolder', 'importModelFolder', 'linkModelFolder',
  'getModelTemplate', 'setModelTemplate',
  'setEvictionConfig', 'setModelPriorities',
  'wslStatus', 'wslEnableMirrored', 'wslShutdown',
]);

// Per-command type requirements. Keys are required or optional field names; values are:
// 'number', 'string' (any string), 'non-empty-string', 'array'.
const FIELD_TYPES = {
  init:              { appName: 'non-empty-string', logLevel: 'non-empty-string' },
  setLogLevel:       { level: 'non-empty-string' },
  startService:      { port: 'number', bindAddress: 'string', gateway: 'boolean' },
  download:          { alias: 'non-empty-string', variantId: 'non-empty-string' },
  load:              { alias: 'non-empty-string', variantId: 'non-empty-string' },
  unload:            { alias: 'non-empty-string' },
  deleteModel:       { alias: 'non-empty-string', variantId: 'non-empty-string' },
  chatCompletion:    { model: 'non-empty-string', messages: 'array' },
  cancelChatRequest: { requestId: 'number' },
  transcribeAudio:   { audioBase64: 'string', mimeType: 'non-empty-string', fileName: 'non-empty-string', model: 'non-empty-string', language: 'non-empty-string' },
  fetchUrl:          { url: 'non-empty-string' },
  inspectModelFolder: { folderPath: 'non-empty-string' },
  importModelFolder: { folderPath: 'non-empty-string', name: 'non-empty-string' },
  linkModelFolder:   { folderPath: 'non-empty-string', name: 'non-empty-string' },
  getModelTemplate:  { name: 'non-empty-string' },
  setModelTemplate:  { name: 'non-empty-string' },
  setEvictionConfig: {
    idleUnloadEnabled: 'boolean', idleTimeoutMs: 'number',
    maxResidentEnabled: 'boolean', maxResident: 'number',
  },
  setModelPriorities: { priorities: 'array' },
};

// Commands that accept a lane field; validated to 'chat' | 'audio'.
// Lane is accepted for backwards compatibility but the pool is alias-keyed, not lane-keyed.
const LANE_CMDS = new Set(['load', 'unload']);
const VALID_LANES = new Set(['chat', 'audio']);

// Each entry lists required fields and all allowed optional fields.
// Payloads with unknown fields are rejected to prevent injection attacks.
const COMMAND_SCHEMA = {
  init:               { required: ['appName', 'logLevel'], optional: [] },
  setLogLevel:        { required: ['level'], optional: [] },
  startService:       { required: ['port'], optional: ['alias', 'preferredEp', 'bindAddress', 'gateway'] },
  stopService:        { required: [], optional: [] },
  getStatus:          { required: [], optional: [] },
  listModels:         { required: [], optional: [] },
  download:           { required: ['alias'], optional: ['variantId'] },
  load:               { required: ['alias'], optional: ['lane', 'variantId'] },
  unload:             { required: ['alias'], optional: ['lane'] },
  deleteModel:        { required: ['alias'], optional: ['variantId'] },
  getEndpoint:        { required: [], optional: [] },
  chatCompletion:     { required: ['model', 'messages'], optional: ['maxTokens', 'temperature', 'preferredEp', 'stream'] },
  cancelChatRequest:  { required: ['requestId'], optional: [] },
  transcribeAudio:    { required: ['audioBase64', 'mimeType', 'fileName', 'model', 'language'], optional: ['temperature', 'preferredEp'] },
  getEps:             { required: [], optional: [] },
  ensureAccelerators: { required: [], optional: [] },
  getVisionModels:    { required: [], optional: [] },
  getSTTModels:       { required: [], optional: [] },
  poolStatus:         { required: [], optional: [] },
  getAccessLog:       { required: [], optional: [] },
  fetchUrl:           { required: ['url'], optional: ['maxChars'] },
  inspectModelFolder: { required: ['folderPath'], optional: [] },
  importModelFolder:  { required: ['folderPath', 'name'], optional: ['publisher', 'version', 'promptTemplate'] },
  linkModelFolder:    { required: ['folderPath', 'name'], optional: ['publisher'] },
  getModelTemplate:   { required: ['name'], optional: [] },
  setModelTemplate:   { required: ['name', 'promptTemplate'], optional: [] },
  setEvictionConfig:  { required: [], optional: ['idleUnloadEnabled', 'idleTimeoutMs', 'maxResidentEnabled', 'maxResident'] },
  setModelPriorities: { required: ['priorities'], optional: [] },
  wslStatus:          { required: [], optional: [] },
  wslEnableMirrored:  { required: [], optional: [] },
  wslShutdown:        { required: [], optional: [] },
};

// Base64 character limit for transcribeAudio. 50 MB decoded audio is ~67 MB of base64.
const AUDIO_BASE64_MAX_CHARS = Math.ceil(50 * 1024 * 1024 * 4 / 3);

/**
 * Validates a command name and its payload fields.
 * Returns an error string if invalid, or null if the command is well-formed.
 */
function validateCommand(cmd, payload) {
  if (!KNOWN_COMMANDS.has(cmd)) {
    return `Unknown command: ${cmd}`;
  }
  const schema = COMMAND_SCHEMA[cmd];
  for (const field of schema.required) {
    if (payload[field] === undefined) {
      return `Command "${cmd}" missing required field: ${field}`;
    }
  }
  const knownFields = new Set([...schema.required, ...schema.optional]);
  for (const field of Object.keys(payload)) {
    if (!knownFields.has(field)) {
      return `Command "${cmd}" has unknown field: ${field}`;
    }
  }
  // Type/value validation (required + selected optional fields)
  const typeRules = FIELD_TYPES[cmd];
  if (typeRules) {
    for (const [field, expected] of Object.entries(typeRules)) {
      const value = payload[field];
      if (value === undefined) continue; // already caught by required check above
      if (expected === 'number' && typeof value !== 'number') return `Command "${cmd}" field "${field}" must be a number`;
      if (expected === 'non-empty-string' && (typeof value !== 'string' || !value.trim())) return `Command "${cmd}" field "${field}" must be a non-empty string`;
      if (expected === 'string' && typeof value !== 'string') return `Command "${cmd}" field "${field}" must be a string`;
      if (expected === 'array' && !Array.isArray(value)) return `Command "${cmd}" field "${field}" must be an array`;
      if (expected === 'boolean' && typeof value !== 'boolean') return `Command "${cmd}" field "${field}" must be a boolean`;
    }
  }
  if (payload.preferredEp !== undefined && typeof payload.preferredEp !== 'string') return `Command "${cmd}" field "preferredEp" must be a string`;
  if (cmd === 'startService' && payload.alias !== undefined && (typeof payload.alias !== 'string' || !payload.alias.trim())) return `Command "startService" field "alias" must be a non-empty string`;
  if ((cmd === 'chatCompletion' || cmd === 'transcribeAudio') && payload.temperature !== undefined && typeof payload.temperature !== 'number') return `Command "${cmd}" field "temperature" must be a number`;
  if (cmd === 'chatCompletion') {
    if (payload.stream !== undefined && typeof payload.stream !== 'boolean') return `Command "chatCompletion" field "stream" must be a boolean`;
    if (payload.maxTokens !== undefined && typeof payload.maxTokens !== 'number') return `Command "chatCompletion" field "maxTokens" must be a number`;
  }
  // Lane validation for commands that accept a lane field
  if (LANE_CMDS.has(cmd) && payload.lane !== undefined && !VALID_LANES.has(payload.lane)) {
    return `Command "${cmd}" invalid lane "${payload.lane}": must be "chat" or "audio"`;
  }
  if (cmd === 'transcribeAudio' && payload.audioBase64.length > AUDIO_BASE64_MAX_CHARS) {
    return `Command "transcribeAudio" audioBase64 exceeds maximum allowed size`;
  }
  if (cmd === 'fetchUrl') {
    try { new URL(payload.url); } catch { return `Command "fetchUrl" field "url" must be a valid URL`; }
    if (payload.maxChars !== undefined && typeof payload.maxChars !== 'number') {
      return `Command "fetchUrl" field "maxChars" must be a number`;
    }
  }
  if (cmd === 'importModelFolder' && payload.version !== undefined
      && (!Number.isInteger(payload.version) || payload.version < 1)) {
    return `Command "importModelFolder" field "version" must be a positive integer`;
  }
  if ((cmd === 'importModelFolder' || cmd === 'linkModelFolder')
      && payload.publisher !== undefined
      && (typeof payload.publisher !== 'string' || !payload.publisher.trim())) {
    return `Command "${cmd}" field "publisher" must be a non-empty string`;
  }
  if ((cmd === 'importModelFolder' || cmd === 'setModelTemplate') && payload.promptTemplate !== undefined) {
    if (typeof payload.promptTemplate !== 'object' || payload.promptTemplate === null
        || Array.isArray(payload.promptTemplate)) {
      return `Command "${cmd}" field "promptTemplate" must be an object`;
    }
  }
  return null;
}
// --- end allowlist ---

let manager = null;
let FoundryLocalManager = null;
let initConfig = null; // { appName, logLevel } — kept so startService can re-create manager with webServiceUrls
const canceledRequests = new Set();

// Model pool: Map<alias, { catModel, variantId }>
// variantId is catModel.id (e.g. "Phi-4-mini-instruct-generic-cpu:5") — required for HTTP routing.
// Multiple models coexist; residency is bounded by the eviction rules below, which are off
// by default (spike confirmed co-residency is safe until memory runs out).
const pool = new Map();
let sharedEndpoint = null;

// Usage bookkeeping that drives eviction, kept beside the pool rather than inside it so a
// variant switch (which replaces the pool entry) does not reset a model's history.
/** @type {Map<string, { lastUsedAt: number, inFlight: number }>} */
const usage = new Map();
/** @type {Map<string, 'pinned'|'low'|'normal'>} set by the UI; absent means 'normal'. */
const modelPriorities = new Map();
let evictionConfig = { ...DEFAULT_EVICTION_CONFIG };
let evictionTimer = null;

/** How often the pool is checked. Fine-grained timing does not matter for a minutes-scale idle rule. */
const EVICTION_SWEEP_MS = 30_000;

function usageFor (alias) {
  let entry = usage.get(alias);
  if (!entry) {
    entry = { lastUsedAt: Date.now(), inFlight: 0 };
    usage.set(alias, entry);
  }
  return entry;
}

function touchModel (alias) {
  if (alias) usageFor(alias).lastUsedAt = Date.now();
}

/**
 * Clients name a model however their config happens to spell it — friendly alias, exact
 * variant id, or versionless variant id — but the pool is keyed by alias only. Without
 * this mapping, gateway traffic would never mark the model it is actually using as busy.
 */
function aliasForModelName (name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  if (pool.has(name)) return name;
  for (const [alias, entry] of pool) {
    if (alias.toLowerCase() === wanted) return alias;
    const variantId = String(entry.variantId || '').toLowerCase();
    if (!variantId) continue;
    // Versionless form: "…-generic-cpu" should match "…-generic-cpu:4".
    if (variantId === wanted || variantId.split(':')[0] === wanted) return alias;
  }
  return null;
}

/** Marks a model busy for the life of a request so eviction cannot unload it mid-flight. */
function noteActivity (modelName, phase) {
  // Candidate keys, best first: resident pool alias, catalog alias, the raw requested name.
  // During gateway autoload the model is not resident yet (and the lazy modelIndex may not be
  // built), so the start phase can only book against a fallback key. Resolution is therefore
  // state-dependent — by the end of the request the pool may resolve the same string to a
  // different key — so the end phase must decrement whichever candidate actually holds the
  // in-flight count, not whatever the current pool state resolves to.
  const candidates = [];
  const resident = aliasForModelName(modelName);
  if (resident) candidates.push(resident);
  if (modelIndex) {
    const fromIndex = resolveModelId(modelIndex, modelName)?.alias;
    if (fromIndex && !candidates.includes(fromIndex)) candidates.push(fromIndex);
  }
  const raw = typeof modelName === 'string' ? modelName.trim() : '';
  if (raw && !candidates.includes(raw)) candidates.push(raw);
  if (candidates.length === 0) return;

  let alias = candidates[0];
  if (phase !== 'start') {
    alias = candidates.find(k => (usage.get(k)?.inFlight ?? 0) > 0) ?? alias;
    // Keep the resident model's idle clock accurate even when the count sat on a fallback key.
    if (resident && resident !== alias) touchModel(resident);
  }
  const entry = usageFor(alias);
  entry.lastUsedAt = Date.now();
  if (phase === 'start') {
    entry.inFlight++;
  } else {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    // Bookkeeping for names that never became a resident model must not grow the map without
    // bound (random names spammed at the gateway).
    if (entry.inFlight === 0 && !pool.has(alias)) usage.delete(alias);
  }
}

function poolEntriesForEviction () {
  // An in-flight count can sit under a non-resident key when a request started before its
  // model finished autoloading (see noteActivity). Credit those to the resident alias they
  // resolve to, so a sweep never unloads a model that is mid-request.
  const strayInFlight = new Map();
  for (const [key, use] of usage) {
    if (use.inFlight <= 0 || pool.has(key)) continue;
    const alias = aliasForModelName(key);
    if (alias) strayInFlight.set(alias, (strayInFlight.get(alias) || 0) + use.inFlight);
  }
  return [...pool.keys()].map(alias => {
    const use = usageFor(alias);
    return {
      alias,
      lastUsedAt: use.lastUsedAt,
      inFlight: use.inFlight + (strayInFlight.get(alias) || 0),
      priority: normalizePriority(modelPriorities.get(alias)),
    };
  });
}

async function unloadAlias (alias) {
  const entry = pool.get(alias);
  if (!entry) return false;
  try {
    if (typeof entry.catModel.unload === 'function') await entry.catModel.unload();
  } catch (e) {
    // Report but still drop the entry: a model we cannot unload is not one we can keep
    // accounting for, and retrying forever would spam the log every sweep.
    log('warn', `Unload of ${alias} failed: ${e?.message || e}`);
  }
  pool.delete(alias);
  usage.delete(alias);
  return true;
}

/**
 * @param {object} [options]
 * @param {number} [options.admitting] models about to load, so room is freed before the
 *   memory is spent rather than after
 */
async function runEvictionSweep (options = {}) {
  if (!evictionConfig.idleUnloadEnabled && !evictionConfig.maxResidentEnabled) return [];
  const plan = selectEvictions(poolEntriesForEviction(), evictionConfig, Date.now(), options);
  const done = [];
  for (const item of plan) {
    // Re-check under the current state: sweeps are async, and a request may have arrived
    // for this model since the plan was drawn up.
    const use = usage.get(item.alias);
    if (use && use.inFlight > 0) continue;
    if (await unloadAlias(item.alias)) {
      log('info', describeEviction(item, evictionConfig));
      audit('evict', { alias: item.alias, reason: item.reason });
      done.push(item);
    }
  }
  return done;
}

function restartEvictionTimer () {
  if (evictionTimer) {
    clearInterval(evictionTimer);
    evictionTimer = null;
  }
  if (!evictionConfig.idleUnloadEnabled && !evictionConfig.maxResidentEnabled) return;
  evictionTimer = setInterval(() => {
    runEvictionSweep().catch(e => log('warn', `Eviction sweep failed: ${e?.message || e}`));
  }, EVICTION_SWEEP_MS);
  // A background timer must never be the reason the process refuses to exit.
  evictionTimer.unref?.();
}

// The reverse proxy that fronts the native service so external OpenAI clients can trigger
// a load. Null whenever the service is stopped or the gateway was disabled.
let gateway = null;
let upstreamPort = null;
// Identifier → {alias, variantId} for autoload. Rebuilt lazily and invalidated whenever the
// set of cached models changes, since a stale map would refuse a model the user just added.
let modelIndex = null;

function invalidateModelIndex () {
  modelIndex = null;
}

async function resolveForGateway (requested) {
  if (!modelIndex) {
    if (!manager) return null;
    try {
      const models = await manager.catalog.getModels();
      modelIndex = buildModelIndex(models.map(m => ({
        alias: m.alias,
        variants: (m.variants || []).map(v => {
          let cached = false;
          try { cached = !!v.isCached; } catch { cached = !!v.info?.cached; }
          return { id: v.id, cached };
        }),
      })));
    } catch (e) {
      log('warn', `Gateway could not read the catalog: ${e?.message ?? e}`);
      return null;
    }
  }
  return resolveModelId(modelIndex, requested);
}

/**
 * Close the proxy before the service behind it goes away, so a client gets a connection
 * refused rather than a gateway that accepts requests it can no longer serve.
 */
async function stopGateway () {
  if (!gateway) return;
  const current = gateway;
  gateway = null;
  try {
    await current.stop();
  } catch (e) {
    log('warn', `Gateway stop error (ignored): ${e?.message ?? e}`);
  }
}

/** The native service reports readiness on /status; startWebService() returning does not. */async function waitForUpstream (port, deadlineMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if (res.ok) return true;
      lastError = `status ${res.status}`;
    } catch (e) {
      lastError = e?.message ?? String(e);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  log('warn', `Upstream service not ready after ${deadlineMs}ms: ${lastError}`);
  return false;
}

// Per-request access log. Covers IPC-originated requests only: traffic proxied through the
// gateway is deliberately not logged here because writeToDisk() appends synchronously, and
// putting a blocking write in front of every external request would stall the event loop.
const ACCESS_LOG_MAX = 500;
const accessLog = [];
const tokenAccumulator = new Map(); // alias → { tokensIn: number, tokensOut: number }; reset on stopService
let activeStreamCount = 0;           // incremented on stream start, decremented in finally; handles concurrent streams
let activeStreamOldest = null;       // { type, modelAlias, startedAt } — the longest-running stream for badge display

function appendAccessLog(entry) {
  accessLog.push(entry);
  if (accessLog.length > ACCESS_LOG_MAX) accessLog.shift();
  writeToDisk({ type: 'access', ...entry });
  if (entry.modelAlias && (entry.tokensIn != null || entry.tokensOut != null)) {
    const t = tokenAccumulator.get(entry.modelAlias) ?? { tokensIn: 0, tokensOut: 0 };
    tokenAccumulator.set(entry.modelAlias, {
      tokensIn: t.tokensIn + (entry.tokensIn ?? 0),
      tokensOut: t.tokensOut + (entry.tokensOut ?? 0),
    });
  }
}

// Fallback: parse device type / EP from variant ID when runtime metadata is null.
// Variant IDs follow the pattern: <model>-<ep>-<device>:<version>
// e.g. Phi-4-mini-instruct-generic-cpu:5, Phi-4-mini-instruct-cuda-gpu:5, ...-qnn-npu:1
function parseDeviceFromVariantId(id) {
  if (!id) return null;
  const s = id.toLowerCase();
  if (s.includes('cuda-gpu') || s.includes('-gpu:')) return 'GPU';
  if (s.includes('qnn-npu') || s.includes('-npu:')) return 'NPU';
  if (s.includes('generic-cpu') || s.includes('cpu-int') || s.includes('-cpu:')) return 'CPU';
  return null;
}

function parseEpFromVariantId(id) {
  if (!id) return null;
  const s = id.toLowerCase();
  if (s.includes('cuda')) return 'CUDA';
  if (s.includes('qnn')) return 'QNN';
  if (s.includes('dml')) return 'DML';
  if (s.includes('generic')) return 'generic';
  return null;
}

/**
 * Accelerator memory snapshots for Monitor (GPU VRAM / NPU when available).
 * @typedef {{ kind: 'gpu'|'npu', name: string, vendor?: string|null, totalMb: number|null, usedMb: number|null, freeMb: number|null, source: string }} AccelMem
 */

/** @type {{ ts: number, devices: AccelMem[] } | null} */
let accelMemCache = null;
const ACCEL_MEM_TTL_MS = 4000;

function normalizeAccelDevice(d) {
  if (!d || typeof d !== 'object') return null;
  const kind = d.kind === 'npu' ? 'npu' : 'gpu';
  const name = String(d.name || '').trim();
  if (!name) return null;
  const toNum = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };
  let totalMb = toNum(d.totalMb);
  let usedMb = toNum(d.usedMb);
  let freeMb = toNum(d.freeMb);
  if (freeMb == null && totalMb != null && usedMb != null) {
    freeMb = Math.max(0, totalMb - usedMb);
  }
  return {
    kind,
    name,
    vendor: d.vendor ? String(d.vendor) : null,
    totalMb,
    usedMb,
    freeMb,
    source: String(d.source || 'unknown'),
  };
}

async function queryNvidiaSmi() {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(',').map((s) => s.trim());
        if (parts.length < 4) return null;
        const [name, total, used, free] = parts;
        return normalizeAccelDevice({
          kind: 'gpu',
          name,
          vendor: 'nvidia',
          totalMb: total,
          usedMb: used,
          freeMb: free,
          source: 'nvidia-smi',
        });
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve path to accelerator-memory.ps1 (dev layout or bundled next to sidecar). */
function resolveAcceleratorMemoryScript() {
  const candidates = [
    path.join(__dirname, 'scripts', 'accelerator-memory.ps1'),
    path.join(__dirname, 'accelerator-memory.ps1'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

/** Windows: DXGI dedicated totals + perf-counter usage + PnP NPU presence. */
async function queryWindowsAccelerators() {
  if (process.platform !== 'win32') return [];
  const scriptPath = resolveAcceleratorMemoryScript();
  if (!scriptPath) return [];

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { timeout: 10000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    const raw = stdout.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(normalizeAccelDevice).filter(Boolean);
  } catch {
    return [];
  }
}

/** Linux: AMD ROCm VRAM + DRM sysfs (Intel/AMD). NVIDIA covered by nvidia-smi. */
async function queryLinuxAccelerators() {
  if (process.platform !== 'linux') return [];
  const devices = [];

  // ROCm (AMD discrete / APUs with ROCm tools installed)
  try {
    const { stdout } = await execFileAsync(
      'rocm-smi',
      ['--showmeminfo', 'vram', '--csv'],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    // Typical CSV rows vary by version; also try non-CSV line parse as fallback below.
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/device|gpu|card/i.test(line) && /total|used/i.test(line) && line.includes(',')) {
        // header-ish
        continue;
      }
      const nums = line.match(/(\d+)/g);
      if (!nums || nums.length < 2) continue;
      // Heuristic: last large numbers often total/used in bytes or MB
      const vals = nums.map(Number).filter((n) => Number.isFinite(n));
      if (vals.length < 2) continue;
      // Prefer values that look like bytes (> 1e6) → MB
      let totalMb = null;
      let usedMb = null;
      const asMb = vals.map((n) => (n > 1e6 ? Math.round(n / 1024 / 1024) : n));
      // pick two largest plausible VRAM numbers
      const big = asMb.filter((n) => n >= 256 && n <= 256000).sort((a, b) => b - a);
      if (big.length >= 2) {
        totalMb = Math.max(big[0], big[1]);
        usedMb = Math.min(big[0], big[1]);
        if (usedMb > totalMb) [usedMb, totalMb] = [totalMb, usedMb];
      } else if (big.length === 1) {
        totalMb = big[0];
      }
      if (totalMb != null) {
        devices.push(normalizeAccelDevice({
          kind: 'gpu',
          name: `AMD GPU (ROCm)`,
          vendor: 'amd',
          totalMb,
          usedMb,
          freeMb: usedMb != null ? Math.max(0, totalMb - usedMb) : null,
          source: 'rocm-smi',
        }));
      }
    }
  } catch {
    // try human-readable rocm-smi
    try {
      const { stdout } = await execFileAsync('rocm-smi', ['--showmeminfo', 'vram'], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const totalMatch = stdout.match(/VRAM\s*Total\s*Memory[^0-9]*(\d+)/i)
        || stdout.match(/Total\s*Memory\s*\(B\)\s*:\s*(\d+)/i);
      const usedMatch = stdout.match(/VRAM\s*Total\s*Used\s*Memory[^0-9]*(\d+)/i)
        || stdout.match(/Total\s*Used\s*Memory\s*\(B\)\s*:\s*(\d+)/i);
      if (totalMatch) {
        let totalMb = Number(totalMatch[1]);
        let usedMb = usedMatch ? Number(usedMatch[1]) : null;
        if (totalMb > 1e6) totalMb = Math.round(totalMb / 1024 / 1024);
        if (usedMb != null && usedMb > 1e6) usedMb = Math.round(usedMb / 1024 / 1024);
        devices.push(normalizeAccelDevice({
          kind: 'gpu',
          name: 'AMD GPU (ROCm)',
          vendor: 'amd',
          totalMb,
          usedMb,
          freeMb: usedMb != null ? Math.max(0, totalMb - usedMb) : null,
          source: 'rocm-smi',
        }));
      }
    } catch { /* no ROCm */ }
  }

  // DRM sysfs (works for many AMD/Intel nodes without ROCm)
  try {
    const drmRoot = '/sys/class/drm';
    if (fs.existsSync(drmRoot)) {
      const cards = fs.readdirSync(drmRoot).filter((n) => /^card\d+$/.test(n));
      for (const card of cards) {
        const devDir = path.join(drmRoot, card, 'device');
        const totalPath = path.join(devDir, 'mem_info_vram_total');
        const usedPath = path.join(devDir, 'mem_info_vram_used');
        if (!fs.existsSync(totalPath)) continue;
        const totalB = Number(fs.readFileSync(totalPath, 'utf8').trim());
        if (!Number.isFinite(totalB) || totalB <= 0) continue;
        const totalMb = Math.round(totalB / 1024 / 1024);
        if (totalMb < 64) continue; // skip tiny/shared stubs
        let usedMb = null;
        if (fs.existsSync(usedPath)) {
          const usedB = Number(fs.readFileSync(usedPath, 'utf8').trim());
          if (Number.isFinite(usedB) && usedB >= 0) usedMb = Math.round(usedB / 1024 / 1024);
        }
        let name = card;
        try {
          const uevent = fs.readFileSync(path.join(devDir, 'uevent'), 'utf8');
          const driver = (uevent.match(/DRIVER=(\S+)/) || [])[1];
          if (driver) name = `${card} (${driver})`;
        } catch {}
        devices.push(normalizeAccelDevice({
          kind: 'gpu',
          name,
          vendor: vendorFromName(name),
          totalMb,
          usedMb,
          freeMb: usedMb != null ? Math.max(0, totalMb - usedMb) : null,
          source: 'sysfs-drm',
        }));
      }
    }
  } catch { /* ignore */ }

  return devices.filter(Boolean);
}

function vendorFromName(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('nvidia') || s.includes('geforce') || s.includes('rtx') || s.includes('quadro')) return 'nvidia';
  if (s.includes('amd') || s.includes('radeon')) return 'amd';
  if (s.includes('intel') || s.includes('arc ')) return 'intel';
  if (s.includes('qualcomm') || s.includes('hexagon') || s.includes('npu')) return 'npu-vendor';
  return null;
}

/** Prefer nvidia-smi rows for NVIDIA devices; keep DXGI/other for non-NVIDIA + NPUs. */
function mergeAcceleratorDevices(nvidia, others) {
  const byKey = new Map();
  const keyOf = (d) => `${d.kind}:${d.name.toLowerCase()}`;

  for (const d of others || []) {
    byKey.set(keyOf(d), d);
  }
  for (const d of nvidia || []) {
    // nvidia-smi is authoritative for NVIDIA used/total
    byKey.set(keyOf(d), d);
    // Drop DXGI duplicate if names differ slightly: match by vendor nvidia + similar name
  }

  // If nvidia-smi found devices, remove DXGI nvidia entries that look like duplicates under different keys
  if ((nvidia || []).length > 0) {
    for (const [k, d] of [...byKey.entries()]) {
      if (d.source === 'dxgi' && (d.vendor === 'nvidia' || vendorFromName(d.name) === 'nvidia')) {
        const covered = (nvidia || []).some((n) => {
          const a = n.name.toLowerCase();
          const b = d.name.toLowerCase();
          return a === b || a.includes(b) || b.includes(a);
        });
        if (covered) byKey.delete(k);
      }
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'gpu' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function collectAcceleratorMemory(force = false) {
  const now = Date.now();
  if (!force && accelMemCache && now - accelMemCache.ts < ACCEL_MEM_TTL_MS) {
    return accelMemCache.devices;
  }
  const [nvidia, win, linux] = await Promise.all([
    queryNvidiaSmi(),
    queryWindowsAccelerators(),
    queryLinuxAccelerators(),
  ]);
  // nvidia-smi is authoritative for NVIDIA; Windows DXGI / Linux ROCm+sysfs fill the rest.
  const devices = mergeAcceleratorDevices(nvidia, [...win, ...linux]);
  accelMemCache = { ts: now, devices };
  return devices;
}

// Returns true/false/null. Handles isLoaded as boolean, function, or unknown.
function resolveIsLoaded(model) {
  if (!model) return null;
  if (typeof model.isLoaded === 'boolean') return model.isLoaded;
  if (typeof model.isLoaded === 'function') {
    try { return !!model.isLoaded(); } catch { return null; }
  }
  return null;
}

// --- BYOM (bring your own model) import ---
//
// The native scanner accepts a directory as a model when it holds `genai_config.json`
// plus an `inference_model.json` carrying a `Name`, and no `download.tmp`. Public ONNX
// repositories almost never ship `inference_model.json`, so Flint writes it.
//
// Imports are staged in a sibling directory and moved into place with a single rename,
// so a crash or a failed validation can never leave a half-written model where the
// scanner would try to load it.

/** Cache root for the running appName, e.g. ~/.flint/cache/models. */
function modelCacheRoot() {
  const appName = initConfig?.appName || 'flint';
  return path.join(os.homedir(), `.${appName}`, 'cache', 'models');
}

/** Files worth reading to classify a candidate folder. */
function readJsonIfPresent(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfPresent(dir, name) {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Locate the directory that actually holds genai_config.json.
 *
 * HuggingFace repos commonly nest weights one level down (`onnx/`, `cpu_and_mobile/…`),
 * so accept a shallow search rather than forcing the user to find the right subfolder.
 */
function findModelDir(rootDir, maxDepth = 3) {
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some(e => e.isFile() && e.name.toLowerCase() === 'genai_config.json')) return dir;
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      // Never follow links while searching: a link could point outside the tree.
      if (e.isDirectory() && !e.isSymbolicLink()) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

/** Inspect a candidate folder without writing anything. */
function inspectFolder(folderPath) {
  const resolved = path.resolve(folderPath);
  if (!fs.existsSync(resolved)) throw new Error(`Folder does not exist: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a folder: ${resolved}`);

  const modelDir = findModelDir(resolved);
  const scanDir = modelDir || resolved;
  let names = [];
  try {
    names = fs.readdirSync(scanDir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
  } catch {
    names = [];
  }

  const genaiConfig = readJsonIfPresent(scanDir, 'genai_config.json');
  const chatTemplate =
    readTextIfPresent(scanDir, 'chat_template.jinja') ??
    readJsonIfPresent(scanDir, 'tokenizer_config.json')?.chat_template ??
    null;

  const report = validateModelFolder({
    files: names,
    dirName: path.basename(resolved),
    genaiConfig,
    chatTemplate: typeof chatTemplate === 'string' ? chatTemplate : null,
  });

  let sizeBytes = 0;
  for (const n of names) {
    try { sizeBytes += fs.statSync(path.join(scanDir, n)).size; } catch {}
  }

  return {
    ...report,
    modelDir: scanDir,
    nested: !!modelDir && modelDir !== resolved,
    sizeBytes,
    suggestedName: sanitizeModelName(path.basename(resolved)),
    // Offered so the UI can present alternatives when detection was not confident.
    presets: Object.fromEntries(
      Object.entries(TEMPLATE_PRESETS).map(([k, v]) => [k, { label: v.label, template: v.template }]),
    ),
  };
}

function copyDirContents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    // Only regular files: links are not followed, so an import cannot pull in
    // arbitrary paths from outside the source folder.
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
  }
}

/**
 * Import a model folder into the Flint cache.
 *
 * Staged copy → write metadata → atomic rename → discovery check, with the staging
 * directory removed on any failure so a partial import is never visible.
 */
function importModelFolder(payload) {
  const inspection = inspectFolder(payload.folderPath);
  if (!inspection.ok) {
    throw new Error(`Folder is not an importable ONNX model:\n- ${inspection.reasons.join('\n- ')}`);
  }

  const name = sanitizeModelName(payload.name);
  if (!name) throw new Error('Model name is empty after sanitizing.');
  const version = Number.isInteger(payload.version) && payload.version > 0 ? payload.version : 1;
  const publisher = sanitizeModelName(payload.publisher || 'Imported') || 'Imported';

  const root = modelCacheRoot();
  const finalDir = path.join(root, publisher, `${name}-${version}`);
  const stagingDir = path.join(root, publisher, `.staging-${name}-${version}-${process.pid}`);

  // Both paths are built from sanitized parts, but verify rather than assume.
  if (!isInsideRoot(root, finalDir) || !isInsideRoot(root, stagingDir)) {
    throw new Error('Refusing to write outside the model cache root.');
  }
  if (fs.existsSync(finalDir)) {
    throw new Error(`A model named "${name}" version ${version} already exists. Choose another name or version.`);
  }
  // Importing a folder that already lives in the cache would duplicate gigabytes.
  if (isInsideRoot(root, inspection.modelDir)) {
    throw new Error('That folder is already inside the Flint model cache.');
  }

  const versionDir = path.join(stagingDir, `v${version}`);
  let templateSource = 'existing inference_model.json';
  try {
    copyDirContents(inspection.modelDir, versionDir);

    // Only author inference_model.json when the source did not provide one.
    const infPath = path.join(versionDir, 'inference_model.json');
    if (!fs.existsSync(infPath) || payload.promptTemplate) {
      const built = buildInferenceModel({
        name,
        version,
        chatTemplate: readTextIfPresent(versionDir, 'chat_template.jinja'),
        architecture: inspection.detected.architecture,
        promptTemplate: payload.promptTemplate || null,
      });
      fs.writeFileSync(infPath, `${JSON.stringify(built.content, null, 2)}\n`, 'utf8');
      templateSource = built.templateSource;
    }

    // Ownership marker: proves Flint created this directory and may remove it.
    fs.writeFileSync(
      path.join(stagingDir, OWNERSHIP_MARKER),
      `${JSON.stringify({
        importedBy: 'flint',
        importedAt: new Date().toISOString(),
        sourcePath: inspection.modelDir,
        kind: 'copy',
        name,
        version,
        templateSource,
      }, null, 2)}\n`,
      'utf8',
    );

    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    fs.renameSync(stagingDir, finalDir); // atomic within the same volume
  } catch (e) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw e;
  }

  try { manager?.catalog?.invalidateCache?.(); } catch {}
  return {
    name, version, publisher,
    path: finalDir,
    sizeBytes: inspection.sizeBytes,
    templateSource,
    warnings: inspection.warnings,
  };
}

/**
 * Register a model that lives elsewhere by creating a directory junction.
 *
 * The native scanner traverses junctions, so a foreign model becomes visible without
 * copying gigabytes and without writing a single byte into the foreign directory.
 * Removing the model later deletes the link, never the target.
 */
function linkModelFolder(payload) {
  const inspection = inspectFolder(payload.folderPath);
  if (!inspection.ok) {
    throw new Error(`Folder is not a usable ONNX model:\n- ${inspection.reasons.join('\n- ')}`);
  }
  // A link needs metadata the scanner can read, and the target must not be modified.
  if (!inspection.detected.hasInferenceModel) {
    throw new Error(
      'That folder has no inference_model.json. Linking cannot add one because the ' +
        'source folder is never modified — use Import (copy) instead.',
    );
  }

  const name = sanitizeModelName(payload.name);
  if (!name) throw new Error('Model name is empty after sanitizing.');
  const publisher = sanitizeModelName(payload.publisher || 'Linked') || 'Linked';

  const root = modelCacheRoot();
  const linkPath = path.join(root, publisher, name);
  if (!isInsideRoot(root, linkPath)) throw new Error('Refusing to link outside the model cache root.');
  if (fs.existsSync(linkPath)) throw new Error(`A linked model named "${name}" already exists.`);
  if (isInsideRoot(root, inspection.modelDir)) {
    throw new Error('That folder is already inside the Flint model cache.');
  }

  // Link the parent of the version dir when the source is a Foundry-style layout,
  // so the scanner sees the same shape it expects.
  const target = inspection.modelDir;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'junction');

  try { manager?.catalog?.invalidateCache?.(); } catch {}
  return { name, publisher, linkPath, target, warnings: inspection.warnings };
}

/**
 * Locate an imported model's directory and its inference_model.json.
 *
 * Only directories carrying Flint's ownership marker are eligible: catalog models are
 * managed by Foundry, and a linked model's files belong to the user's own folder, so
 * neither may be rewritten from here.
 */
function resolveOwnedModelDir(name) {
  const safeName = sanitizeModelName(name);
  if (!safeName) throw new Error('Model name is empty after sanitizing.');
  const root = modelCacheRoot();

  let publishers = [];
  try {
    publishers = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    throw new Error('No model cache found yet.');
  }

  for (const publisher of publishers) {
    const publisherDir = path.join(root, publisher);
    let entries = [];
    try {
      entries = fs.readdirSync(publisherDir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      // A junction is a linked model; its contents are the user's, not Flint's.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name !== safeName && !entry.name.startsWith(`${safeName}-`)) continue;

      const dir = path.join(publisherDir, entry.name);
      if (!isInsideRoot(root, dir)) continue;
      if (!fs.existsSync(path.join(dir, OWNERSHIP_MARKER))) continue;

      const versionDir = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^v\d+$/.test(e.name))
        .map(e => path.join(dir, e.name))
        .find(p => fs.existsSync(path.join(p, 'inference_model.json')));
      if (versionDir) return { dir, versionDir, infPath: path.join(versionDir, 'inference_model.json') };
    }
  }
  throw new Error(
    `No Flint-imported model named "${safeName}" was found. Only models imported by Flint can be edited; ` +
      'catalog and linked models are managed elsewhere.',
  );
}

/** Read an imported model's current prompt template. */
function getModelTemplate(name) {
  const { infPath, dir } = resolveOwnedModelDir(name);
  const content = JSON.parse(fs.readFileSync(infPath, 'utf8'));
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(dir, OWNERSHIP_MARKER), 'utf8')); } catch {}
  return {
    name: sanitizeModelName(name),
    modelName: content?.Name ?? null,
    promptTemplate: content?.PromptTemplate ?? null,
    templateSource: marker?.templateSource ?? null,
    presets: Object.fromEntries(Object.entries(TEMPLATE_PRESETS).map(([k, v]) => [k, { label: v.label, template: v.template }])),
    path: infPath,
  };
}

/**
 * Replace an imported model's prompt template.
 *
 * Written to a temporary file and renamed, so an interrupted write cannot leave the
 * model with a truncated inference_model.json — which would make it vanish from the
 * catalog rather than fail visibly.
 */
function setModelTemplate(name, promptTemplate) {
  const check = validatePromptTemplate(promptTemplate);
  if (!check.ok) throw new Error(`Invalid prompt template:\n- ${check.errors.join('\n- ')}`);

  const { dir, infPath } = resolveOwnedModelDir(name);
  const content = JSON.parse(fs.readFileSync(infPath, 'utf8'));
  content.PromptTemplate = { ...check.template };

  const tmp = `${infPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, infPath);

  try {
    const markerPath = path.join(dir, OWNERSHIP_MARKER);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.templateSource = 'user-edited';
    marker.templateEditedAt = new Date().toISOString();
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  } catch {}

  try { manager?.catalog?.invalidateCache?.(); } catch {}
  return { name: sanitizeModelName(name), promptTemplate: content.PromptTemplate, warnings: check.warnings };
}

async function ensureModel(alias, variantId) {  const existing = pool.get(alias);
  if (existing) {
    if (variantId && existing.variantId !== variantId) {
      log('info', `Variant switch for ${alias}: ${existing.variantId} → ${variantId}`);
      await existing.catModel.unload();
      pool.delete(alias);
    } else {
      let loaded = null;
      if (typeof existing.catModel.isLoaded === 'function') {
        try { loaded = await existing.catModel.isLoaded(); } catch {}
      } else if (typeof existing.catModel.isLoaded === 'boolean') {
        loaded = existing.catModel.isLoaded;
      }
      if (loaded === false) {
        await existing.catModel.load();
        log('info', `Model ${alias} reloaded after runtime eviction`);
      }
      touchModel(alias);
      return existing;
    }
  }
  // Free room before committing memory rather than after. Counting this load against the
  // cap is the difference between staying under the limit and briefly exceeding it, which
  // on a tight machine is the moment the allocation fails.
  try {
    await runEvictionSweep({ admitting: 1 });
  } catch (e) {
    log('warn', `Eviction before load failed: ${e?.message || e}`);
  }
  const catModel = await manager.catalog.getModel(alias);
  if (variantId) {
    const variant = await manager.catalog.getModelVariant(variantId);
    const fileSizeMb = variant.info?.fileSizeMb;
    if (fileSizeMb && os.freemem() < fileSizeMb * 1024 * 1024 * 1.15) {
      log('warn', `Low memory: loading ${alias} (${fileSizeMb} MB) but only ${Math.round(os.freemem() / 1024 / 1024)} MB free`);
    }
    catModel.selectVariant(variant);
    await catModel.load();
    pool.set(alias, { catModel, variantId });
    log('info', `Model ${alias} loaded (variantId: ${variantId})`);
  } else {
    const fileSizeMb = catModel.info?.fileSizeMb;
    if (fileSizeMb && os.freemem() < fileSizeMb * 1024 * 1024 * 1.15) {
      log('warn', `Low memory: loading ${alias} (${fileSizeMb} MB) but only ${Math.round(os.freemem() / 1024 / 1024)} MB free`);
    }
    await catModel.load();
    const resolvedVariantId = catModel.id;
    pool.set(alias, { catModel, variantId: resolvedVariantId });
    log('info', `Model ${alias} loaded (variantId: ${resolvedVariantId})`);
  }
  touchModel(alias);
  return pool.get(alias);
}

async function applyPreferredExecutionProvider (preferredEp, model) {
  const value = String(preferredEp || '').trim();
  if (!value || !manager) {
    return { requested: value || null, applied: null, method: null };
  }

  const candidateTargets = [manager, model].filter(Boolean);
  const candidateMethods = [
    'setPreferredExecutionProvider',
    'setPreferredEp',
    'setExecutionProviderPreference',
    'setEpPreference'
  ];

  for (const target of candidateTargets) {
    for (const methodName of candidateMethods) {
      const method = target?.[methodName];
      if (typeof method === 'function') {
        try {
          await method.call(target, value);
          log('info', `Applied preferred execution provider "${value}" via ${methodName}`);
          return { requested: value, applied: value, method: methodName };
        } catch (err) {
          log('warn', `Failed applying preferred EP via ${methodName}: ${err?.message || err}`);
        }
      }
    }
  }

  log('warn', `Preferred execution provider "${value}" is not supported by this runtime API`);
  return { requested: value, applied: null, method: null };
}

async function detectActiveExecutionProvider (model) {
  if (!model) return null;

  const directProps = ['executionProvider', 'activeExecutionProvider', 'currentExecutionProvider', 'provider'];
  for (const prop of directProps) {
    const value = model[prop];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const methodCandidates = ['getExecutionProvider', 'getCurrentExecutionProvider', 'getProvider'];
  for (const methodName of methodCandidates) {
    const method = model?.[methodName];
    if (typeof method !== 'function') continue;
    try {
      const value = await method.call(model);
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    } catch (err) {
      log('warn', `Execution provider probe failed via ${methodName}: ${err?.message || err}`);
    }
  }

  return null;
}

function getOpenAiApiBase (endpoint) {
  const trimmed = String(endpoint || '').replace(/\/+$/, '');
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

async function readErrorBody (resp) {
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const json = await resp.json();
      return JSON.stringify(json);
    } catch {
      // fall back to text
    }
  }
  const text = await resp.text();
  return text || '';
}

function toSdkMessages (messages) {
  // Pass content through as-is to support vision arrays:
  // { role, content: "text" } or { role, content: [ {type:"text", text:...}, {type:"image_url", image_url:{url:...}} ] }
  return (messages || [])
    .filter((m) => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content }));
}

function normalizeText (value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function segmentTextsFromValue (segments) {
  if (!Array.isArray(segments)) return [];
  const values = [];
  for (const segment of segments) {
    const text = normalizeText(segment?.text ?? segment?.transcript ?? '');
    if (!text) continue;
    values.push(text);
  }
  return values;
}

function extractTranscriptCandidate (value) {
  const text = normalizeText(value?.text ?? '');
  const segmentTexts = segmentTextsFromValue(value?.segments);
  const segmentText = normalizeText(segmentTexts.join(' '));
  const combined = text && segmentText
    ? (text.length >= segmentText.length ? text : segmentText)
    : (text || segmentText);
  return {
    text: combined,
    segmentTexts
  };
}

function dedupeAdjacentSegments (segmentTexts) {
  const cleaned = [];
  for (const text of segmentTexts) {
    const normalized = normalizeText(text);
    if (!normalized) continue;
    const last = cleaned[cleaned.length - 1];
    if (last === normalized) continue;
    cleaned.push(normalized);
  }
  return cleaned;
}

function scoreTranscriptCandidate (candidate) {
  const text = normalizeText(candidate?.text ?? '');
  const segmentTexts = dedupeAdjacentSegments(candidate?.segmentTexts || []);
  const charCount = text.length;
  const wordCount = text ? text.split(/\s+/).length : 0;
  const avgWordLen = wordCount ? charCount / wordCount : 0;
  let score = charCount + (wordCount * 4);
  if (segmentTexts.length > 0) score += segmentTexts.length * 2;
  if (wordCount <= 3) score -= 100;
  if (avgWordLen > 12) score -= 40;
  if (avgWordLen < 2 && wordCount > 3) score -= 20;
  return {
    text,
    segmentTexts,
    charCount,
    wordCount,
    score
  };
}

function isLikelyIncompleteTranscript (candidate) {
  const stats = scoreTranscriptCandidate(candidate);
  return stats.wordCount <= 3 || stats.charCount < 24;
}

function pickBetterTranscript (a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;

  const scoreA = scoreTranscriptCandidate(a);
  const scoreB = scoreTranscriptCandidate(b);
  if (scoreB.score > scoreA.score) return b;
  return a;
}

function buildTranscriptResult (candidate, extras = {}) {
  const stats = scoreTranscriptCandidate(candidate || {});
  const base = {
    text: stats.text,
    segments: stats.segmentTexts.map((text) => ({ text }))
  };
  return { ...base, ...extras };
}

// --- Disk log ---
// appendFileSync for crash durability — a buffered stream loses its tail on OOM/kill/segfault,
// which is exactly when the log matters most. Date is computed once at startup; a sidecar
// running past midnight continues to the same file. Fine for MVP.
const LOG_DIR = path.join(os.homedir(), '.flint', 'logs');
let diskLogPath = null;

function initDiskLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/\.(log|jsonl)$/.test(f)) continue;
      try {
        const fp = path.join(LOG_DIR, f);
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
    const today = new Date().toISOString().slice(0, 10);
    diskLogPath = path.join(LOG_DIR, `sidecar-${today}.log`);
  } catch (err) {
    console.error('[sidecar] Failed to initialize disk log:', err?.message || err);
  }
}

function writeToDisk(entry) {
  if (!diskLogPath) return;
  try {
    fs.appendFileSync(diskLogPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Use console.error here — calling log() would recurse.
    console.error('[sidecar] Disk write failed:', err?.message || err);
  }
}

// --- WSL mirrored networking ------------------------------------------------
// WSL2's default NAT mode gives the VM its own loopback, so a client inside
// WSL (OpenClaw etc.) cannot reach Flint on 127.0.0.1. Mirrored networking
// shares the host's interfaces, loopback included, keeping Flint bound to
// 127.0.0.1 and keeping the gateway's loopback-only autoload trust intact for
// WSL callers. These commands power Settings → Network → "WSL clients".

const WSLCONFIG_BACKUP_SUFFIX = '.flint-backup';

function wslConfigPath () {
  return path.join(os.homedir(), '.wslconfig');
}

/** Windows build number from os.release() ("10.0.26100" → 26100), or null when unparsable. */
function windowsBuildNumber () {
  const m = os.release().match(/^\d+\.\d+\.(\d+)/);
  return m ? Number(m[1]) : null;
}

async function getWslStatus () {
  if (process.platform !== 'win32') {
    return {
      platform: process.platform, wslPresent: false, wslVersion: null, windowsBuild: null,
      mirroredSupported: false, networkingMode: null, mirrored: false,
      configPath: null, configExists: false,
    };
  }
  let wslPresent = true;
  let wslVersion = null;
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['--version'], {
      windowsHide: true, encoding: 'buffer', timeout: 15000,
    });
    wslVersion = parseWslVersionOutput(decodeWslOutput(stdout));
  } catch (e) {
    // ENOENT: no WSL at all. Any other failure is the inbox (pre-store)
    // wsl.exe, which doesn't know --version — present, but too old for
    // mirrored networking either way.
    if (e?.code === 'ENOENT') wslPresent = false;
  }
  const configPath = wslConfigPath();
  let configExists = false;
  let networkingMode = null;
  try {
    const buf = fs.readFileSync(configPath);
    configExists = true;
    networkingMode = getWsl2Setting(decodeConfig(buf), 'networkingMode');
  } catch {}
  const windowsBuild = windowsBuildNumber();
  return {
    platform: 'win32',
    wslPresent,
    wslVersion,
    windowsBuild,
    mirroredSupported: wslPresent && supportsMirrored(wslVersion, windowsBuild),
    networkingMode,
    mirrored: /^mirrored$/i.test(networkingMode ?? ''),
    configPath,
    configExists,
  };
}

async function enableWslMirrored () {
  if (process.platform !== 'win32') {
    throw new Error('WSL configuration is only available on Windows.');
  }
  const configPath = wslConfigPath();
  let buf = null;
  try { buf = fs.readFileSync(configPath); } catch {}
  const encoding = buf ? detectConfigEncoding(buf) : 'utf8';
  const text = buf ? decodeConfig(buf) : '';
  if (/^mirrored$/i.test(getWsl2Setting(text, 'networkingMode') ?? '')) {
    return { changed: false, configPath, backupPath: null, restartRequired: false };
  }
  // Keep a one-time backup of the user's original file; a second enable after
  // they reverted must not overwrite the true original.
  let backupPath = null;
  if (buf) {
    backupPath = configPath + WSLCONFIG_BACKUP_SUFFIX;
    if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, buf);
  }
  const updated = upsertWsl2Setting(text, 'networkingMode', 'mirrored');
  fs.writeFileSync(configPath, encodeConfig(updated, encoding));
  return { changed: true, configPath, backupPath, restartRequired: true };
}

function audit(cmd, detail) {
  const entry = { type: 'audit', ts: Date.now(), pid: process.pid, cmd, detail };
  send(entry);
  writeToDisk(entry);
}

function send (msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log (level, message) {
  const entry = { type: 'log', level, message, timestamp: Date.now() };
  send(entry);
  writeToDisk(entry);
}

function coreLibraryFileName () {
  if (process.platform === 'win32') return 'Microsoft.AI.Foundry.Local.Core.dll';
  if (process.platform === 'darwin') return 'Microsoft.AI.Foundry.Local.Core.dylib';
  return 'Microsoft.AI.Foundry.Local.Core.so';
}

/**
 * Resolve the full path to Microsoft.AI.Foundry.Local.Core.* for FoundryLocalManager
 * config.libraryPath (the SDK stores it as FoundryLocalCorePath).
 *
 * Layouts we support:
 * - Dev:            <repo>/node_modules/foundry-local-sdk/foundry-local-core/<plat>/
 * - Flattened prod: <res>/foundry-local-sdk/foundry-local-core/<plat>/
 */
function resolveFoundryCoreLibraryPath () {
  if (process.env.FLINT_FOUNDRY_CORE_PATH && fs.existsSync(process.env.FLINT_FOUNDRY_CORE_PATH)) {
    return process.env.FLINT_FOUNDRY_CORE_PATH;
  }

  const platformKey = `${process.platform}-${process.arch}`;
  const coreFile = coreLibraryFileName();
  const relativeCore = path.join('foundry-local-core', platformKey, coreFile);

  const packageRoots = [];
  const pushRoot = (p) => {
    if (p && !packageRoots.includes(p)) packageRoots.push(p);
  };

  // Prefer roots relative to this script (most reliable in packaged apps)
  const parent = path.resolve(__dirname, '..');
  pushRoot(path.join(parent, 'foundry-local-sdk'));
  pushRoot(path.join(parent, 'node_modules', 'foundry-local-sdk'));
  // cwd may be $RESOURCE (flattened) or repo root (dev)
  pushRoot(path.join(process.cwd(), 'foundry-local-sdk'));
  pushRoot(path.join(process.cwd(), 'node_modules', 'foundry-local-sdk'));

  // NODE_PATH entries (directories that should contain foundry-local-sdk)
  const nodePath = process.env.NODE_PATH || '';
  for (const entry of nodePath.split(path.delimiter).filter(Boolean)) {
    pushRoot(path.join(entry, 'foundry-local-sdk'));
  }

  for (const root of packageRoots) {
    const candidate = path.join(root, relativeCore);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function toFileUrl (filePath) {
  return pathToFileURL(path.resolve(filePath)).href;
}

async function getFoundryManager () {
  if (FoundryLocalManager) return FoundryLocalManager;
  try {
    // Try normal module resolution (works in dev when node_modules is present)
    const mod = await import('foundry-local-sdk');
    FoundryLocalManager = mod.FoundryLocalManager;
    return FoundryLocalManager;
  } catch (err) {
    log('warn', `Normal SDK import failed (${err?.message || err}), trying bundled resource paths`);
  }

  // Packaged layout: sidecar next to foundry-local-sdk; dev uses node_modules
  const parent = path.resolve(__dirname, '..');
  const entryCandidates = [
    path.join(parent, 'foundry-local-sdk', 'dist', 'index.js'),
    path.join(parent, 'node_modules', 'foundry-local-sdk', 'dist', 'index.js'),
    path.join(process.cwd(), 'foundry-local-sdk', 'dist', 'index.js'),
    path.join(process.cwd(), 'node_modules', 'foundry-local-sdk', 'dist', 'index.js'),
  ];

  let lastErr = null;
  for (const sdkEntry of entryCandidates) {
    if (!fs.existsSync(sdkEntry)) continue;
    try {
      log('info', `Loading Foundry SDK from ${sdkEntry}`);
      const mod = await import(toFileUrl(sdkEntry));
      FoundryLocalManager = mod.FoundryLocalManager;
      return FoundryLocalManager;
    } catch (e) {
      lastErr = e;
      log('warn', `Failed loading SDK from ${sdkEntry}: ${e?.message || e}`);
    }
  }
  throw lastErr || new Error(
    'Could not load foundry-local-sdk from packaged resources. ' +
    'Expected foundry-local-sdk next to the sidecar or under node_modules.'
  );
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    log('warn', `IPC rejected: invalid JSON (${line.length} bytes)`);
    send({ id: null, error: 'Invalid JSON' });
    return;
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    log('warn', `IPC rejected: expected JSON object (${line.length} bytes)`);
    send({ id: null, error: 'Invalid message: expected JSON object' });
    return;
  }

  const { id, cmd, ...payload } = msg;

  const reply = (result) => {
    send({ id, ...result });
  };

  const validationError = validateCommand(cmd, payload);
  if (validationError) {
    log('warn', `IPC validation rejected: cmd=${String(cmd).slice(0, 40)} error=${validationError}`);
    reply({ error: validationError });
    return;
  }

  try {
    if (cmd === 'init') {
      const FManager = await getFoundryManager();
      const appName = payload.appName || 'flint';
      const libraryPath = resolveFoundryCoreLibraryPath();
      if (!libraryPath) {
        throw new Error(
          "FoundryLocalCorePath not specified in configuration and could not auto-discover binaries. " +
          "Please run 'npm install' / 'npm run ensure:foundry' so native libraries are present, " +
          "then rebuild the installer (natives must be packaged under foundry-local-sdk/foundry-local-core)."
        );
      }
      log('info', `Using Foundry core library: ${libraryPath}`);
      initConfig = { appName, logLevel: payload.logLevel || 'info', libraryPath };
      manager = FManager.create(initConfig);
      log('info', `SDK initialized for ${appName}`);
      audit('init', { appName, libraryPath });
      reply({ ok: true, result: 'initialized' });
    } else if (cmd === 'listModels') {
      const models = await manager.catalog.getModels();
      reply({
        ok: true, result: models.map(m => {
          // Prefer live isCached getters (query native cache). Catalog snapshot
          // info.cached is often stale after download until a full catalog refresh.
          const variantRows = annotateVariantUpdates((m.variants || []).map(v => {
            let cached = false;
            try {
              cached = !!v.isCached;
            } catch {
              cached = !!v.info?.cached;
            }
            return {
              id: v.id,
              deviceType: v.info?.runtime?.deviceType ?? parseDeviceFromVariantId(v.id),
              executionProvider: v.info?.runtime?.executionProvider ?? parseEpFromVariantId(v.id),
              fileSizeMb: v.info?.fileSizeMb ?? null,
              cached,
              name: v.info?.name ?? null,
              version: v.info?.version ?? null,
            };
          }));
          let modelCached = false;
          try {
            modelCached = !!m.isCached;
          } catch {
            modelCached = !!m.info?.cached;
          }
          // Alias is "downloaded" if any variant is on disk (not only the selected one).
          if (!modelCached) modelCached = variantRows.some(v => v.cached);

          return {
            alias: m.alias,
            cached: modelCached,
            size: m.info?.fileSizeMb,
            task: m.info?.task,
            capabilities: m.info?.capabilities,
            contextLength: m.info?.contextLength ?? m.info?.maxContext ?? null,
            family: m.info?.family || null,
            // Live catalog uses createdAt (unix seconds); older SDK typings said createdAtUnix.
            createdAt: m.info?.createdAt ?? m.info?.createdAtUnix ?? null,
            info: m.info || {},
            variants: variantRows,
            updates: variantRows
              .filter(v => v.update)
              .map(v => ({ sourceVariantId: v.id, ...v.update })),
          };
        })
      });
    } else if (cmd === 'getSTTModels') {
      const all = await manager.catalog.getModels();
      const stt = all.filter(m => {
        const t = (m.info?.task || '').toLowerCase();
        const caps = (m.info?.capabilities || '').toLowerCase();
        return t.includes('automatic-speech-recognition') || t.includes('stt') || caps.includes('automatic-speech-recognition');
      });
      reply({ ok: true, result: stt.map(m => ({ alias: m.alias, cached: m.isCached })) });
    } else if (cmd === 'getVisionModels') {
      const all = await manager.catalog.getModels();
      const vision = all.filter(m => {
        const t = (m.info?.task || '').toLowerCase();
        const caps = (m.info?.capabilities || '').toLowerCase();
        const alias = (m.alias || '').toLowerCase();
        return t.includes('vision') || caps.includes('vision') || caps.includes('image') || alias.includes('vision') || alias.includes('multimodal');
      });
      reply({ ok: true, result: vision.map(m => ({ alias: m.alias, cached: m.isCached })) });
    } else if (cmd === 'download') {
      const model = payload.variantId
        ? await manager.catalog.getModelVariant(payload.variantId)
        : await manager.catalog.getModel(payload.alias);
      audit('download.start', { alias: payload.alias, variantId: payload.variantId ?? null });
      await model.download((p) => send({ id, progress: p, alias: payload.alias }));
      // Force next catalog access to re-read model list metadata (info.cached, etc.).
      try { manager.catalog.invalidateCache?.(); } catch {}
      invalidateModelIndex();
      audit('download.complete', { alias: payload.alias, variantId: payload.variantId ?? null });
      reply({ ok: true });
    } else if (cmd === 'load') {
      const entry = await ensureModel(payload.alias, payload.variantId);
      const acceleration = {
        requested: null,
        active: await detectActiveExecutionProvider(entry.catModel)
      };
      log('info', `Model ${payload.alias} ready (variantId: ${entry.variantId}, accel: ${acceleration.active || 'cpu'})`);
      audit('load', { alias: payload.alias, variantId: entry.variantId, accel: acceleration.active || 'cpu' });
      reply({ ok: true, result: { acceleration, lane: payload.lane || 'chat', variantId: entry.variantId } });
    } else if (cmd === 'unload') {
      const alias = payload.alias;
      const entry = pool.get(alias);
      if (entry) {
        await entry.catModel.unload();
        pool.delete(alias);
        usage.delete(alias);
        log('info', `Model ${alias} unloaded from pool`);
        audit('unload', { alias });
      }
      reply({ ok: true });
    } else if (cmd === 'deleteModel') {
      if (!payload.alias) {
        throw new Error('deleteModel requires alias');
      }
      const variantId = payload.variantId || null;

      const tryRemoveFromCache = (target, label) => {
        if (!target) return false;
        if (typeof target.removeFromCache === 'function') {
          target.removeFromCache();
          log('info', `Removed from cache: ${label}`);
          return true;
        }
        for (const methodName of ['delete', 'remove', 'removeFromDisk', 'purgeCache', 'uninstall']) {
          const method = target?.[methodName];
          if (typeof method === 'function') {
            method.call(target);
            log('info', `Deleted ${label} via ${methodName}`);
            return true;
          }
        }
        return false;
      };

      if (variantId) {
        // Delete a single variant from the local cache.
        const variant = await manager.catalog.getModelVariant(variantId);
        if (!variant) {
          throw new Error(`Variant not found: ${variantId}`);
        }
        const poolEntry = pool.get(payload.alias);
        if (poolEntry?.variantId === variantId) {
          if (typeof poolEntry.catModel.unload === 'function') {
            await poolEntry.catModel.unload();
          }
          pool.delete(payload.alias);
          log('info', `Unloaded pool entry for deleted variant ${variantId}`);
        }
        const ok = tryRemoveFromCache(variant, variantId);
        if (!ok) {
          throw new Error('Runtime does not expose a variant deletion API (removeFromCache)');
        }
        try { manager.catalog.invalidateCache?.(); } catch {}
        invalidateModelIndex();
        audit('deleteModel', { alias: payload.alias, variantId });
        reply({ ok: true, result: { alias: payload.alias, variantId } });
      } else {
        // Delete all cached variants for this alias.
        const model = await manager.catalog.getModel(payload.alias);
        if (!model) {
          throw new Error(`Model not found: ${payload.alias}`);
        }
        const poolEntry = pool.get(payload.alias);
        if (poolEntry && typeof poolEntry.catModel.unload === 'function') {
          await poolEntry.catModel.unload();
          pool.delete(payload.alias);
        }
        let deleted = 0;
        const variants = model.variants || [];
        for (const v of variants) {
          let cached = false;
          try { cached = !!v.isCached; } catch { cached = !!v.info?.cached; }
          if (!cached) continue;
          if (tryRemoveFromCache(v, v.id || payload.alias)) deleted++;
        }
        // Fallback: selected variant / model-level remove
        if (deleted === 0) {
          if (tryRemoveFromCache(model, payload.alias)) deleted++;
        }
        if (deleted === 0) {
          throw new Error('No cached variants found to delete (or runtime lacks removeFromCache)');
        }
        try { manager.catalog.invalidateCache?.(); } catch {}
        log('info', `Deleted ${deleted} cached variant(s) for ${payload.alias}`);
        invalidateModelIndex();
        audit('deleteModel', { alias: payload.alias, variantId: null, count: deleted });
        reply({ ok: true, result: { alias: payload.alias, count: deleted } });
      }
    } else if (cmd === 'inspectModelFolder') {
      reply({ ok: true, result: inspectFolder(payload.folderPath) });
    } else if (cmd === 'importModelFolder') {
      const result = importModelFolder(payload);
      log('info', `Imported model ${result.name}:${result.version} from ${payload.folderPath}`);
      invalidateModelIndex();
      audit('importModelFolder', { alias: result.name, variantId: `${result.name}:${result.version}`, kind: 'copy' });
      reply({ ok: true, result });
    } else if (cmd === 'linkModelFolder') {
      const result = linkModelFolder(payload);
      log('info', `Linked model ${result.name} -> ${result.target}`);
      invalidateModelIndex();
      audit('linkModelFolder', { alias: result.name, variantId: null, kind: 'junction' });
      reply({ ok: true, result });
    } else if (cmd === 'getModelTemplate') {
      reply({ ok: true, result: getModelTemplate(payload.name) });
    } else if (cmd === 'setModelTemplate') {
      const result = setModelTemplate(payload.name, payload.promptTemplate);
      log('info', `Updated prompt template for ${result.name}`);
      audit('setModelTemplate', { alias: result.name, variantId: null });
      reply({ ok: true, result });
    } else if (cmd === 'startService') {
      // The native core is process-global and can only be initialized once: a second
      // FoundryLocalManager.create() throws "Foundry Local Core is already initialized"
      // even after clearing the singleton, so the manager built during init() is the only
      // one this process will ever have. That also means `webServiceUrls` cannot be set
      // here, and startWebService() binds a port of its own choosing.
      //
      // Which is fine, because the port the user configured is served by Flint's gateway,
      // and the gateway simply proxies to whatever port the native service reports back.
      // Discovering the port instead of dictating it also removes the reserve-then-bind
      // race that picking one ourselves would have introduced.
      const bindAddr = payload.bindAddress || '127.0.0.1';
      if (bindAddr !== '127.0.0.1') {
        log('warn', `Service binding to ${bindAddr} — accessible from other network interfaces`);
      }

      const useGateway = payload.gateway !== false;
      await stopGateway();

      pool.clear();
      usage.clear();
      if (manager && typeof manager.stopWebService === 'function') {
        try { manager.stopWebService(); } catch (e) {
          log('warn', `stopWebService before restart (ignored): ${e?.message ?? e}`);
        }
      }
      // Start service BEFORE loading models so HTTP routing layer initializes with the registry.
      if (typeof manager.startWebService === 'function') {
        manager.startWebService(); // synchronous; the port it chose appears in manager.urls
      }

      const nativeUrl = (manager.urls || [])[0];
      if (!nativeUrl) {
        throw new Error('The local service started but did not report an address.');
      }
      const nativePort = Number(new URL(nativeUrl).port);
      upstreamPort = nativePort;
      invalidateModelIndex();

      if (!(await waitForUpstream(nativePort))) {
        // Wind back the half-started service so a retry begins from a clean state rather
        // than tripping over a listener that never became usable.
        try { manager.stopWebService?.(); } catch { /* already failing; nothing to add */ }
        upstreamPort = null;
        throw new Error('The local service did not become ready. Try starting it again.');
      }

      if (useGateway) {
        gateway = createGateway({
          publicPort: payload.port,
          bindAddress: bindAddr,
          upstreamPort: nativePort,
          resolve: resolveForGateway,
          // The loaded variant id is what the replayed request must name: Foundry rejects
          // the friendly alias even once the model is resident.
          load: async (alias, variantId) => (await ensureModel(alias, variantId))?.variantId ?? null,
          // Proxied traffic never reaches this process, so without this hook a model
          // serving a long completion would look idle and could be evicted underneath it.
          onActivity: noteActivity,
          log,
        });
        try {
          await gateway.start();
        } catch (e) {
          gateway = null;
          // The native service is already up at this point. Leaving it running would
          // contradict the error the user is about to see, and would strand a listener on
          // a port nothing advertises, so wind it back before reporting the failure.
          try { manager.stopWebService?.(); } catch { /* already failing; nothing to add */ }
          upstreamPort = null;
          throw new Error(
            `Could not listen on ${bindAddr}:${payload.port} — ${e?.message ?? e}. `
            + 'Another process may already be using that port.'
          );
        }
      }

      // Client-facing endpoint stays on loopback even when the gateway is bound to a wider
      // interface, so this app and the Integrations snippets always target 127.0.0.1.
      sharedEndpoint = useGateway ? `http://127.0.0.1:${payload.port}/v1` : `${nativeUrl}/v1`;
      log('info', `Service started; bind=${bindAddr}:${payload.port} `
        + `${useGateway ? `via gateway → 127.0.0.1:${nativePort} ` : ''}connect=${sharedEndpoint}`);
      audit('startService', {
        port: payload.port, bindAddress: bindAddr, endpoint: sharedEndpoint, gateway: useGateway,
      });
      const desired = payload.alias;
      if (desired) {
        await ensureModel(desired);
      }
      const firstModel = desired ? pool.get(desired)?.catModel : [...pool.values()][0]?.catModel;
      const preferred = await applyPreferredExecutionProvider(payload.preferredEp, firstModel);
      reply({
        ok: true,
        endpoint: sharedEndpoint,
        result: {
          acceleration: {
            requested: preferred?.requested ?? null,
            preferredApplied: preferred?.applied ?? null,
            active: await detectActiveExecutionProvider(firstModel)
          }
        }
      });
    } else if (cmd === 'stopService') {
      await stopGateway();
      if (manager && typeof manager.stopWebService === 'function') {
        try {
          manager.stopWebService(); // synchronous
        } catch (e) {
          log('warn', `stopWebService error (ignored): ${e?.message ?? e}`);
        }
      }
      sharedEndpoint = null;
      upstreamPort = null;
      invalidateModelIndex();
      tokenAccumulator.clear();
      log('info', 'Service stopped');
      audit('stopService', {});
      reply({ ok: true });
    } else if (cmd === 'getEndpoint') {
      reply({ ok: true, endpoint: sharedEndpoint });
    } else if (cmd === 'getStatus') {
      const poolSnapshot = [...pool.entries()].map(([alias, { variantId }]) => ({ alias, variantId }));
      reply({
        ok: true,
        result: {
          initialized: !!manager,
          modelLoaded: pool.size > 0,
          currentModel: poolSnapshot[0]?.alias ?? null,
          endpoint: sharedEndpoint,
          serviceRunning: !!sharedEndpoint,
          pool: poolSnapshot,
          // Legacy lane fields for frontend compatibility
          chatLane: { model: poolSnapshot[0]?.alias ?? null, endpoint: sharedEndpoint || null },
          audioLane: { model: poolSnapshot[1]?.alias ?? null, endpoint: sharedEndpoint || null },
        }
      });
    } else if (cmd === 'chatCompletion') {
      const modelAlias = payload.model;
      const shouldStream = !!payload.stream;
      canceledRequests.delete(id);
      log('debug', `Chat completion: model=${modelAlias} msgs=${payload.messages?.length ?? 0} stream=${shouldStream}`);
      const chatAccessTs = Date.now();
      let chatTokensIn = null, chatTokensOut = null, chatOk = false;
      activeStreamCount++;
      if (!activeStreamOldest) activeStreamOldest = { type: 'chat', modelAlias, startedAt: chatAccessTs };
      noteActivity(modelAlias, 'start');
      try {
        const poolEntry = await ensureModel(modelAlias);
        const chatModel = poolEntry.catModel;
        const apiBase = getOpenAiApiBase(sharedEndpoint);
        const preferred = await applyPreferredExecutionProvider(payload.preferredEp, chatModel);

        const sdkMessages = toSdkMessages(payload.messages);
        if (!sdkMessages.length) {
          throw new Error('No valid messages supplied');
        }

        // Prefer direct SDK inference to avoid web-service schema/version mismatch issues.
        if (typeof chatModel?.createChatClient === 'function') {
          const client = chatModel.createChatClient();
          if (shouldStream && typeof client?.completeStreamingChat === 'function') {
            let content = '';
            for await (const chunk of client.completeStreamingChat(sdkMessages)) {
              if (canceledRequests.has(id)) {
                log('info', `Chat stream canceled for request ${id}`);
                break;
              }
              const deltaText = chunk?.choices?.[0]?.delta?.content;
              const messageText = chunk?.choices?.[0]?.message?.content ?? chunk?.message?.content;
              let delta = '';
              if (typeof deltaText === 'string' && deltaText) {
                delta = deltaText;
              } else if (typeof messageText === 'string' && messageText) {
                // Some runtimes emit cumulative message text instead of token deltas.
                delta = messageText.startsWith(content)
                  ? messageText.slice(content.length)
                  : messageText;
              }
              if (delta) {
                content += delta;
                send({
                  id,
                  stream: true,
                  delta,
                  chunk: {
                    choices: [{ delta: { role: 'assistant', content: delta } }]
                  }
                });
              }
            }
            chatOk = true;
            reply({
              ok: true,
              result: {
                choices: [{ message: { role: 'assistant', content } }],
                acceleration: {
                  requested: preferred?.requested ?? null,
                  preferredApplied: preferred?.applied ?? null,
                  active: await detectActiveExecutionProvider(chatModel)
                }
              }
            });
          } else if (typeof client?.completeChat === 'function') {
            const result = await client.completeChat(sdkMessages);
            chatTokensIn = result?.usage?.prompt_tokens ?? null;
            chatTokensOut = result?.usage?.completion_tokens ?? null;
            if (shouldStream) {
              const content = result?.choices?.[0]?.message?.content || '';
              if (content) {
                send({
                  id,
                  stream: true,
                  delta: content,
                  chunk: {
                    choices: [{ delta: { role: 'assistant', content } }]
                  }
                });
              }
            }
            chatOk = true;
            reply({
              ok: true,
              result: {
                ...result,
                acceleration: {
                  requested: preferred?.requested ?? null,
                  preferredApplied: preferred?.applied ?? null,
                  active: await detectActiveExecutionProvider(chatModel)
                }
              }
            });
          } else if (typeof client?.completeStreamingChat === 'function') {
            let content = '';
            for await (const chunk of client.completeStreamingChat(sdkMessages)) {
              if (canceledRequests.has(id)) {
                log('info', `Chat stream canceled for request ${id}`);
                break;
              }
              const delta = chunk?.choices?.[0]?.delta?.content || '';
              if (delta) content += delta;
            }
            chatOk = true;
            reply({
              ok: true,
              result: {
                choices: [{ message: { role: 'assistant', content } }],
                acceleration: {
                  requested: preferred?.requested ?? null,
                  preferredApplied: preferred?.applied ?? null,
                  active: await detectActiveExecutionProvider(chatModel)
                }
              }
            });
          } else {
            throw new Error('Model chat client does not expose completion methods');
          }
        } else {
          if (!sharedEndpoint) {
            throw new Error('Service endpoint unavailable and direct chat client is unsupported.');
          }
          const resp = await fetch(`${apiBase}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: poolEntry.variantId,
              messages: sdkMessages,
              stream: false,
              max_tokens: payload.maxTokens,
              temperature: payload.temperature
            })
          });
          if (!resp.ok) {
            const details = await readErrorBody(resp);
            throw new Error(`Chat completion failed (${resp.status} ${resp.statusText}): ${details}`);
          }
          const httpResult = await resp.json();
          chatTokensIn = httpResult?.usage?.prompt_tokens ?? null;
          chatTokensOut = httpResult?.usage?.completion_tokens ?? null;
          chatOk = true;
          reply({
            ok: true,
            result: {
              ...httpResult,
              acceleration: {
                requested: preferred?.requested ?? null,
                preferredApplied: preferred?.applied ?? null,
                active: await detectActiveExecutionProvider(chatModel)
              }
            }
          });
        }
      } finally {
        activeStreamCount = Math.max(0, activeStreamCount - 1);
        if (activeStreamCount === 0) activeStreamOldest = null;
        noteActivity(modelAlias, 'end');
        canceledRequests.delete(id);
        appendAccessLog({
          ts: chatAccessTs,
          type: 'chat',
          modelAlias,
          durationMs: Date.now() - chatAccessTs,
          tokensIn: chatTokensIn,
          tokensOut: chatTokensOut,
          source: 'ipc',
          ok: chatOk,
        });
      }
    } else if (cmd === 'cancelChatRequest') {
      const requestId = Number(payload.requestId);
      if (Number.isFinite(requestId)) {
        canceledRequests.add(requestId);
        reply({ ok: true });
      } else {
        throw new Error('cancelChatRequest requires numeric requestId');
      }
    } else if (cmd === 'transcribeAudio') {
      if (!payload.audioBase64) {
        throw new Error('audioBase64 is required');
      }
      // Validate before touching a model: renaming to .wav does not convert, and
      // loading a multi-GB STT model for undecodable bytes wastes minutes before
      // failing with an opaque native decoder error.
      assertWavBuffer(Buffer.from(payload.audioBase64, 'base64'), payload.fileName);
      const fileExt = (payload.fileName?.split('.').pop() ?? 'unknown').toLowerCase();
      log('debug', `Transcription: model=${payload.model} ext=.${fileExt} lang=${payload.language || 'auto'}`);

      const requestedAlias = payload.model;
      if (requestedAlias) {
        await ensureModel(requestedAlias);
      }
      const audioPoolEntry = pool.get(requestedAlias);
      const audioModel = audioPoolEntry?.catModel;
      const preferred = await applyPreferredExecutionProvider(payload.preferredEp, audioModel);

      if (!audioModel) {
        throw new Error('No STT model loaded. Select an STT model on the Audio page first.');
      }

      const bytes = Buffer.from(payload.audioBase64, 'base64');
      // Force .wav extension — the models use a strict AudioDecoder that often
      // cannot detect WebM/Opus/MP3 etc. We normalize on the client too.
      let baseName = (payload.fileName || 'audio').replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!/\.wav$/i.test(baseName)) baseName += '.wav';
      const tempFileName = `flint-audio-${Date.now()}-${baseName}`;
      const tempPath = path.join(os.tmpdir(), tempFileName);
      await fs.promises.writeFile(tempPath, bytes);

      const audioAccessTs = Date.now();
      let audioOk = false;
      activeStreamCount++;
      if (!activeStreamOldest) activeStreamOldest = { type: 'audio', modelAlias: requestedAlias, startedAt: audioAccessTs };
      noteActivity(requestedAlias, 'start');
      try {
        // Prefer direct AudioClient (like we do for chat) — this avoids relying on the web service HTTP route
        // which may return 404 for /audio/transcriptions even for Whisper models.
        if (typeof audioModel.createAudioClient === 'function') {
          const audioClient = audioModel.createAudioClient();
          if (payload.language && payload.language !== 'auto') {
            audioClient.settings.language = payload.language;
          }
          if (typeof payload.temperature === 'number') {
            audioClient.settings.temperature = payload.temperature;
          }

          const debugEnabled = process.env.FLINT_TRANSCRIBE_DEBUG === '1';
          let streamingCandidate = null;
          let streamingError = null;
          let streamingChunkCount = 0;

          try {
            const chunkCandidates = [];
            let aggregatedSegments = [];
            for await (const chunk of audioClient.transcribeStreaming(tempPath)) {
              streamingChunkCount += 1;
              const candidate = extractTranscriptCandidate(chunk);
              if (candidate.text || candidate.segmentTexts.length) {
                chunkCandidates.push(candidate);
              }
              if (candidate.segmentTexts.length > 0) {
                aggregatedSegments = dedupeAdjacentSegments(aggregatedSegments.concat(candidate.segmentTexts));
              }

              if (debugEnabled && streamingChunkCount <= 8) {
                log('debug', `[transcribe] stream chunk ${streamingChunkCount} text=${candidate.text.length} chars segments=${candidate.segmentTexts.length}`);
              }
            }
            const segmentAggregateCandidate = {
              text: normalizeText(aggregatedSegments.join(' ')),
              segmentTexts: aggregatedSegments
            };
            let bestStream = segmentAggregateCandidate;
            for (const candidate of chunkCandidates) {
              bestStream = pickBetterTranscript(bestStream, candidate);
            }
            streamingCandidate = bestStream;
          } catch (streamErr) {
            streamingError = streamErr;
            console.error('[sidecar] streaming transcribe failed, evaluating sync fallback:', streamErr);
          }

          let syncCandidate = null;
          const needsSyncFallback = !streamingCandidate || isLikelyIncompleteTranscript(streamingCandidate);
          if (needsSyncFallback) {
            const syncResult = await audioClient.transcribe(tempPath);
            syncCandidate = extractTranscriptCandidate(syncResult);
          }

          let chosen = pickBetterTranscript(streamingCandidate, syncCandidate);
          let transcriptPath = 'streaming';
          if (chosen === syncCandidate && syncCandidate) transcriptPath = 'sync';
          if (streamingCandidate && syncCandidate) transcriptPath = 'hybrid';

          if (!chosen || !normalizeText(chosen.text)) {
            if (streamingError) throw streamingError;
            throw new Error('Transcription produced an empty result');
          }

          const result = buildTranscriptResult(chosen, {
            transcriptionPath: transcriptPath,
            diagnostics: {
              streamingChunks: streamingChunkCount,
              fallbackSyncUsed: needsSyncFallback
            }
          });

          audioOk = true;
          reply({
            ok: true,
            result: {
              ...result,
              acceleration: {
                requested: preferred?.requested ?? null,
                preferredApplied: preferred?.applied ?? null,
                active: await detectActiveExecutionProvider(audioModel)
              }
            }
          });
          return;
        }

        // Fallback to OpenAI-compatible HTTP if direct client not available for this model
        if (!sharedEndpoint) {
          throw new Error('Service endpoint unavailable and model has no direct audio client.');
        }
        const apiBase = getOpenAiApiBase(sharedEndpoint);
        const blob = new Blob([bytes], { type: payload.mimeType || 'application/octet-stream' });
        const form = new FormData();
        form.append('file', blob, payload.fileName || 'audio.webm');
        form.append('model', audioPoolEntry?.variantId || payload.model);
        if (payload.language && payload.language !== 'auto') {
          form.append('language', payload.language);
        }
        const resp = await fetch(`${apiBase}/audio/transcriptions`, {
          method: 'POST',
          body: form
        });
        if (!resp.ok) {
          const details = await readErrorBody(resp);
          throw new Error(`Transcription failed (${resp.status} ${resp.statusText}): ${details}`);
        }
        const transcriptionResult = await resp.json();
        audioOk = true;
        reply({
          ok: true,
          result: {
            ...transcriptionResult,
            acceleration: {
              requested: preferred?.requested ?? null,
              preferredApplied: preferred?.applied ?? null,
              active: await detectActiveExecutionProvider(audioModel)
            }
          }
        });
      } finally {
        activeStreamCount = Math.max(0, activeStreamCount - 1);
        if (activeStreamCount === 0) activeStreamOldest = null;
        noteActivity(requestedAlias, 'end');
        try { fs.unlinkSync(tempPath); } catch {}
        appendAccessLog({
          ts: audioAccessTs,
          type: 'audio',
          modelAlias: requestedAlias,
          durationMs: Date.now() - audioAccessTs,
          tokensIn: null,
          tokensOut: null,
          source: 'ipc',
          ok: audioOk,
        });
      }
    } else if (cmd === 'poolStatus') {
      let loadedIds = new Set();
      try {
        const loaded = await manager.catalog.getLoadedModels();
        for (const m of loaded) loadedIds.add(m.id);
      } catch {}
      const entries = [...pool.entries()].map(([alias, { variantId }]) => {
        const use = usageFor(alias);
        return {
          alias,
          variantId,
          isLoaded: loadedIds.size > 0 ? loadedIds.has(variantId) : null,
          lastUsedAt: use.lastUsedAt,
          inFlight: use.inFlight,
          priority: normalizePriority(modelPriorities.get(alias)),
        };
      });
      const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
      const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
      let accelerators = [];
      try {
        accelerators = await collectAcceleratorMemory();
      } catch (e) {
        log('warn', `Accelerator memory probe failed: ${e?.message || e}`);
        accelerators = accelMemCache?.devices ?? [];
      }
      reply({
        ok: true,
        result: {
          models: entries,
          endpoint: sharedEndpoint,
          // usedMemMb = system-wide used RAM; models load in Foundry's process, not sidecar's RSS
          usedMemMb: totalMemMb - freeMemMb,
          totalMemMb,
          freeMemMb,
          // Native host facts (more reliable than browser UA for Apple Silicon vs Intel Mac)
          host: {
            platform: process.platform, // darwin | win32 | linux
            arch: process.arch,         // arm64 | x64 | ...
          },
          accelerators,
          eviction: { ...evictionConfig },
          tokenTotals: [...tokenAccumulator.entries()].map(([alias, t]) => ({ alias, ...t })),
          streaming: activeStreamCount > 0 && activeStreamOldest ? {
            active: true,
            type: activeStreamOldest.type,
            modelAlias: activeStreamOldest.modelAlias,
            elapsedMs: Date.now() - activeStreamOldest.startedAt,
            count: activeStreamCount,
          } : { active: false, type: null, modelAlias: null, elapsedMs: null, count: 0 },
        }
      });
    } else if (cmd === 'setEvictionConfig') {
      evictionConfig = normalizeEvictionConfig({ ...evictionConfig, ...payload });
      restartEvictionTimer();
      // Apply immediately: a user who has just lowered the cap expects the pool to shrink
      // now, not at some point in the next half minute.
      const evicted = await runEvictionSweep();
      log('info', `Eviction config: idle=${evictionConfig.idleUnloadEnabled ? `${Math.round(evictionConfig.idleTimeoutMs / 60_000)}min` : 'off'} `
        + `cap=${evictionConfig.maxResidentEnabled ? evictionConfig.maxResident : 'off'}`);
      reply({ ok: true, result: { config: { ...evictionConfig }, evicted } });
    } else if (cmd === 'setModelPriorities') {
      if (!Array.isArray(payload.priorities)) {
        throw new Error('setModelPriorities requires a priorities array');
      }
      modelPriorities.clear();
      for (const item of payload.priorities) {
        const alias = typeof item?.alias === 'string' ? item.alias.trim() : '';
        if (!alias) continue;
        const priority = normalizePriority(item?.priority);
        // 'normal' is the default, so storing it would only grow the map forever.
        if (priority !== 'normal') modelPriorities.set(alias, priority);
      }
      // A model that just became evictable should not wait for the next sweep.
      const evicted = await runEvictionSweep();
      reply({
        ok: true,
        result: {
          priorities: [...modelPriorities.entries()].map(([alias, priority]) => ({ alias, priority })),
          evicted,
        },
      });
    } else if (cmd === 'getAccessLog') {
      reply({ ok: true, result: accessLog });
    } else if (cmd === 'fetchUrl') {
      const fetchTs = Date.now();
      let fetchOk = false;
      const rawUrl = String(payload.url).trim();
      const maxChars = typeof payload.maxChars === 'number' ? payload.maxChars : 50000;

      // SSRF / protocol guard — reject anything that isn't https/http, and block
      // private/loopback ranges so the sidecar can't be used as a proxy to reach
      // local services (LAN hosts, the Foundry endpoint itself, etc.).
      let parsedUrl;
      try {
        parsedUrl = new URL(rawUrl);
      } catch {
        reply({ error: `fetchUrl: invalid URL` });
        return;
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        reply({ error: `fetchUrl: only http/https URLs are supported` });
        return;
      }
      const hostname = parsedUrl.hostname.toLowerCase();
      const privateRanges = [
        /^localhost$/,
        /^127\./,
        /^10\./,
        /^172\.(1[6-9]|2[0-9]|3[01])\./,
        /^192\.168\./,
        /^169\.254\./,     // link-local
        /^::1$/,           // IPv6 loopback
        /^fc00:/,          // IPv6 ULA
        /^fe80:/,          // IPv6 link-local
        /^0\.0\.0\.0$/,
      ];
      if (privateRanges.some((re) => re.test(hostname))) {
        reply({ error: `fetchUrl: private/loopback addresses are not allowed` });
        return;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        let resp;
        try {
          resp = await fetch(rawUrl, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Flint/0.3 (local-AI-client; +https://github.com/joelst/flint)' },
            redirect: 'follow',
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        const contentType = resp.headers.get('content-type') || '';
        // Cap raw download at 2 MB to avoid OOM on large pages
        const RAW_LIMIT = 2 * 1024 * 1024;
        const rawText = await resp.text();
        const capped = rawText.length > RAW_LIMIT ? rawText.slice(0, RAW_LIMIT) : rawText;

        let title = '';
        let extractedText = '';

        if (contentType.includes('text/html')) {
          // Dynamically import jsdom + readability (both ship in node_modules)
          const { JSDOM } = await import('jsdom');
          const { Readability } = await import('@mozilla/readability');
          const dom = new JSDOM(capped, { url: rawUrl });
          // Extract <title> as fallback
          title = dom.window.document.title?.trim() || '';
          const reader = new Readability(dom.window.document, { charThreshold: 50 });
          const article = reader.parse();
          if (article) {
            title = article.title?.trim() || title;
            extractedText = article.textContent?.replace(/\s+/g, ' ').trim() || '';
          } else {
            // Readability couldn't parse it; strip tags as a rough fallback
            extractedText = dom.window.document.body?.textContent?.replace(/\s+/g, ' ').trim() || '';
          }
        } else {
          // Plain text, JSON, markdown, etc. — use as-is (already text/utf-8 from resp.text())
          extractedText = capped.replace(/\s+/g, ' ').trim();
        }

        const truncated = extractedText.length > maxChars;
        const finalText = truncated ? extractedText.slice(0, maxChars) : extractedText;

        fetchOk = true;
        appendAccessLog({
          ts: fetchTs,
          type: 'fetchUrl',
          modelAlias: null,
          durationMs: Date.now() - fetchTs,
          tokensIn: null,
          tokensOut: null,
          source: 'ipc',
          ok: true,
          url: parsedUrl.hostname, // host only, not full URL (privacy)
        });
        log('info', `fetchUrl: fetched ${parsedUrl.hostname} (${finalText.length} chars, truncated=${truncated})`);
        reply({
          ok: true,
          result: {
            url: rawUrl,
            title,
            text: finalText,
            truncated,
            charCount: finalText.length,
          }
        });
      } catch (err) {
        appendAccessLog({
          ts: fetchTs,
          type: 'fetchUrl',
          modelAlias: null,
          durationMs: Date.now() - fetchTs,
          tokensIn: null,
          tokensOut: null,
          source: 'ipc',
          ok: false,
          url: parsedUrl?.hostname || rawUrl,
        });
        throw err;
      }
    } else if (cmd === 'getEps') {
      const eps = typeof manager.discoverEps === 'function' ? manager.discoverEps() : [];
      reply({ ok: true, result: eps });
    } else if (cmd === 'ensureAccelerators') {
      if (typeof manager.downloadAndRegisterEps === 'function') {
        await manager.downloadAndRegisterEps((name, pct) => {
          send({ id, progress: pct, ep: name });
        });
      }
      reply({ ok: true });
    } else if (cmd === 'setLogLevel') {
      // Enable logging at requested level (SDK supports via config or we just log here)
      log('info', `Log level set to ${payload.level}`);
      audit('setLogLevel', { level: payload.level });
      reply({ ok: true });
    } else if (cmd === 'wslStatus') {
      reply({ ok: true, result: await getWslStatus() });
    } else if (cmd === 'wslEnableMirrored') {
      const result = await enableWslMirrored();
      log('info', result.changed
        ? `WSL mirrored networking written to ${result.configPath} (backup: ${result.backupPath ?? 'none needed'})`
        : 'WSL mirrored networking already enabled — no changes made');
      audit('wsl.enableMirrored', { changed: result.changed, backupPath: result.backupPath });
      reply({ ok: true, result });
    } else if (cmd === 'wslShutdown') {
      if (process.platform !== 'win32') throw new Error('WSL is only available on Windows.');
      await execFileAsync('wsl.exe', ['--shutdown'], { windowsHide: true, timeout: 30000 });
      log('info', 'WSL shut down; it restarts automatically on next use');
      audit('wsl.shutdown', {});
      reply({ ok: true, result: { ok: true } });
    } else {
      reply({ error: `Unknown command: ${cmd}` });
    }
  } catch (e) {
    reply({ error: e.message || String(e) });
  }
});

// initDiskLog opens today's log file and prunes files older than 7 days.
initDiskLog();

// Send ready as early as possible (after readline setup) so the host does not time out.
// We lazy-load the heavy Foundry SDK only on first 'init' command.
const readyMsg = { ready: true, pid: process.pid, version: '0.1.0' };
send(readyMsg);
log('info', `Sidecar process started (pid ${process.pid}) and listening`);

// Also write to stderr for better visibility in dev mode
console.error(`[foundry-sidecar] Ready: ${JSON.stringify(readyMsg)}`);