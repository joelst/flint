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
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

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
]);

// Per-command type requirements. Keys are required or optional field names; values are:
// 'number', 'string' (any string), 'non-empty-string', 'array'.
const FIELD_TYPES = {
  init:              { appName: 'non-empty-string', logLevel: 'non-empty-string' },
  setLogLevel:       { level: 'non-empty-string' },
  startService:      { port: 'number', bindAddress: 'string' },
  download:          { alias: 'non-empty-string', variantId: 'non-empty-string' },
  load:              { alias: 'non-empty-string', variantId: 'non-empty-string' },
  unload:            { alias: 'non-empty-string' },
  deleteModel:       { alias: 'non-empty-string', variantId: 'non-empty-string' },
  chatCompletion:    { model: 'non-empty-string', messages: 'array' },
  cancelChatRequest: { requestId: 'number' },
  transcribeAudio:   { audioBase64: 'string', mimeType: 'non-empty-string', fileName: 'non-empty-string', model: 'non-empty-string', language: 'non-empty-string' },
  fetchUrl:          { url: 'non-empty-string' },
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
  startService:       { required: ['port'], optional: ['alias', 'preferredEp', 'bindAddress'] },
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
  return null;
}
// --- end allowlist ---

let manager = null;
let FoundryLocalManager = null;
let initConfig = null; // { appName, logLevel } — kept so startService can re-create manager with webServiceUrls
const canceledRequests = new Set();

// Model pool: Map<alias, { catModel, variantId }>
// variantId is catModel.id (e.g. "Phi-4-mini-instruct-generic-cpu:5") — required for HTTP routing.
// Multiple models coexist; no LRU eviction policy for MVP (spike confirmed co-residency).
const pool = new Map();
let sharedEndpoint = null;

// Per-request access log (IPC-originated requests only; direct HTTP to the Foundry Local
// service is not intercepted — that requires a proxy layer, deferred to 0.3 item 0b).
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

async function ensureModel(alias, variantId) {
  const existing = pool.get(alias);
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
      return existing;
    }
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

async function getFoundryManager () {
  if (FoundryLocalManager) return FoundryLocalManager;
  try {
    // Try normal module resolution (works in dev when node_modules is present)
    const mod = await import('foundry-local-sdk');
    FoundryLocalManager = mod.FoundryLocalManager;
    return FoundryLocalManager;
  } catch (err) {
    log('warn', `Normal SDK import failed (${err?.message || err}), trying bundled resource path`);
    // In prod bundle: we ship ../node_modules/foundry-local-sdk via tauri resources
    // sidecar is at <res>/sidecar/..., SDK at <res>/foundry-local-sdk/dist/index.js
    const base = path.resolve(__dirname, '..');
    const sdkEntry = path.join(base, 'foundry-local-sdk', 'dist', 'index.js').replace(/\\/g, '/');
    const fileUrl = 'file:///' + (sdkEntry.startsWith('/') ? sdkEntry.slice(1) : sdkEntry);
    const mod = await import(fileUrl);
    FoundryLocalManager = mod.FoundryLocalManager;
    return FoundryLocalManager;
  }
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
      initConfig = { appName, logLevel: payload.logLevel || 'info' };
      manager = FManager.create(initConfig);
      log('info', `SDK initialized for ${appName}`);
      audit('init', { appName });
      reply({ ok: true, result: 'initialized' });
    } else if (cmd === 'listModels') {
      const models = await manager.catalog.getModels();
      reply({
        ok: true, result: models.map(m => {
          // Prefer live isCached getters (query native cache). Catalog snapshot
          // info.cached is often stale after download until a full catalog refresh.
          const variantRows = (m.variants || []).map(v => {
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
            };
          });
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
        audit('deleteModel', { alias: payload.alias, variantId: null, count: deleted });
        reply({ ok: true, result: { alias: payload.alias, count: deleted } });
      }
    } else if (cmd === 'startService') {
      // Re-create the manager with webServiceUrls so startWebService() binds to the requested port.
      // The manager from init() lacks webServiceUrls and would bind to whatever the SDK default is.
      // Pool is cleared because catModel references from the old manager instance become stale.
      // bindAddress controls the bind interface; sharedEndpoint always uses 127.0.0.1 for connecting.
      const bindAddr = payload.bindAddress || '127.0.0.1';
      if (bindAddr !== '127.0.0.1') {
        log('warn', `Service binding to ${bindAddr} — accessible from other network interfaces`);
      }
      if (FoundryLocalManager && initConfig) {
        pool.clear();
        manager = FoundryLocalManager.create({
          ...initConfig,
          webServiceUrls: `http://${bindAddr}:${payload.port}`,
        });
      }
      // Start service BEFORE loading models so HTTP routing layer initializes with the registry.
      if (typeof manager.startWebService === 'function') {
        manager.startWebService(); // synchronous, no args; port comes from webServiceUrls above
      }
      sharedEndpoint = `http://127.0.0.1:${payload.port}/v1`;
      log('info', `Service started; bind=${bindAddr}:${payload.port} connect=${sharedEndpoint}`);
      audit('startService', { port: payload.port, bindAddress: bindAddr, endpoint: sharedEndpoint });
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
      if (manager && typeof manager.stopWebService === 'function') {
        try {
          manager.stopWebService(); // synchronous
        } catch (e) {
          log('warn', `stopWebService error (ignored): ${e?.message ?? e}`);
        }
      }
      sharedEndpoint = null;
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
      const entries = [...pool.entries()].map(([alias, { catModel, variantId }]) => ({
        alias,
        variantId,
        isLoaded: loadedIds.size > 0 ? loadedIds.has(variantId) : null,
      }));
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