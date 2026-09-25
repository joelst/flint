/**
 * Sidecar JSON-lines command loop.
 *
 * Loaded by foundry-sidecar.js after stdout protection is installed. Do not
 * run this file as the process entry — static imports here evaluate before
 * any guard in this module body.
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
import { selectChatTransport } from './chat-transport.js';
import { assertWavBuffer } from './audio-format.js';
import { createGateway } from './gateway.js';
import { formatPublicEndpoint } from './gateway-http.js';
import {
  buildCachedModelIndex,
  buildModelIndex,
  isCachedModel,
  isLocalCatalogEntry,
  resolveModelId,
} from './model-registry.js';
import { activityCandidateKeys } from './activity-booking.js';
import { audioSessionUriSupport, looksLikeSpeech } from './model-classification.js';
import { waitUntilIdle } from './monotonic-wait.js';
import {
  createOperationAdmission,
  createServiceTransitionLock,
  stopPartiallyStartedService,
} from './service-lifecycle.js';
import { createModelActivityFence } from './model-activity-fence.js';
import {
  applyPreferredExecutionProvider as applyPreferredExecutionProviderTo,
} from './execution-provider.js';
import { rebuildBrokenExecutionProviders, removeProviderCache } from './execution-provider-cache.js';
import {
  createCatalogRegistrationGate,
  registerDiscoveredExecutionProviders,
} from './accelerator-registration.js';
import {
  stopNativeWebService as stopNativeWebServiceFor,
  waitForHttpReady,
} from './native-service.js';
import {
  DEFAULT_FETCH_BODY_LIMIT,
  fetchBoundedResponseText,
  readBoundedErrorBody,
} from './fetch-response.js';
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
import { createAsyncLogWriter } from './async-log-writer.js';
import { normalizeChatResponse } from './chat-response.js';
import { buildInferenceMetrics } from './inference-metrics.js';
import { summarizeCacheInventory } from './cache-inventory.js';
import { createHealthRing } from './health-ring.js';
import { foundryRuntimePinWarning } from './foundry-runtime-pin.js';
import { writeProtocolLine } from './protocol-stdout.js';
import { createModelOperationQueue } from './model-operation-queue.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const SIDECAR_PROTOCOL_VERSION = 1;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const operationAdmission = createOperationAdmission();
const modelOperationQueue = createModelOperationQueue();
/** Gateway-only exclusive lease for a measured benchmark. IPC chat/load still run (the
 * Preview uses those). Pinning does not stop a gateway autoload from switching variants. */
let benchmarkExclusive = false;
// Overridable only for integration tests, which need a drain deadline far shorter than 10s to
// exercise the "could not drain in time" path without a correspondingly slow test. Must stay
// finite: an unbounded value (e.g. "Infinity") would let a stuck gateway request block the
// endpoint forever instead of failing after the intended drain deadline.
const parsedBenchmarkExclusiveDrainMs = Number(process.env.FLINT_BENCHMARK_EXCLUSIVE_DRAIN_MS);
const BENCHMARK_EXCLUSIVE_DRAIN_MS = Number.isFinite(parsedBenchmarkExclusiveDrainMs) && parsedBenchmarkExclusiveDrainMs > 0
  ? parsedBenchmarkExclusiveDrainMs
  : 10_000;

// Commands that either run real inference against the shared pool, or mutate/populate what the
// pool holds. Draining only `gatewayRequest` missed IPC `chatCompletion` (and the other inference
// commands) entirely, and inference-only draining still missed `load`/`unload`/`deleteModel`/
// `startService`: this sidecar process -- and any operation it already admitted -- survives a
// frontend reload, so an old page's still-running command from a *previous*, now-gone benchmark
// (or Models/Monitor) session is invisible to the new page's own busy-state checks (those only
// see this page's in-memory state). Without this, exclusive admission could be granted while:
//   - an orphaned `chatCompletion`/`transcribeAudio`/`embedTexts` is still generating tokens
//     against the same models the new run is about to benchmark, corrupting its latency numbers;
//   - an orphaned `load`/`unload`/`deleteModel` is still mutating pool residency, so the new run
//     could measure against a model that is still being unloaded, or race a stale load that
//     hasn't finished consuming its resources yet;
//   - an orphaned `startService` is still tearing down the gateway or repopulating the pool as
//     part of its restart (see its handler's own comment), so the new run could begin
//     pinning/loading and measuring its targets while the restart's own `ensureModel` call is
//     still in flight, racing residency out from under it.
// Deliberately excludes `download` from the timed drain: a download can run for minutes
// (multi-GB files) and the deadline below is ~10s, so waiting it out would turn "a download
// is still going" into a generic "could not drain" failure. It is still a fence: acquire
// refuses immediately while a download is already admitted (including one left by a page
// reload — this process outlives the webview, and the new page's in-memory counter does
// not), and a new download is rejected for as long as the lease is held.
const BENCHMARK_DRAIN_COMMANDS = new Set([
  'gatewayRequest', 'chatCompletion', 'transcribeAudio', 'embedTexts',
  'load', 'unload', 'deleteModel', 'startService',
]);

function benchmarkDrainOperationsOutstanding() {
  return operationAdmission.snapshot().some((op) => BENCHMARK_DRAIN_COMMANDS.has(op.command));
}

function downloadInFlight() {
  return operationAdmission.snapshot().some((op) => op.command === 'download');
}

// Delegates the actual poll/deadline loop to `waitUntilIdle` (monotonic-wait.js), which measures
// elapsed time via `performance.now()` rather than `Date.now()` — see that module's docstring for
// why a wall-clock deadline here would let a clock rollback keep exclusivity, and therefore every
// external gateway client, blocked well beyond this 10s limit.
async function waitForBenchmarkDrainIdle(timeoutMs) {
  return waitUntilIdle(() => !benchmarkDrainOperationsOutstanding(), timeoutMs);
}

// Each incoming stdin line is dispatched as its own concurrent async handler (see the `rl.on
// ('line', ...)` loop below), so two `setBenchmarkExclusive` commands can otherwise interleave:
// an acquire can set the flag and suspend in `waitForBenchmarkDrainIdle` while a concurrently-running
// release (or a second acquire that then times out) clears it, after which the suspended
// acquire resumes and reports `{ exclusive: true }` even though admission is open again. Chain
// every transition through this queue so only one body (including its drain wait) ever runs at
// a time; a rejected link must not break the chain for whoever queues after it.
let benchmarkExclusiveTransitionChain = Promise.resolve();
function serializeBenchmarkExclusiveTransition(fn) {
  const result = benchmarkExclusiveTransitionChain.then(fn, fn);
  benchmarkExclusiveTransitionChain = result.then(() => {}, () => {});
  return result;
}
let explicitShutdownInProgress = false;
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
let activeLogLevel = 'info';

// --- Command allowlist and schema (mirrors src/lib/ipc-contracts.ts) ---
const KNOWN_COMMANDS = new Set([
  'init', 'setLogLevel', 'startService', 'stopService', 'stopAndUnload', 'shutdownRuntime', 'getStatus',
  'listModels', 'download', 'load', 'unload', 'deleteModel', 'getEndpoint',
  'chatCompletion', 'cancelChatRequest', 'transcribeAudio', 'embedTexts',
  'getEps', 'ensureAccelerators', 'getVisionModels', 'getSTTModels',
  'poolStatus', 'getAccessLog', 'getHealthRing', 'fetchUrl',
  'getCacheInventory',
  'inspectModelFolder', 'importModelFolder', 'linkModelFolder',
  'getModelTemplate', 'setModelTemplate',
  'setEvictionConfig', 'setModelPriorities', 'applyMemorySettings',
  'setBenchmarkExclusive',
  'wslStatus', 'wslEnableMirrored', 'wslShutdown',
]);

// Per-command type requirements. Keys are required or optional field names; values are:
// 'number', 'string' (any string), 'non-empty-string', 'array'.
const FIELD_TYPES = {
  init:              { appName: 'non-empty-string', logLevel: 'non-empty-string' },
  setLogLevel:       { level: 'non-empty-string' },
  startService:      { port: 'number', bindAddress: 'string', gateway: 'boolean', deferCatalogRead: 'boolean' },
  stopAndUnload:     { drainTimeoutMs: 'number' },
  shutdownRuntime:   { drainTimeoutMs: 'number' },
  download:          { alias: 'non-empty-string', variantId: 'non-empty-string' },
  load:              { alias: 'non-empty-string', variantId: 'non-empty-string' },
  unload:            { alias: 'non-empty-string', ifIdle: 'boolean' },
  deleteModel:       { alias: 'non-empty-string', variantId: 'non-empty-string' },
  chatCompletion:    { model: 'non-empty-string', messages: 'array', tools: 'array' },
  cancelChatRequest: { requestId: 'number' },
  transcribeAudio:   { audioBase64: 'string', mimeType: 'non-empty-string', fileName: 'non-empty-string', model: 'non-empty-string', language: 'non-empty-string' },
  embedTexts:        { model: 'non-empty-string', inputs: 'array' },
  ensureAccelerators: { rebuildBroken: 'boolean' },
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
  applyMemorySettings: { priorities: 'array', seq: 'number' },
  setBenchmarkExclusive: { exclusive: 'boolean' },
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
  startService:       { required: ['port'], optional: ['alias', 'preferredEp', 'bindAddress', 'gateway', 'deferCatalogRead'] },
  stopService:        { required: [], optional: [] },
  stopAndUnload:      { required: [], optional: ['drainTimeoutMs'] },
  shutdownRuntime:    { required: [], optional: ['drainTimeoutMs'] },
  getStatus:          { required: [], optional: [] },
  listModels:         { required: [], optional: [] },
  download:           { required: ['alias'], optional: ['variantId'] },
  load:               { required: ['alias'], optional: ['lane', 'variantId'] },
  unload:             { required: ['alias'], optional: ['lane', 'ifIdle'] },
  deleteModel:        { required: ['alias'], optional: ['variantId'] },
  getEndpoint:        { required: [], optional: [] },
  chatCompletion:     { required: ['model', 'messages'], optional: ['maxTokens', 'temperature', 'preferredEp', 'stream', 'tools', 'toolChoice', 'responseFormat'] },
  cancelChatRequest:  { required: ['requestId'], optional: [] },
  transcribeAudio:    { required: ['audioBase64', 'mimeType', 'fileName', 'model', 'language'], optional: ['temperature', 'preferredEp'] },
  embedTexts:         { required: ['model', 'inputs'], optional: [] },
  getEps:             { required: [], optional: [] },
  ensureAccelerators: { required: [], optional: ['rebuildBroken'] },
  getVisionModels:    { required: [], optional: [] },
  getSTTModels:       { required: [], optional: [] },
  poolStatus:         { required: [], optional: [] },
  getAccessLog:       { required: [], optional: [] },
  getHealthRing:      { required: [], optional: [] },
  getCacheInventory:  { required: [], optional: [] },
  fetchUrl:           { required: ['url'], optional: ['maxChars'] },
  inspectModelFolder: { required: ['folderPath'], optional: [] },
  importModelFolder:  { required: ['folderPath', 'name'], optional: ['publisher', 'version', 'promptTemplate'] },
  linkModelFolder:    { required: ['folderPath', 'name'], optional: ['publisher'] },
  getModelTemplate:   { required: ['name'], optional: [] },
  setModelTemplate:   { required: ['name', 'promptTemplate'], optional: [] },
  setEvictionConfig:  { required: [], optional: ['idleUnloadEnabled', 'idleTimeoutMs', 'maxResidentEnabled', 'maxResident'] },
  setModelPriorities: { required: ['priorities'], optional: [] },
  applyMemorySettings: { required: ['priorities'], optional: ['eviction', 'seq'] },
  setBenchmarkExclusive: { required: ['exclusive'], optional: [] },
  wslStatus:          { required: [], optional: [] },
  wslEnableMirrored:  { required: [], optional: [] },
  wslShutdown:        { required: [], optional: [] },
};

// Commands that dereference the SDK manager. A sidecar asked to run one of these before
// `init` — typically because the host respawned it after a crash and forgot to re-init —
// must answer with something actionable instead of a null-deref
// ("Cannot read properties of null (reading 'catalog')").
const NEEDS_INIT = new Set([
  'listModels', 'download', 'load', 'unload', 'deleteModel', 'chatCompletion',
  'transcribeAudio', 'embedTexts', 'getVisionModels', 'getSTTModels', 'startService',
  'getEps', 'ensureAccelerators', 'inspectModelFolder', 'importModelFolder',
  'linkModelFolder', 'getModelTemplate', 'setModelTemplate',
]);

// Base64 character limit for transcribeAudio. 50 MB decoded audio is ~67 MB of base64.
const AUDIO_BASE64_MAX_CHARS = Math.ceil(50 * 1024 * 1024 * 4 / 3);
const EMBED_MAX_INPUTS = 32;
const EMBED_MAX_CHARS = 8192;

/**
 * Validates a command name and its payload fields.
 * Returns an error string if invalid, or null if the command is well-formed.
 */
/** Nested types for the eviction patch, mirroring setEvictionConfig's own FIELD_TYPES entry. */
const EVICTION_FIELD_TYPES = {
  idleUnloadEnabled: 'boolean',
  idleTimeoutMs: 'number',
  maxResidentEnabled: 'boolean',
  maxResident: 'number',
};

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
  // appName becomes ~/.<appName>: the model cache, the provider caches Recheck deletes, and
  // Foundry's own data. It must be one folder name, so no path can leave the home directory.
  if (cmd === 'init' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(payload.appName)) {
    return 'Command "init" field "appName" must be a single folder name of letters, digits, ".", "_" or "-"';
  }
  if (cmd === 'startService' && payload.alias !== undefined && (typeof payload.alias !== 'string' || !payload.alias.trim())) return `Command "startService" field "alias" must be a non-empty string`;
  if ((cmd === 'chatCompletion' || cmd === 'transcribeAudio') && payload.temperature !== undefined && typeof payload.temperature !== 'number') return `Command "${cmd}" field "temperature" must be a number`;
  if (cmd === 'chatCompletion') {
    if (payload.stream !== undefined && typeof payload.stream !== 'boolean') return `Command "chatCompletion" field "stream" must be a boolean`;
    if (payload.maxTokens !== undefined && typeof payload.maxTokens !== 'number') return `Command "chatCompletion" field "maxTokens" must be a number`;
    if (payload.tools !== undefined) {
      if (!Array.isArray(payload.tools) || payload.tools.length > 64) {
        return 'Command "chatCompletion" field "tools" must contain at most 64 definitions';
      }
      let serializedBytes = 0;
      for (const tool of payload.tools) {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool) || tool.type !== 'function') {
          return 'Command "chatCompletion" tool definitions must use type "function"';
        }
        const fn = tool.function;
        if (!fn || typeof fn !== 'object' || Array.isArray(fn)
          || typeof fn.name !== 'string' || !fn.name.trim() || fn.name.length > 128) {
          return 'Command "chatCompletion" tool function names must be non-empty strings of at most 128 characters';
        }
        if (fn.description !== undefined && (typeof fn.description !== 'string' || fn.description.length > 4096)) {
          return 'Command "chatCompletion" tool descriptions must be strings of at most 4096 characters';
        }
        if (fn.parameters !== undefined && (
          typeof fn.parameters !== 'object' || fn.parameters === null || Array.isArray(fn.parameters)
        )) {
          return 'Command "chatCompletion" tool parameters must be a JSON object';
        }
        serializedBytes += Buffer.byteLength(JSON.stringify(tool));
      }
      if (serializedBytes > 64 * 1024) {
        return 'Command "chatCompletion" tool definitions exceed the 64 KiB limit';
      }
    }
    if (payload.toolChoice !== undefined && !(
      payload.toolChoice === 'none'
      || payload.toolChoice === 'auto'
      || payload.toolChoice === 'required'
      || (
        payload.toolChoice
        && typeof payload.toolChoice === 'object'
        && !Array.isArray(payload.toolChoice)
        && payload.toolChoice.type === 'function'
        && payload.toolChoice.function
        && typeof payload.toolChoice.function.name === 'string'
        && payload.toolChoice.function.name.length <= 128
      )
    )) {
      return 'Command "chatCompletion" field "toolChoice" is invalid';
    }
    if (payload.responseFormat !== undefined && (
      !payload.responseFormat
      || typeof payload.responseFormat !== 'object'
      || Array.isArray(payload.responseFormat)
      || !['text', 'json_object', 'json_schema'].includes(payload.responseFormat.type)
    )) {
      return 'Command "chatCompletion" field "responseFormat" is invalid';
    }
    if (payload.responseFormat?.type === 'json_schema' && (
      !payload.responseFormat.json_schema
      || typeof payload.responseFormat.json_schema !== 'object'
      || Array.isArray(payload.responseFormat.json_schema)
    )) {
      return 'Command "chatCompletion" json_schema response format requires a JSON object';
    }
  }
  if (cmd === 'applyMemorySettings' && payload.eviction !== undefined) {
    const ev = payload.eviction;
    if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) {
      return `Command "applyMemorySettings" field "eviction" must be an object`;
    }
    // Same strictness the standalone setEvictionConfig gets from COMMAND_SCHEMA/FIELD_TYPES:
    // a misspelled key or a string "false" would otherwise normalize to a silent default.
    for (const [key, value] of Object.entries(ev)) {
      const expected = EVICTION_FIELD_TYPES[key];
      if (!expected) return `Command "applyMemorySettings" eviction has unknown field "${key}"`;
      if (typeof value !== expected) {
        return `Command "applyMemorySettings" eviction field "${key}" must be a ${expected}`;
      }
    }
  }
  // Lane validation for commands that accept a lane field
  if (LANE_CMDS.has(cmd) && payload.lane !== undefined && !VALID_LANES.has(payload.lane)) {
    return `Command "${cmd}" invalid lane "${payload.lane}": must be "chat" or "audio"`;
  }
  if (cmd === 'transcribeAudio' && payload.audioBase64.length > AUDIO_BASE64_MAX_CHARS) {
    return `Command "transcribeAudio" audioBase64 exceeds maximum allowed size`;
  }
  if (
    (cmd === 'stopAndUnload' || cmd === 'shutdownRuntime') &&
    payload.drainTimeoutMs !== undefined &&
    (!Number.isFinite(payload.drainTimeoutMs) || payload.drainTimeoutMs < 0)
  ) {
    return `Command "${cmd}" field "drainTimeoutMs" must be a finite non-negative number`;
  }
  if (cmd === 'transcribeAudio') {
    // Container sniffing is pure input validation, so it runs here — before the
    // state-dependent NEEDS_INIT guard — and only needs the first bytes (the sniffer
    // reads at most 12). Renaming to .wav does not convert, so non-WAV bytes must be
    // rejected up front rather than deep inside the native decoder.
    try {
      assertWavBuffer(Buffer.from(String(payload.audioBase64).slice(0, 32), 'base64'), payload.fileName);
    } catch (e) {
      return e.message;
    }
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
  if (cmd === 'embedTexts') {
    const inputs = payload.inputs;
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return 'Command "embedTexts" requires a non-empty inputs array';
    }
    if (inputs.length > EMBED_MAX_INPUTS) {
      return `Command "embedTexts" accepts at most ${EMBED_MAX_INPUTS} strings per call`;
    }
    for (const item of inputs) {
      if (typeof item !== 'string' || !item.trim()) {
        return 'Command "embedTexts" inputs must be non-empty strings';
      }
      if (item.length > EMBED_MAX_CHARS) {
        return `Command "embedTexts" rejects strings longer than ${EMBED_MAX_CHARS} characters`;
      }
    }
  }
  return null;
}
// --- end allowlist ---

let manager = null;
// One registration for this process. SDK 2.0.1 freezes the catalog on first read,
// and the IPC handler does not serialize commands, so a list, load, gateway resolve,
// or pool status can arrive while startup is still registering providers.
let catalogRegistrationGate = null;

function acceleratorGate() {
  if (!manager) return null;
  if (!catalogRegistrationGate) {
    catalogRegistrationGate = createCatalogRegistrationGate((progress, options) => {
      if (!manager || typeof manager.downloadAndRegisterEps !== 'function') return null;
      return registerDiscoveredExecutionProviders(manager, progress, options);
    }, () => {
      const catalog = manager?.catalog;
      if (!catalog || typeof catalog.getModels !== 'function') {
        throw new Error('Foundry catalog is unavailable');
      }
      return catalog.getModels();
    });
  }
  return catalogRegistrationGate;
}

function beforeCatalogRead(onProgress, options = {}) {
  const gate = acceleratorGate();
  if (!gate) return Promise.resolve(null);
  if (options.seal) return gate.seal(onProgress);
  // `commit` performs the actual first catalog read inside the same queue as
  // registration. An explicit update cannot register beside snapshot creation.
  return options.commit ? gate.commit(onProgress) : gate.ensure(onProgress);
}

function catalogReadConfirmed() {
  const gate = acceleratorGate();
  return !gate || gate.isCommitConfirmed();
}

function readCatalog(operation, onProgress) {
  const gate = acceleratorGate();
  return gate ? gate.read(operation, onProgress) : operation();
}

function readUnconfirmedCatalog(operation, onProgress) {
  const gate = acceleratorGate();
  return gate ? gate.readUnconfirmed(operation, onProgress) : operation();
}

function readCatalogTelemetry(operation) {
  const gate = acceleratorGate();
  return gate ? gate.readTelemetry(operation) : operation();
}

function readExecutionProviders(operation) {
  const gate = acceleratorGate();
  return gate ? gate.readProviders(operation) : operation();
}

function serializeModelOperation(alias, scopes, operation) {
  return modelOperationQueue.run(alias, scopes, operation);
}

function trySerializeModelOperation(alias, scopes, operation) {
  return modelOperationQueue.tryRun(alias, scopes, operation);
}

/** Settings “Install / Update Accelerators” uses the same command as startup.
 * The update still runs after catalog commitment, but new variants remain invisible
 * to the current immutable snapshot and require a runtime restart. */
async function rerunAcceleratorRegistration(onProgress, registerOnce) {
  const gate = acceleratorGate();
  if (!gate) return Promise.resolve(null);
  return gate.rerun(onProgress, registerOnce);
}

async function runCatalogMutation(mutate, operation, onProgress, options) {
  const gate = acceleratorGate();
  if (!gate) {
    throw new Error(`Cannot perform ${operation}: initialize the Foundry runtime first`);
  }
  const { result, catalogRefreshRequiresRestart } = await gate.mutateAndCommit(
    mutate,
    (error) => {
      log('warn', `Catalog snapshot read failed after ${operation}: ${error?.message ?? error}`);
    },
    onProgress,
    options,
  );
  try {
    manager?.catalog?.invalidateCache?.();
  } catch (error) {
    log('warn', `Catalog cache invalidation failed after ${operation}: ${error?.message ?? error}`);
  }
  return catalogRefreshRequiresRestart && result && typeof result === 'object'
    ? { ...result, catalogRefreshRequiresRestart: true }
    : result;
}

let FoundryLocalManager = null;
let cachedSdkModule = null;
let initConfig = null; // { appName, logLevel } — kept so startService can re-create manager with webServiceUrls
let nativeServiceStartAttempted = false;
const canceledRequests = new Set();
const acquireServiceTransition = createServiceTransitionLock();

// Model pool: Map<alias, { catModel, variantId }>
// variantId is catModel.id (e.g. "Phi-4-mini-instruct-generic-cpu:5") — required for HTTP routing.
// Multiple models coexist; residency is bounded by the eviction rules below, which are off
// by default (spike confirmed co-residency is safe until memory runs out).
const pool = new Map();
let sharedEndpoint = null;

// Idle bookkeeping that drives eviction, kept beside the pool rather than inside it so a
// variant switch (which replaces the pool entry) does not reset a model's history. In-flight
// requests are counted by `modelActivityFence`, keyed by the name each request asked for.
/** @type {Map<string, { lastUsedAt: number }>} */
const usage = new Map();
/** @type {Map<string, 'pinned'|'low'|'normal'>} set by the UI; absent means 'normal'. */
const modelPriorities = new Map();
let evictionConfig = { ...DEFAULT_EVICTION_CONFIG };
let evictionTimer = null;
/**
 * Highest `applyMemorySettings` client sequence number actually installed so far, or -1 before
 * any sequenced call has landed.
 *
 * The IPC transport (`sendInternal` in src/lib/sdk.ts) writes each command to the wire only once
 * it reaches the front of a per-process write queue, and a command issued *before* another can
 * still be delayed behind a sidecar respawn/re-init wait that the other call never hits — so two
 * `applyMemorySettings` calls can arrive here in the opposite order from how the client issued
 * them. Because this command fully replaces the priority map (not a merge), an older call
 * arriving after a newer one would otherwise silently wipe out whatever the newer call just
 * pinned/restored. The client echoes its own local monotonic `pushMemorySeq` counter in `seq`;
 * this guard, held for the same lock as the actual install (see the `applyMemorySettings`
 * handler), refuses to apply any call whose `seq` is not strictly newer than the last one
 * actually installed, so a stale write can never overwrite a fresher one regardless of arrival
 * order. `seq` is optional so older/other callers without it get no ordering guarantee, matching
 * this field's absence before it existed.
 */
let lastAppliedMemorySettingsSeq = -1;

/** How often the pool is checked. Fine-grained timing does not matter for a minutes-scale idle rule. */
const EVICTION_SWEEP_MS = 30_000;

function usageFor (alias) {
  let entry = usage.get(alias);
  if (!entry) {
    entry = { lastUsedAt: Date.now() };
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

const modelActivityFence = createModelActivityFence({
  residentAliasFor: aliasForModelName,
  residentVariantFor: (alias) => pool.get(alias)?.variantId || null,
  catalogAliasFor: (modelName) => (modelIndex ? resolveModelId(modelIndex, modelName)?.alias : null),
  catalogResolutionFor: (modelName) => (modelIndex ? resolveModelId(modelIndex, modelName) : null),
});

/**
 * Marks a model busy for the life of a request so eviction cannot unload it mid-flight.
 * A start refused by a destructive fence books nothing and returns false. A successful start
 * returns the exact normalized booking token that must be supplied to the matching end.
 */
function noteActivity (modelName, phase, booking) {
  if (phase === 'start') {
    // modelActivityFence replaces activityFences.has(candidate.toLowerCase()) while preserving
    // the same alias-aware refusal semantics for variant and catalog names.
    const residentAlias = aliasForModelName(modelName);
    const resolution = modelIndex ? resolveModelId(modelIndex, modelName) : null;
    const occupantAlias = residentAlias || (pool.has(resolution?.alias) ? resolution.alias : null);
    const occupant = occupantAlias ? pool.get(occupantAlias) : null;
    const candidates = activityCandidateKeys({
      requested: modelName,
      matchedResidentAlias: residentAlias,
      occupantAlias,
      occupantVariantId: occupant?.variantId || null,
      modelIndexAvailable: !!modelIndex,
      resolvedAlias: resolution?.alias || null,
      resolvedVariantId: resolution?.variantId || null,
    });
    const key = candidates[0] || modelName;
    const token = modelActivityFence.start(key, {
      deferResidentAlias: candidates.length > 1 && key !== candidates[1],
    });
    if (token === false) return false;
    touchModel(aliasForModelName(modelName));
    return token;
  } else {
    modelActivityFence.end(booking ?? modelName);
    touchModel(aliasForModelName(booking ?? modelName));
  }
  return true;
}

async function withModelActivityFence(alias, operation) {
  const release = modelActivityFence.tryAcquire(alias);
  if (!release) return null;
  try {
    return { result: await operation() };
  } finally {
    release();
  }
}

function stopGatewayAccepting () {
  const current = gateway;
  gateway = null;
  current?.beginStop();
  return current;
}

/** Requests served by `alias`'s resident build. Every destructive decision must use this. */
function inFlightFor (alias) {
  return modelActivityFence.inFlightFor(alias);
}

function tryBeginIdleUnload (alias) {
  return modelActivityFence.tryAcquire(alias);
}

function poolEntriesForEviction () {
  return [...pool.keys()].map(alias => {
    const use = usageFor(alias);
    return {
      alias,
      lastUsedAt: use.lastUsedAt,
      inFlight: inFlightFor(alias),
      priority: normalizePriority(modelPriorities.get(alias)),
    };
  });
}

async function unloadAliasLocked (alias) {
  const entry = pool.get(alias);
  if (!entry) return false;
  try {
    if (typeof entry.catModel.unload === 'function') await entry.catModel.unload();
  } catch (e) {
    // A model we could not unload is still resident. Dropping it from the pool would hide
    // it from every later sweep and from poolStatus while it keeps consuming memory, and
    // reporting success would let the caller admit another model in its place.
    log('warn', `Unload of ${alias} failed: ${e?.message || e}`);
    return false;
  }
  pool.delete(alias);
  usage.delete(alias);
  return true;
}

/**
 * Stop admitting work, let already-admitted commands finish for a bounded period, then release
 * native resources only when doing so cannot race an operation that still owns a model.
 */
async function performRuntimeCleanup (
  drainTimeoutMs = DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  { terminal = false } = {},
) {
  try {
    const deadline = Date.now() + Math.floor(drainTimeoutMs);
    operationAdmission.beginDrain({ terminal });
    if (evictionTimer) {
      clearInterval(evictionTimer);
      evictionTimer = null;
    }

    const drainingGateway = stopGatewayAccepting();

    const remainingMs = () => Math.max(0, deadline - Date.now());
    const waitWithinDeadline = async (promise) => {
      const remaining = remainingMs();
      return Promise.race([
        Promise.resolve(promise).then(() => true, () => false),
        new Promise(resolve => setTimeout(() => resolve(false), Math.max(1, remaining))),
      ]);
    };

    const operationsDrained = await operationAdmission.waitForDrain(remainingMs());
    const gatewayDrained = !drainingGateway ||
      (operationsDrained && await waitWithinDeadline(drainingGateway.beginStop()));
    const sweepsDrained = operationsDrained && gatewayDrained &&
      await waitWithinDeadline(sweepChain);
    const drained = operationsDrained && gatewayDrained && sweepsDrained;
    const activeOperations = operationAdmission.snapshot();
    const modelsUnloaded = [];
    const unloadFailures = [];

    if (drained) {
      await withSweepLock(async () => {
        for (const alias of [...pool.keys()]) {
          const unload = trySerializeModelOperation(
            alias,
            ['residency'],
            () => unloadAliasLocked(alias),
          );
          if (!unload || !(await unload)) unloadFailures.push(alias);
          else modelsUnloaded.push(alias);
        }
      });
    }

    if (!drained) {
      await drainingGateway?.stop({ force: true });
    } else {
      await drainingGateway?.stop({ force: false });
    }
    clearPublishedService();

    let nativeServiceStopped = !nativeServiceStartAttempted;
    if (drained) {
      try {
        nativeServiceStopped = stopNativeWebService() || !nativeServiceStartAttempted;
      } catch (e) {
        log('warn', `Native service stop during runtime shutdown failed: ${e?.message ?? e}`);
      }
    }
    tokenAccumulator.clear();

    const result = {
      endpointWithdrawn: true,
      serviceStopped: nativeServiceStopped,
      drained,
      activeOperations,
      modelsUnloaded,
      unloadFailures,
      nativeServiceStopped,
      cleanup: !drained
        ? 'timed-out'
        : unloadFailures.length || !nativeServiceStopped
          ? 'failed'
          : 'confirmed',
    };
    return result;
  } finally {
    if (!terminal) {
      operationAdmission.resume();
      restartEvictionTimer();
    }
  }
}

let runtimeShutdownPromise = null;

function performRuntimeShutdown (drainTimeoutMs = DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS) {
  if (!runtimeShutdownPromise) {
    operationAdmission.beginDrain({ terminal: true });
    runtimeShutdownPromise = (async () => {
      const release = await acquireServiceTransition();
      try {
        return await performRuntimeCleanup(drainTimeoutMs, { terminal: true });
      } finally {
        release();
      }
    })();
  }
  return runtimeShutdownPromise;
}

/**
 * Serializes every eviction sweep and admission decision.
 *
 * A sweep draws a plan from the current pool and then unloads asynchronously. Two overlapping
 * sweeps — the timer, a config change and two admissions, say — would each plan against the
 * same pool, each count only its own admission, and both proceed: with a cap of 1 and an empty
 * pool that ends with two resident models.
 */
let sweepChain = Promise.resolve();

function withSweepLock (fn) {
  const next = sweepChain.then(fn, fn);
  sweepChain = next.catch(() => {});
  return next;
}

/** Loads that have been admitted but have not finished, so the planner can count them. */
let pendingAdmissions = 0;

/**
 * @param {object} [options]
 * @param {number} [options.admitting] models about to load, so room is freed before the
 *   memory is spent rather than after
 * @param {string} [options.excludeAlias] an alias whose slot is about to be freed, so the
 *   planner sees the pool as it will be rather than as it is
 */
async function runEvictionSweep (options = {}) {
  return withSweepLock(() => runEvictionSweepLocked(options));
}

async function runEvictionSweepLocked (options = {}) {
  if (!evictionConfig.idleUnloadEnabled && !evictionConfig.maxResidentEnabled) return [];
  // Loads that are already admitted but still loading are not in the pool yet, so a sweep
  // that ignored them would plan against a pool that is about to grow and free nothing.
  const admitting = options.admitting ?? pendingAdmissions;
  const entries = options.excludeAlias
    ? poolEntriesForEviction().filter(e => e.alias !== options.excludeAlias)
    : poolEntriesForEviction();
  const plan = selectEvictions(entries, evictionConfig, Date.now(), { ...options, admitting });
  const done = [];
  for (const item of plan) {
    // Re-check under the current state: sweeps are async, and a request may have arrived
    // for this model since the plan was drawn up. Use the derived count so requests still
    // booked under a non-resident key (gateway autoload) are respected here too.
    if (inFlightFor(item.alias) > 0) continue;
    // Priorities can change mid-sweep too, and a model the user just pinned must survive
    // the plan that was drawn before the pin.
    if (normalizePriority(modelPriorities.get(item.alias)) === 'pinned') continue;
    const unload = trySerializeModelOperation(
      item.alias,
      ['residency'],
      async () => {
        const fenced = await withModelActivityFence(
          item.alias,
          () => unloadAliasLocked(item.alias),
        );
        return fenced?.result === true;
      },
    );
    if (unload && await unload) {
      log('info', describeEviction(item, evictionConfig));
      audit('evict', { alias: item.alias, reason: item.reason });
      done.push(item);
    }
  }
  return done;
}

/**
 * Reserve room for one load of `alias`, freeing it first.
 *
 * Returns a `release()` the caller must invoke once the load settles. Throws when the cap
 * cannot be honoured — an unload that failed leaves its model resident, and loading anyway is
 * exactly the memory overcommit the pre-load sweep exists to prevent.
 */
async function admitModel (alias, replacement = null) {
  await withSweepLock(async () => {
    pendingAdmissions += 1;
    try {
      // Validate before destroying anything. A replacement checks that its swap is still
      // legal, but does not unload yet: if admission then fails the caller would be left
      // with a failed load *and* no working model.
      if (replacement) await replacement.precheck();
      try {
        // Free room before committing memory rather than after. Counting this load against the
        // cap is the difference between staying under the limit and briefly exceeding it, which
        // on a tight machine is the moment the allocation fails.
        // A replacement's own slot is about to be freed, so the planner must not count it —
        // otherwise it evicts an unrelated model to make room the swap already provides.
        await runEvictionSweepLocked({
          admitting: pendingAdmissions,
          excludeAlias: replacement ? alias : undefined,
        });
      } catch (e) {
        log('warn', `Eviction before load failed: ${e?.message || e}`);
      }
      if (evictionConfig.maxResidentEnabled) {
        const resident = [...pool.keys()].filter(a => a !== alias).length;
        if (resident + pendingAdmissions > evictionConfig.maxResident) {
          throw new Error(
            `Cannot load ${alias}: the ${evictionConfig.maxResident}-model limit is reached and `
            + `no loaded model could be unloaded to make room.`,
          );
        }
      }
      // Admission is assured, so the outgoing variant can now be given up. This still runs
      // under the sweep lock, so no other admission can claim the slot it frees.
      if (replacement) await replacement.commit();
    } catch (e) {
      try {
        await replacement?.abort?.();
      } catch {}
      // The reservation never becomes a load, so it must not linger in the count. The
      // caller's `release()` is unreachable when admission throws.
      pendingAdmissions = Math.max(0, pendingAdmissions - 1);
      throw e;
    }
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingAdmissions = Math.max(0, pendingAdmissions - 1);
  };
}

/**
 * Install new memory settings and sweep as one operation.
 *
 * Installing outside the lock is not enough: an older sweep already between its asynchronous
 * unloads drew its plan under the previous settings, so a model pinned a moment ago could
 * still be unloaded by it. Holding the lock across the install means every sweep either sees
 * all of the new settings or none of them.
 */
async function installAndSweep (install) {
  return withSweepLock(async () => {
    install();
    return runEvictionSweepLocked();
  });
}

/** Install eviction rules without sweeping, so a caller can batch settings before one sweep. */
function installEvictionConfig (patch) {
  evictionConfig = normalizeEvictionConfig({ ...evictionConfig, ...patch });
  restartEvictionTimer();
  log('info', `Eviction config: idle=${evictionConfig.idleUnloadEnabled ? `${Math.round(evictionConfig.idleTimeoutMs / 60_000)}min` : 'off'} `
    + `cap=${evictionConfig.maxResidentEnabled ? evictionConfig.maxResident : 'off'}`);
}

/** Install the priority map without sweeping. */
function installModelPriorities (priorities) {
  if (!Array.isArray(priorities)) {
    throw new Error('priorities must be an array');
  }
  modelPriorities.clear();
  for (const item of priorities) {
    const alias = typeof item?.alias === 'string' ? item.alias.trim() : '';
    if (!alias) continue;
    const priority = normalizePriority(item?.priority);
    // 'normal' is the default, so storing it would only grow the map forever.
    if (priority !== 'normal') modelPriorities.set(alias, priority);
  }
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
let gatewayOperationId = 0;
let upstreamPort = null;
// Identifier → {alias, variantId} for autoload. Rebuilt lazily and invalidated whenever the
// set of cached models changes, since a stale map would refuse a model the user just added.
let modelIndex = null;

function invalidateModelIndex () {
  modelIndex = null;
}

function cacheModelIndexFromCatalog(models) {
  modelIndex = buildModelIndex((models || []).map(m => ({
    alias: m.alias,
    variants: (m.variants || []).map(v => ({ id: v.id, cached: isCachedModel(v) })),
  })));
  return modelIndex;
}

function cacheModelIndexFromCachedModels(models) {
  modelIndex = buildCachedModelIndex(models);
  return modelIndex;
}

async function resolveForGateway (requested) {
  if (!modelIndex) {
    if (!manager) return null;
    try {
      return await readCatalog(async () => {
        const models = await manager.catalog.getModels();
        cacheModelIndexFromCatalog(models);
        return resolveModelId(modelIndex, requested);
      });
    } catch (e) {
      log('warn', `Gateway could not read the catalog: ${e?.message ?? e}`);
      try {
        return await readUnconfirmedCatalog(async () => {
          const cached = await manager.catalog.getCachedModels();
          cacheModelIndexFromCachedModels(cached);
          return resolveModelId(modelIndex, requested);
        });
      } catch (lookupError) {
        log('warn', `Gateway could not resolve cached model ${requested}: ${lookupError?.message ?? lookupError}`);
        return null;
      }
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

function clearPublishedService () {
  sharedEndpoint = null;
  upstreamPort = null;
  invalidateModelIndex();
}

async function rollbackPartialServiceStart () {
  await stopPartiallyStartedService({
    stopGateway,
    stopNativeService: stopNativeWebService,
    clearPublishedService,
    log,
  });
}

function stopNativeWebService () {
  const stopped = stopNativeWebServiceFor({
    manager,
    startAttempted: nativeServiceStartAttempted,
  });
  if (stopped) nativeServiceStartAttempted = false;
  return stopped;
}

/** The native service reports readiness on /status; startWebService() returning does not. */
async function waitForUpstream (port, deadlineMs = 20000) {
  const result = await waitForHttpReady({
    fetchImpl: fetch,
    url: `http://127.0.0.1:${port}/status`,
    deadlineMs,
  });
  if (!result.ready) {
    log('warn', `Upstream service not ready after ${deadlineMs}ms: ${result.lastError}`);
  }
  return result.ready;
}

// Per-request access log. IPC chat plus gateway *metadata* (no bodies, no headers).
// Gateway volume is bounded by the same 500-entry ring and the async disk writer.
const ACCESS_LOG_MAX = 500;
const accessLog = [];
const tokenAccumulator = new Map(); // alias → { tokensIn: number, tokensOut: number }; reset on stopService
let activeStreamCount = 0;           // incremented on stream start, decremented in finally; handles concurrent streams
let activeStreamOldest = null;       // { type, modelAlias, startedAt } — the longest-running stream for badge display

const healthRing = createHealthRing();

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

function isLinkedOrForeign(root, target) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return true;
    return !isInsideRoot(root, fs.realpathSync(target));
  } catch {
    return false;
  }
}

async function directoryBytesAndMarkers(dir, root, budget) {
  let sizeBytes = 0;
  let partial = false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    budget.errors.push({ path: dir, message: error?.message || 'Unable to read directory' });
    return { sizeBytes: 0, partial: false };
  }
  for (const entry of entries) {
    await budget.yieldIfNeeded();
    const child = path.join(dir, entry.name);
    if (entry.isSymbolicLink() || isLinkedOrForeign(root, child)) continue;
    if (entry.isFile()) {
      if (entry.name === 'download.tmp') partial = true;
      try { sizeBytes += fs.statSync(child).size; } catch (error) {
        budget.errors.push({ path: child, message: error?.message || 'Unable to stat file' });
      }
    } else if (entry.isDirectory()) {
      const nested = await directoryBytesAndMarkers(child, root, budget);
      sizeBytes += nested.sizeBytes;
      partial ||= nested.partial;
    }
  }
  return { sizeBytes, partial };
}

async function cacheInventoryEntries(root, aliases = modelIndex) {
  const found = [];
  const visited = new Set();
  const budget = {
    count: 0,
    errors: [],
    async yieldIfNeeded() {
      if (++this.count % 100 === 0) await new Promise(resolve => setImmediate(resolve));
    },
  };
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(root); } catch (error) {
    return { entries: found, errors: [{ path: root, message: error?.message || 'Unable to resolve cache root' }] };
  }

  async function walk(dir) {
    await budget.yieldIfNeeded();
    let real;
    try { real = fs.realpathSync(dir); } catch (error) {
      budget.errors.push({ path: dir, message: error?.message || 'Unable to resolve cache path' });
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      budget.errors.push({ path: dir, message: error?.message || 'Unable to read directory' });
      return;
    }
    for (const entry of entries) {
      await budget.yieldIfNeeded();
      const child = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || isLinkedOrForeign(canonicalRoot, child)) {
        found.push({
          path: child,
          alias: null,
          variantId: null,
          sizeBytes: 0,
          partial: false,
          linked: true,
          owned: false,
        });
        continue;
      }
      if (!entry.isDirectory()) continue;

      const childEntries = (() => {
        try { return fs.readdirSync(child, { withFileTypes: true }); } catch (error) {
          budget.errors.push({ path: child, message: error?.message || 'Unable to read directory' });
          return [];
        }
      })();
      const hasMetadata = name => childEntries.some(e => e.isFile() && e.name === name);
      const hasDirectPartial = hasMetadata('download.tmp');
      if (hasMetadata('genai_config.json') && hasMetadata('inference_model.json')) {
        const metadata = readJsonIfPresent(child, 'inference_model.json', budget);
        const name = typeof metadata?.Name === 'string' ? metadata.Name : '';
        const alias = name && aliases ? resolveModelId(aliases, name)?.alias || null : null;
        const stats = await directoryBytesAndMarkers(child, canonicalRoot, budget);
        found.push({
          path: child,
          alias,
          variantId: name || null,
          sizeBytes: stats.sizeBytes,
          partial: stats.partial,
          linked: false,
          owned: hasOwnershipMarker(child, canonicalRoot),
        });
        continue;
      }
      if (hasDirectPartial) {
        const stats = await directoryBytesAndMarkers(child, canonicalRoot, budget);
        found.push({
          path: child,
          alias: null,
          variantId: null,
          sizeBytes: stats.sizeBytes,
          partial: true,
          linked: false,
          owned: hasOwnershipMarker(child, canonicalRoot),
        });
        continue;
      }

      await walk(child);
    }
  }

  await walk(root);
  return { entries: found, errors: budget.errors };
}

function hasOwnershipMarker(dir, root) {
  let current;
  try { current = fs.realpathSync(dir); } catch { current = path.resolve(dir); }
  const boundary = path.resolve(root);
  while (true) {
    if (fs.existsSync(path.join(current, OWNERSHIP_MARKER))) return true;
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    if (!isInsideRoot(boundary, parent)) break;
    current = parent;
  }
  return false;
}

async function getCacheInventory() {
  const root = modelCacheRoot();
  try {
    fs.lstatSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return summarizeCacheInventory([]);
    return summarizeCacheInventory([], [{
      path: root,
      message: error?.message || 'Unable to inspect cache root',
    }]);
  }
  const scanned = await cacheInventoryEntries(root, modelIndex);
  return summarizeCacheInventory(scanned.entries, scanned.errors);
}

/** Files worth reading to classify a candidate folder. */
function readJsonIfPresent(dir, name, budget) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch (error) {
    if (budget) {
      budget.errors.push({
        path: path.join(dir, name),
        message: error?.message || 'Unable to read metadata',
      });
    }
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
    dirName: [path.basename(resolved), path.basename(scanDir)].filter((v, i, a) => a.indexOf(v) === i).join(' '),
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
 * Windows AV/indexer can hold a lock on files just written into staging, so the
 * final rename fails with EPERM. Retry a few times rather than treating that as
 * a permanent import failure.
 */
function renameSyncRetry (from, to) {
  const delaysMs = [0, 25, 50, 100, 200, 400];
  let last = null;
  for (const delay of delaysMs) {
    if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      last = e;
      if (!e || (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY')) throw e;
    }
  }
  throw last;
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
        dirName: name,
        task: inspection.detected.task,
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
    renameSyncRetry(stagingDir, finalDir); // atomic within the same volume
  } catch (e) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw e;
  }

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

  return { name: sanitizeModelName(name), promptTemplate: content.PromptTemplate, warnings: check.warnings };
}

/**
 * Load `alias` (optionally a specific variant) under its residency scope.
 *
 * `requireCached` is for loads that act on an earlier catalog resolution, such as gateway
 * autoload: the resolution may predate a deletion that finished while this load waited for the
 * scope, and loading an uncached build would re-download what the user just deleted.
 */
function ensureModel(alias, variantId, onCatalogProgress, { requireCached = false } = {}) {
  return serializeModelOperation(alias, ['residency'], async ({ waited, previousResult }) => {
      const result = await ensureModelLocked(alias, variantId, onCatalogProgress, requireCached);
      if (waited && result.loadedNow !== true) {
        // A preceding request may have loaded or reloaded this model while this request waited.
        // Only a preceding known-warm result remains warm; the other cases are unknowable from
        // the current request's serialized probe.
        return {
          ...result,
          loadedNow: previousResult?.loadedNow === false ? false : null,
        };
      }
      return result;
  });
}

async function ensureModelLocked(alias, variantId, onCatalogProgress, requireCached = false) {
  const existing = pool.get(alias);
  let switchingVariant = false;
  let releaseReplacementFence = null;
  if (existing) {
    if (variantId && existing.variantId !== variantId) {
      // A variant switch is an unload of the resident build. Doing that while requests are
      // running against it fails them mid-flight, so the caller must retry rather than be
      // silently served the variant it did not ask for.
      if (inFlightFor(alias) > 0) {
        throw new Error(
          `Cannot switch ${alias} to variant ${variantId} while requests are in flight `
          + `(currently ${existing.variantId}). Retry once they finish.`,
        );
      }
      switchingVariant = true;
    } else {
      let loaded = null;
      if (typeof existing.catModel.isLoaded === 'function') {
        try { loaded = await existing.catModel.isLoaded(); } catch {}
      } else if (typeof existing.catModel.isLoaded === 'boolean') {
        loaded = existing.catModel.isLoaded;
      }
      if (loaded === false) {
        // Reloading reads the build from the cache again. A resolution made before the cache
        // changed must not turn that into a download.
        if (requireCached && !isCachedModel(existing.catModel)) {
          throw new Error(`${variantId || alias} is not in the local cache; refusing to load it.`);
        }
        await existing.catModel.load();
        log('info', `Model ${alias} reloaded after runtime eviction`);
      }
      touchModel(alias);
      return {
        ...existing,
        loadedNow: loaded === true ? false : loaded === false ? true : null,
      };
    }
  }
  const lookUpBuild = () => readUnconfirmedCatalog(
    async () => {
      const model = await manager.catalog.getModel(alias);
      return {
        catModel: model,
        variant: variantId ? await manager.catalog.getModelVariant(variantId) : null,
      };
    },
    onCatalogProgress,
  );
  // Validate before admission, which may unload the resident variant this load replaces.
  // Deletion holds this alias's residency scope, so the build cannot vanish before the load.
  let build = null;
  if (requireCached) {
    build = await lookUpBuild();
    if (!isCachedModel(variantId ? build.variant : build.catModel)) {
      throw new Error(`${variantId || alias} is not in the local cache; refusing to load it.`);
    }
  }
  // Reserve a slot (freeing room first) and hold it until the load settles, so a concurrent
  // load of a different alias cannot admit itself against the same free capacity. A variant
  // switch reserves *before* unloading the old build: releasing the slot first would let
  // another alias claim it and leave this load with nowhere to go, having already destroyed
  // the variant the caller was using.
  const releaseAdmission = await admitModel(alias, switchingVariant ? {
    // Nothing here may destroy state: admission can still be refused after this runs.
    precheck: async () => {
      const current = pool.get(alias);
      // A concurrent sweep may already have unloaded it, which is the outcome we wanted.
      if (!current || current.variantId === variantId) return;
      releaseReplacementFence = modelActivityFence.tryAcquire(alias);
      if (!releaseReplacementFence) {
        throw new Error(
          `Cannot switch ${alias} to variant ${variantId} while requests are in flight `
          + `(currently ${current.variantId}). Retry once they finish.`,
        );
      }
    },
    commit: async () => {
      try {
        const current = pool.get(alias);
        if (!current || current.variantId === variantId) return;
        log('info', `Variant switch for ${alias}: ${current.variantId} → ${variantId}`);
        if (!(await unloadAliasLocked(alias))) {
          throw new Error(`Could not unload ${alias} to switch variant to ${variantId}`);
        }
      } finally {
        releaseReplacementFence?.();
        releaseReplacementFence = null;
      }
    },
    abort: async () => {
      releaseReplacementFence?.();
      releaseReplacementFence = null;
    },
  } : null);
  try {
    const { catModel, variant } = build ?? await lookUpBuild();
    if (variantId) {
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
  } finally {
    releaseAdmission();
  }
  touchModel(alias);
  return { ...pool.get(alias), loadedNow: true };
}

async function applyPreferredExecutionProvider (preferredEp, model) {
  return applyPreferredExecutionProviderTo({
    preferredEp,
    manager,
    model,
    log,
  });
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

function getNativeOpenAiApiBase () {
  return upstreamPort
    ? `http://127.0.0.1:${upstreamPort}/v1`
    : getOpenAiApiBase(sharedEndpoint);
}

async function readErrorBody (resp) {
  return readBoundedErrorBody(resp);
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

function mergeToolCallDeltas (target, deltas) {
  for (const delta of Array.isArray(deltas) ? deltas : []) {
    const index = Number.isInteger(delta?.index) ? delta.index : target.length;
    const current = target[index] || {};
    const currentFunction = current.function || {};
    const nextFunction = delta?.function || {};
    target[index] = {
      ...current,
      ...delta,
      function: {
        ...currentFunction,
        ...nextFunction,
        ...(typeof nextFunction.name === 'string' && typeof currentFunction.name === 'string'
          ? { name: currentFunction.name + nextFunction.name }
          : {}),
        ...(typeof nextFunction.arguments === 'string' && typeof currentFunction.arguments === 'string'
          ? { arguments: currentFunction.arguments + nextFunction.arguments }
          : {}),
      },
    };
  }
  return target.filter(Boolean);
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

// Attempt transcription via the new Session/Request/Item AudioSession API (foundry-local-sdk
// 2.0.1+), which will replace the deprecated AudioClient before its end-of-2026 removal.
//
// This is intentionally defensive/best-effort for the first rollout: AudioSession construction
// succeeds for any automatic-speech-recognition model (task validation only, per session.js),
// but a one-shot Item.audioFromUri() request only actually works today for Whisper-family models.
// Nemotron streaming-audio models require raw 16kHz mono PCM pushed via ItemQueue instead (a
// different, not-yet-implemented request shape — tracked separately), and Parakeet has no working
// AudioSession request shape at all yet (confirmed via manual testing against SDK 2.0.1). Both
// reject this one-shot request with a native "does not support audio processing" error, so any
// failure here — construction or the request itself — falls back to the legacy AudioClient path
// unchanged, rather than surfacing an error to the user.
//
// Returns `{ ok: true, candidate }` on success, or `{ ok: false, reason }` on any failure (reason
// is a short string for debug logging only, never surfaced to the user).
async function tryAudioSessionTranscription (sdkModule, audioModel, tempPath, payload) {
  const { AudioSession, Request, Item } = sdkModule || {};
  if (typeof AudioSession !== 'function' || typeof Request !== 'function' || !Item) {
    return { ok: false, reason: 'AudioSession not exported by this SDK build' };
  }

  let session;
  try {
    session = new AudioSession(audioModel);
  } catch (err) {
    return { ok: false, reason: `AudioSession construction failed: ${err?.message || err}` };
  }

  try {
    const search = {};
    if (typeof payload.temperature === 'number') search.temperature = payload.temperature;
    const additionalOptions = (payload.language && payload.language !== 'auto')
      ? { language: payload.language }
      : undefined;

    const request = new Request().addItem(Item.audioFromUri(tempPath));
    request.setOptions({
      ...(Object.keys(search).length ? { search } : {}),
      ...(additionalOptions ? { additionalOptions } : {})
    });

    const response = await session.processRequest(request);
    const speechResult = response.output.find((item) => item.type === 'speechResult');
    if (!speechResult || !normalizeText(speechResult.text)) {
      return { ok: false, reason: 'AudioSession produced no speechResult text' };
    }

    return { ok: true, candidate: extractTranscriptCandidate(speechResult) };
  } catch (err) {
    return { ok: false, reason: `AudioSession request failed: ${err?.message || err}` };
  } finally {
    try { session.dispose(); } catch {}
  }
}

// Builds a ChatSession-backed replacement for `chatModel.createChatClient()` (the
// deprecated OpenAI-shaped wrapper, removed end of 2026). Preserves the SDK's
// OpenAI-shaped request/response bridge: each call serializes an OpenAI Chat Completion
// request into a single `Item.text(json, "openai-json")`, runs it through a
// fresh ChatSession, and recovers the response by JSON-parsing the first
// "openai-json" text item in the output. This keeps the wire shape (and every
// downstream consumer of it) byte-identical to the deprecated client while
// dropping the dependency on the class itself. Returns null if this SDK build
// does not export ChatSession/Request/Item (falls back to createChatClient()).
function createSessionChatClient (chatModel, sdkModule) {
  const { ChatSession, Request, Item } = sdkModule || {};
  if (typeof ChatSession !== 'function' || typeof Request !== 'function' || typeof Item?.text !== 'function') {
    return null;
  }
  const settings = {};
  const serializeSettings = () => {
    const out = {};
    if (Number.isFinite(settings.temperature)) out.temperature = settings.temperature;
    if (Number.isFinite(settings.maxTokens)) out.max_tokens = settings.maxTokens;
    return out;
  };
  const findOpenAiJsonText = (output) => {
    for (const item of output || []) {
      if (item?.type === 'text' && item.textType === 'openai-json') return item.text;
    }
    return undefined;
  };
  return {
    settings,
    async completeChat (messages, tools, options = {}) {
      const requestJson = {
        model: chatModel.id,
        messages,
        ...(tools ? { tools } : {}),
        ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
        ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
        ...serializeSettings(),
      };
      let session;
      try {
        const request = new Request();
        request.addItem(Item.text(JSON.stringify(requestJson), 'openai-json'));
        session = new ChatSession(chatModel);
        const response = await session.processRequest(request);
        const text = findOpenAiJsonText(response?.output);
        if (text === undefined) {
          throw new Error(`Chat completion for model '${chatModel.id}' returned no openai-json text item.`);
        }
        return JSON.parse(text);
      } catch (err) {
        throw new Error(
          `Chat completion failed for model '${chatModel.id}': ${err?.message || err}`,
          { cause: err },
        );
      } finally {
        session?.dispose();
      }
    },
    completeStreamingChat (messages, tools, options = {}) {
      const requestJson = {
        model: chatModel.id,
        messages,
        ...(tools ? { tools } : {}),
        ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
        ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
        stream: true,
        ...serializeSettings(),
      };
      return {
        async * [Symbol.asyncIterator] () {
          let session;
          try {
            const request = new Request();
            request.addItem(Item.text(JSON.stringify(requestJson), 'openai-json'));
            session = new ChatSession(chatModel);
            for await (const item of session.processStreamingRequest(request)) {
              if (item?.type !== 'text' || item.textType !== 'openai-json' || !item.text) continue;
              yield JSON.parse(item.text);
            }
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            throw new Error(
              `Streaming chat completion failed for model '${chatModel.id}': ${err?.message || err}`,
              { cause: err },
            );
          } finally {
            session?.dispose();
          }
        }
      };
    },
  };
}

// Builds an EmbeddingsSession-backed replacement for `embedModel.createEmbeddingClient()`
// (the deprecated OpenAI-shaped wrapper, removed end of 2026). Mirrors the SDK's own
// EmbeddingClient wire format: serializes {model, input} into a single
// `Item.text(json, "openai-json")`, runs it through a fresh EmbeddingsSession, and
// recovers the response from the first "openai-json" text item in the output — keeping
// the wire shape identical to the deprecated client. Returns null if this SDK build does
// not export EmbeddingsSession/Request/Item (falls back to createEmbeddingClient()).
function createSessionEmbeddingClient (embedModel, sdkModule) {
  const { EmbeddingsSession, Request, Item } = sdkModule || {};
  if (typeof EmbeddingsSession !== 'function' || typeof Request !== 'function' || typeof Item?.text !== 'function') {
    return null;
  }
  const findOpenAiJsonText = (output) => {
    for (const item of output || []) {
      if (item?.type === 'text' && item.textType === 'openai-json') return item.text;
    }
    return undefined;
  };
  return {
    async generateEmbeddings (inputs) {
      const requestJson = { model: embedModel.id, input: inputs };
      let session;
      try {
        const request = new Request();
        request.addItem(Item.text(JSON.stringify(requestJson), 'openai-json'));
        session = new EmbeddingsSession(embedModel);
        const response = await session.processRequest(request);
        const text = findOpenAiJsonText(response?.output);
        if (text === undefined) {
          throw new Error(`Embedding generation for model '${embedModel.id}' returned no openai-json text item.`);
        }
        return JSON.parse(text);
      } catch (err) {
        throw new Error(
          `Embedding generation failed for model '${embedModel.id}': ${err?.message || err}`,
          { cause: err },
        );
      } finally {
        session?.dispose();
      }
    },
  };
}

// --- Disk log ---
// Date is computed once at startup; a sidecar running past midnight continues to the same file.
// The bounded async writer keeps logging off the request path without allowing an unbounded queue.
const LOG_DIR = path.join(os.homedir(), '.flint', 'logs');
const LOG_QUEUE_MAX = 1000;
let diskLogPath = null;
let diskLogWriter = null;

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
    diskLogWriter = createAsyncLogWriter({
      maxQueue: LOG_QUEUE_MAX,
      append: (chunk) => fs.promises.appendFile(diskLogPath, chunk, 'utf8'),
      onError: (err) => {
        // Calling log() here would recurse through the same failed writer.
        console.error('[sidecar] Disk write failed:', err?.message || err);
      },
    });
  } catch (err) {
    console.error('[sidecar] Failed to initialize disk log:', err?.message || err);
  }
}

async function flushDiskLog (timeoutMs = 1000) {
  if (!diskLogWriter) return;
  let timeout;
  try {
    await Promise.race([
      diskLogWriter.flush(),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function writeToDisk(entry) {
  if (!diskLogPath || !diskLogWriter) return;
  try {
    diskLogWriter.write(`${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error('[sidecar] Disk log queue failed:', err?.message || err);
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

function send (msg, callback) {
  writeProtocolLine(JSON.stringify(msg), callback);
}

function log (level, message) {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(activeLogLevel)) return;
  const entry = { type: 'log', level, message, timestamp: Date.now() };
  send(entry);
  writeToDisk(entry);
}

function nativeLibraryFileName () {
  if (process.platform === 'win32') return 'foundry_local.dll';
  if (process.platform === 'darwin') return 'libfoundry_local.dylib';
  return 'libfoundry_local.so';
}

/**
 * Directory that contains foundry_local.* plus ONNX Runtime. Foundry 2.0.1's
 * libraryPath must be that directory, not the library file.
 *
 * Dev and packaged layouts both use <sdk>/prebuilds/<platform>/.
 */
function resolveFoundryLibraryDir () {
  const override = process.env.FLINT_FOUNDRY_CORE_PATH;
  if (override && fs.existsSync(override)) {
    return fs.statSync(override).isDirectory() ? override : path.dirname(override);
  }

  const platformKey = `${process.platform}-${process.arch}`;
  const libFile = nativeLibraryFileName();
  const relativeCore = path.join('prebuilds', platformKey, libFile);

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
      return path.dirname(candidate);
    }
  }
  return null;
}

function readFoundryRuntimeVersions (libraryPath) {
  let dir = path.dirname(libraryPath);
  for (let i = 0; i < 5; i++) {
    const pkgFile = path.join(dir, 'package.json');
    const depsFile = path.join(dir, 'deps_versions.json');
    if (fs.existsSync(pkgFile) && fs.existsSync(depsFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        const deps = JSON.parse(fs.readFileSync(depsFile, 'utf8'));
        return {
          sdkVersion: typeof pkg.version === 'string' ? pkg.version : null,
          // 1.x recorded the core as a NuGet version. 2.0 ships the runtime inside the
          // SDK package, so the package version is the core version.
          coreVersion: typeof deps['foundry-local-core']?.nuget === 'string'
            ? deps['foundry-local-core'].nuget
            : (typeof pkg.version === 'string' ? pkg.version : null),
        };
      } catch {
        return { sdkVersion: null, coreVersion: null };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { sdkVersion: null, coreVersion: null };
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
    cachedSdkModule = mod;
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
      cachedSdkModule = mod;
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

// Returns the full foundry-local-sdk module namespace (AudioSession, Request, Item, ...),
// reusing whichever load path getFoundryManager() already resolved. Callers that only need
// FoundryLocalManager should keep using getFoundryManager() directly.
async function getFoundrySdkModule () {
  await getFoundryManager();
  return cachedSdkModule;
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

  const { id, cmd, protocolVersion, ...payload } = msg;

  const reply = (result, callback) => {
    send({ id, protocolVersion: SIDECAR_PROTOCOL_VERSION, ...result }, callback);
  };
  // Registration progress rides the requesting command's id. Tag it so a model download or
  // load cannot display execution-provider percentages as its own progress.
  const reportCatalogProgress = (epName, percent) => {
    if (Number.isFinite(percent)) send({ id, progress: percent, ep: epName, phase: 'accelerator' });
  };

  if (protocolVersion !== undefined && protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
    reply({ error: `Unsupported sidecar protocol version: ${String(protocolVersion)}` });
    return;
  }

  const validationError = validateCommand(cmd, payload);
  if (validationError) {
    log('warn', `IPC validation rejected: cmd=${String(cmd).slice(0, 40)} error=${validationError}`);
    reply({ error: validationError });
    return;
  }

  if (NEEDS_INIT.has(cmd) && !manager) {
    reply({ error: `Foundry SDK not initialized — "init" must run before "${cmd}" (the sidecar may have restarted)` });
    return;
  }

  const isRuntimeShutdown = cmd === 'shutdownRuntime';
  const isDrainCommand = cmd === 'stopAndUnload' || isRuntimeShutdown;
  // Before admission, so a rejected download is not itself "in flight". The benchmark never
  // downloads; its own load/chat calls stay admitted.
  if (benchmarkExclusive && cmd === 'download') {
    reply({
      error: 'A benchmark run is active — stop it before downloading a model.',
      certainty: 'cancelled',
    });
    return;
  }
  let operationAdmitted = false;
  if (isDrainCommand) {
    // Fence synchronously, before waiting for the service-transition lock. Otherwise commands
    // arriving while shutdown is queued could still be admitted behind it.
    operationAdmission.beginDrain({ terminal: isRuntimeShutdown });
    if (isRuntimeShutdown) explicitShutdownInProgress = true;
  } else {
    operationAdmitted = operationAdmission.admit(id, cmd);
    if (!operationAdmitted) {
      reply({
        error: `Runtime is draining; "${cmd}" was not started`,
        certainty: 'cancelled',
      });
      return;
    }
  }

  const releaseServiceTransition = (
    cmd === 'startService' || cmd === 'stopService' || cmd === 'stopAndUnload'
  ) ? await acquireServiceTransition() : null;

  try {
    if (cmd === 'init') {
      const FManager = await getFoundryManager();
      const appName = payload.appName || 'flint';
      const libraryPath = resolveFoundryLibraryDir();
      if (!libraryPath) {
        throw new Error(
          "Foundry native library directory not specified in configuration and could not be auto-discovered. " +
          "Please run 'npm install' / 'npm run ensure:foundry' so native libraries are present, " +
          "then rebuild the installer (natives must be packaged under foundry-local-sdk/prebuilds)."
        );
      }
      initConfig = { appName, logLevel: payload.logLevel || 'info', libraryPath };
      if (!LOG_LEVELS.includes(initConfig.logLevel)) {
        throw new Error(`Unsupported log level "${initConfig.logLevel}". Expected one of: ${LOG_LEVELS.join(', ')}`);
      }
      activeLogLevel = initConfig.logLevel;
      log('info', `Using Foundry native library directory: ${libraryPath}`);
      manager = FManager.create(initConfig);
      log('info', `SDK initialized for ${appName}`);
      const pinWarning = foundryRuntimePinWarning(readFoundryRuntimeVersions(libraryPath));
      if (pinWarning) log('warn', pinWarning);
      healthRing.record({ kind: 'init', libraryPath });
      audit('init', { appName, libraryPath });
      reply({ ok: true, result: 'initialized' });
    } else if (cmd === 'listModels') {
      const rows = await readCatalog(
        async () => {
          const models = await manager.catalog.getModels();
          cacheModelIndexFromCatalog(models);
          return models.map(m => {
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
              supportsToolCalling: typeof m.info?.supportsToolCalling === 'boolean'
                ? m.info.supportsToolCalling
                : null,
              family: m.info?.family || null,
              // Live catalog uses createdAt (unix seconds); older SDK typings said createdAtUnix.
              createdAt: m.info?.createdAt ?? m.info?.createdAtUnix ?? null,
              info: m.info || {},
              variants: variantRows,
              updates: variantRows
                .filter(v => v.update)
                .map(v => ({ sourceVariantId: v.id, ...v.update })),
            };
          });
        },
        reportCatalogProgress,
      );
      reply({ ok: true, result: rows });
    } else if (cmd === 'getSTTModels') {
      const stt = await readCatalog(
        async () => {
          const all = await manager.catalog.getModels();
          return all
            .filter(m => {
              const t = (m.info?.task || '').toLowerCase();
              const caps = (m.info?.capabilities || '').toLowerCase();
              if (t.includes('automatic-speech-recognition') || t.includes('stt') || caps.includes('automatic-speech-recognition')) {
                return true;
              }
              const names = [m.alias, ...(m.variants || []).map(v => v?.id)];
              return names.some(looksLikeSpeech);
            })
            .map(m => ({ alias: m.alias, cached: m.isCached }));
        },
        reportCatalogProgress,
      );
      reply({ ok: true, result: stt });
    } else if (cmd === 'getVisionModels') {
      const vision = await readCatalog(
        async () => {
          const all = await manager.catalog.getModels();
          return all
            .filter(m => {
              const t = (m.info?.task || '').toLowerCase();
              const caps = (m.info?.capabilities || '').toLowerCase();
              const alias = (m.alias || '').toLowerCase();
              return t.includes('vision') || caps.includes('vision') || caps.includes('image') || alias.includes('vision') || alias.includes('multimodal');
            })
            .map(m => ({ alias: m.alias, cached: m.isCached }));
        },
        reportCatalogProgress,
      );
      reply({ ok: true, result: vision });
    } else if (cmd === 'download') {
      await serializeModelOperation(payload.alias, ['cache'], async () => {
        await beforeCatalogRead(reportCatalogProgress, { commit: true });
        const model = await readUnconfirmedCatalog(
          () => payload.variantId
            ? manager.catalog.getModelVariant(payload.variantId)
            : manager.catalog.getModel(payload.alias),
          reportCatalogProgress,
        );
        audit('download.start', { alias: payload.alias, variantId: payload.variantId ?? null });
        await model.download((p) => send({ id, progress: p, alias: payload.alias }));
        // Force next catalog access to re-read model list metadata (info.cached, etc.).
        try { manager.catalog.invalidateCache?.(); } catch {}
        invalidateModelIndex();
        audit('download.complete', { alias: payload.alias, variantId: payload.variantId ?? null });
      });
      reply({ ok: true });
    } else if (cmd === 'load') {
      const entry = await ensureModel(payload.alias, payload.variantId, reportCatalogProgress);
      const acceleration = {
        requested: null,
        active: await detectActiveExecutionProvider(entry.catModel)
      };
      log('info', `Model ${payload.alias} ready (variantId: ${entry.variantId}, accel: ${acceleration.active || 'cpu'})`);
      audit('load', { alias: payload.alias, variantId: entry.variantId, accel: acceleration.active || 'cpu' });
      reply({ ok: true, result: { acceleration, lane: payload.lane || 'chat', variantId: entry.variantId } });
    } else if (cmd === 'unload') {
      const alias = payload.alias;
      await serializeModelOperation(alias, ['residency'], async () => {
        await withSweepLock(async () => {
          const releaseIdleFence = payload.ifIdle ? tryBeginIdleUnload(alias) : modelActivityFence.tryAcquire(alias);
          if (!releaseIdleFence) {
            throw new Error(`Cannot unload ${alias} while requests are in flight. Retry once they finish.`);
          }
          try {
            const unloaded = await unloadAliasLocked(alias);
            if (unloaded) {
              log('info', `Model ${alias} unloaded from pool`);
              audit('unload', { alias });
              return;
            }
            // `unloadAliasLocked` returns false both for an alias that was not resident and for a
            // native unload that threw, and it keeps the failed entry in the pool. Reporting the
            // latter as success would tell the caller memory was released while the model is still
            // loaded, so only the "nothing to unload" case is a successful no-op.
            if (pool.has(alias)) {
              throw new Error(`Unload of ${alias} failed; the model is still loaded.`);
            }
          } finally {
            releaseIdleFence();
          }
        });
      });
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

      const deleteResult = await serializeModelOperation(
        payload.alias,
        ['cache', 'residency'],
        async () => {
          const releaseActivityFence = modelActivityFence.tryAcquire(payload.alias);
          if (!releaseActivityFence) {
            throw new Error(
              `Cannot delete ${payload.alias} while requests are in flight. Retry once they finish.`,
            );
          }
          try {
            return await runCatalogMutation(
              async () => {
              if (variantId) {
                // Delete a single variant from the local cache.
                const variant = await manager.catalog.getModelVariant(variantId);
                if (!variant) {
                  throw new Error(`Variant not found: ${variantId}`);
                }
                const parentModel = await manager.catalog.getModel(payload.alias);
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
                invalidateModelIndex();
                audit('deleteModel', { alias: payload.alias, variantId });
                return {
                  alias: payload.alias,
                  variantId,
                  catalogEntryRemoved:
                    isLocalCatalogEntry(variant) || isLocalCatalogEntry(parentModel),
                };
              }

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
                try {
                  cached = !!v.isCached;
                } catch {
                  cached = !!v.info?.cached;
                }
                if (!cached) continue;
                if (tryRemoveFromCache(v, v.id || payload.alias)) deleted++;
              }
              // Fallback: selected variant / model-level remove
              if (deleted === 0 && tryRemoveFromCache(model, payload.alias)) deleted++;
              if (deleted === 0) {
                throw new Error('No cached variants found to delete (or runtime lacks removeFromCache)');
              }
              log('info', `Deleted ${deleted} cached variant(s) for ${payload.alias}`);
              invalidateModelIndex();
              audit('deleteModel', { alias: payload.alias, variantId: null, count: deleted });
              return {
                alias: payload.alias,
                count: deleted,
                catalogEntryRemoved: isLocalCatalogEntry(model),
              };
              },
              'model deletion',
              reportCatalogProgress,
              { catalogReadBeforeMutation: true },
            );
          } finally {
            releaseActivityFence();
          }
        },
      );
      const {
        catalogEntryRemoved,
        catalogRefreshRequiresRestart,
        ...publicDeleteResult
      } = deleteResult;
      reply({
        ok: true,
        result: catalogEntryRemoved && catalogRefreshRequiresRestart
          ? { ...publicDeleteResult, catalogRefreshRequiresRestart: true }
          : publicDeleteResult,
      });
    } else if (cmd === 'inspectModelFolder') {
      reply({ ok: true, result: inspectFolder(payload.folderPath) });
    } else if (cmd === 'importModelFolder') {
      const result = await runCatalogMutation(
        () => importModelFolder(payload),
        'model import',
        reportCatalogProgress,
      );
      log('info', `Imported model ${result.name}:${result.version} from ${payload.folderPath}`);
      invalidateModelIndex();
      audit('importModelFolder', { alias: result.name, variantId: `${result.name}:${result.version}`, kind: 'copy' });
      reply({ ok: true, result });
    } else if (cmd === 'linkModelFolder') {
      const result = await runCatalogMutation(
        () => linkModelFolder(payload),
        'model link',
        reportCatalogProgress,
      );
      log('info', `Linked model ${result.name} -> ${result.target}`);
      invalidateModelIndex();
      audit('linkModelFolder', { alias: result.name, variantId: null, kind: 'junction' });
      reply({ ok: true, result });
    } else if (cmd === 'getModelTemplate') {
      reply({ ok: true, result: getModelTemplate(payload.name) });
    } else if (cmd === 'setModelTemplate') {
      const result = await runCatalogMutation(
        () => setModelTemplate(payload.name, payload.promptTemplate),
        'template update',
        reportCatalogProgress,
      );
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
      // A destructive restart has withdrawn its old gateway. Do not leave its advertised
      // endpoint behind if the replacement never reaches a usable state.
      clearPublishedService();

      // The pool records what the process-global native core has loaded, and the core keeps
      // those builds loaded and servable across a listener restart (verified against SDK
      // 2.0.1). Clearing the record here would hide live builds from destructive operations,
      // eviction and request accounting while the new listener still serves them.
      try {
        stopNativeWebService();
        // The native listener answers GET /v1/models itself. Register providers before
        // exposure. Normal starts also force the immutable snapshot under the gate; startup
        // can explicitly defer that network-backed read when the user disabled automatic
        // catalog checks, after its own accelerator setup has completed.
        // That read is network-backed. Its only job here is to order provider registration
        // ahead of the listener's own catalog access, and the gate has closed the provider
        // boundary either way, so a failed read must not stop a service that can still serve
        // cached models. Snapshot uncertainty is reported by the accelerator update path.
        try {
          if (payload.deferCatalogRead) {
            await beforeCatalogRead(reportCatalogProgress, { seal: true });
          } else {
            await beforeCatalogRead(reportCatalogProgress, { commit: true });
          }
        } catch (e) {
          // The gate has closed the provider boundary either way, so the update path already
          // reports this as restart-bound. Say so here too: a read that failed leaves the
          // snapshot uncertain while the listener is about to be exposed.
          log(
            'warn',
            `Catalog snapshot read failed before service start: ${e?.message ?? e}. ` +
              'The catalog snapshot is uncertain; accelerator updates are deferred until restart.',
          );
        }
        // Start service BEFORE loading models so HTTP routing layer initializes with the registry.
        if (typeof manager.startWebService === 'function') {
          nativeServiceStartAttempted = true;
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
            //
            // Deliberately does not re-check `benchmarkExclusive` here: `admitRequest` is the
            // sole fence for *new* gateway work, and by the time a request reaches `load` it has
            // already been admitted. `setBenchmarkExclusive(true)`'s acquisition explicitly
            // waits for admitted work to drain before it settles, so an admitted request that
            // still needs to autoload its model must be allowed to finish -- rejecting it here
            // would abort work the fence is supposed to let complete, not the new work it exists
            // to block.
            load: async (alias, variantId) => {
              return (await ensureModel(alias, variantId, undefined, { requireCached: true }))
                ?.variantId ?? null;
            },
            // Proxied traffic never reaches this process, so without this hook a model
            // serving a long completion would look idle and could be evicted underneath it.
            onActivity: noteActivity,
            onAccess: (entry) => appendAccessLog(entry),
            admitRequest: () => {
              if (benchmarkExclusive) return null;
              const operationId = `gateway:${++gatewayOperationId}`;
              if (!operationAdmission.admit(operationId, 'gatewayRequest')) return null;
              return () => operationAdmission.complete(operationId);
            },
            admissionDeniedMessage: () => benchmarkExclusive
              ? 'A benchmark run is in progress; the local gateway is not accepting other work.'
              : 'The local runtime is draining and is not accepting new work.',
            log,
          });
          try {
            await gateway.start();
          } catch (e) {
            gateway = null;
            throw new Error(
              `Could not listen on ${bindAddr}:${payload.port} — ${e?.message ?? e}. `
              + 'Another process may already be using that port.'
            );
          }
        }

        // Client-facing endpoint reflects the gateway bind; all-interface binds use loopback for
        // Flint's local clients while a specific interface remains reachable by that address.
        sharedEndpoint = useGateway
          ? `${formatPublicEndpoint(bindAddr, gateway?.publicPort ?? payload.port)}/v1`
          : `${nativeUrl}/v1`;
        log('info', `Service started; bind=${bindAddr}:${payload.port} `
          + `${useGateway ? `via gateway → 127.0.0.1:${nativePort} ` : ''}connect=${sharedEndpoint}`);
        healthRing.record({
          kind: 'service-start',
          bind: bindAddr,
          port: payload.port,
          endpoint: sharedEndpoint,
          ok: true,
        });
        audit('startService', {
          port: payload.port,
          bindAddress: bindAddr,
          endpoint: sharedEndpoint,
          gateway: useGateway,
          deferCatalogRead: payload.deferCatalogRead === true,
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
      } catch (e) {
        healthRing.record({
          kind: 'service-start',
          bind: bindAddr,
          port: payload.port,
          ok: false,
          error: String(e?.message ?? e),
        });
        await rollbackPartialServiceStart();
        throw e;
      }
    } else if (cmd === 'stopService') {
      await stopGateway();
      let nativeStopError = null;
      try {
        stopNativeWebService(); // synchronous
      } catch (e) {
        nativeStopError = e;
        log('warn', `stopWebService error: ${e?.message ?? e}`);
      }
      clearPublishedService();
      tokenAccumulator.clear();
      if (nativeStopError) {
        const message = (
          `The service endpoint was withdrawn, but native listener termination is unconfirmed: ${
            nativeStopError?.message ?? nativeStopError
          }`
        );
        healthRing.record({ kind: 'service-stop', ok: false, error: message });
        audit('stopService', { ok: false, error: message });
        throw new Error(message, { cause: nativeStopError });
      }
      log('info', 'Service stopped');
      healthRing.record({ kind: 'service-stop', ok: true });
      audit('stopService', { ok: true });
      reply({ ok: true });
    } else if (cmd === 'stopAndUnload') {
      const drainTimeoutMs = payload.drainTimeoutMs === undefined
        ? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS
        : Math.floor(payload.drainTimeoutMs);
      const result = await performRuntimeCleanup(drainTimeoutMs);
      audit('stopAndUnload', result);
      reply({ ok: true, result });
    } else if (cmd === 'shutdownRuntime') {
      const drainTimeoutMs = payload.drainTimeoutMs === undefined
        ? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS
        : Math.floor(payload.drainTimeoutMs);
      const result = await performRuntimeShutdown(drainTimeoutMs);
      audit('shutdownRuntime', result);
      log(
        result.cleanup === 'confirmed' ? 'info' : 'warn',
        `Runtime shutdown cleanup=${result.cleanup} active=${result.activeOperations.length}`,
      );
      reply({ ok: true, result }, () => {
        void flushDiskLog().finally(() => process.exit(0));
      });
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
          // True while the gateway is refusing new admission for a benchmark run. Surfaced here
          // (not only readable via the setBenchmarkExclusive reply) so a freshly-loaded frontend
          // -- whose in-memory generation/retrier state always starts unset, since it has no
          // persistence of its own -- can detect and reconcile a flag left set by a page instance
          // that reloaded/crashed before releasing it; this sidecar process outlives that reload.
          benchmarkExclusive,
          // Highest `applyMemorySettings` client `seq` installed so far (see its declaration).
          // A freshly-loaded frontend's own `pushMemorySeq` counter always restarts at 0, but
          // this sidecar process (and this watermark) survive a reload -- without seeding the
          // new page's counter from this value, its first several pushes would carry a `seq`
          // at or below this watermark and be silently accepted-but-skipped (`stale: true`) by
          // the guard below, with the page having no indication that its pin/eviction-settings
          // push did not actually take effect.
          lastAppliedMemorySettingsSeq,
        }
      });
    } else if (cmd === 'chatCompletion') {
      const modelAlias = payload.model;
      const shouldStream = !!payload.stream;
      canceledRequests.delete(id);
      log('debug', `Chat completion: model=${modelAlias} msgs=${payload.messages?.length ?? 0} stream=${shouldStream}`);
      const chatAccessTs = Date.now();
      let chatTokensIn = null, chatTokensOut = null, chatOk = false;
      let chatLoadMs = null, chatFirstTokenAt = null;
      let chatVariantId = null, chatExecutionProvider = null;
      let chatModelForMetrics = null;
      let chatWarm = null;
      const chatBooking = noteActivity(modelAlias, 'start');
      if (!chatBooking) {
        throw new Error(`Cannot use ${modelAlias} while it is being unloaded or deleted. Retry shortly.`);
      }
      activeStreamCount++;
      if (!activeStreamOldest) activeStreamOldest = { type: 'chat', modelAlias, startedAt: chatAccessTs };
      try {
        const loadStartedAt = Date.now();
        const poolEntry = await ensureModel(modelAlias);
        chatLoadMs = poolEntry.loadedNow === true
          ? Date.now() - loadStartedAt
          : poolEntry.loadedNow === false ? 0 : null;
        chatWarm = poolEntry.loadedNow === true
          ? false
          : poolEntry.loadedNow === false ? true : null;
        chatVariantId = poolEntry.variantId ?? null;
        const chatModel = poolEntry.catModel;
        chatModelForMetrics = chatModel;
        const apiBase = getNativeOpenAiApiBase();
        const preferred = await applyPreferredExecutionProvider(payload.preferredEp, chatModel);

        const sdkMessages = toSdkMessages(payload.messages);
        if (!sdkMessages.length) {
          throw new Error('No valid messages supplied');
        }

        // Prefer direct SDK inference to avoid web-service schema/version mismatch issues.
        // Vision is the exception: the SDK client rejects non-string content outright, so a
        // multipart request has to take the HTTP endpoint or it cannot be served at all.
        // Resolve the ChatSession-backed replacement (see createSessionChatClient) before
        // transport selection: this SDK build may no longer export createChatClient() at all
        // (removed end of 2026), so transport availability must reflect either path, not just
        // the deprecated one.
        let sessionChatClient = null;
        try {
          const sdkModule = await getFoundrySdkModule();
          sessionChatClient = createSessionChatClient(chatModel, sdkModule);
        } catch (err) {
          log('debug', `ChatSession client unavailable, using createChatClient(): ${err?.message || err}`);
        }
        const hasChatClient = sessionChatClient || typeof chatModel?.createChatClient === 'function';
        const { transport, reason: transportReason } = selectChatTransport(sdkMessages, {
          chatClient: hasChatClient ? 'available' : 'unsupported',
          serviceEndpoint: sharedEndpoint ? 'available' : 'unavailable',
        });
        if (!transport) throw new Error(transportReason);
        if (transport === 'sdk') {
          const client = sessionChatClient || chatModel.createChatClient();
          // SDK reads generation params from client.settings, not completeChat args.
          // Omit unset fields so the model's own defaults are not overwritten.
          if (client?.settings && Number.isFinite(payload.temperature)) {
            client.settings.temperature = payload.temperature;
          }
          if (client?.settings && Number.isFinite(payload.maxTokens)) {
            client.settings.maxTokens = payload.maxTokens;
          }
          if (shouldStream && typeof client?.completeStreamingChat === 'function') {
            let content = '';
            const toolCalls = [];
            for await (const chunk of client.completeStreamingChat(
              sdkMessages,
              payload.tools,
              { toolChoice: payload.toolChoice, responseFormat: payload.responseFormat },
            )) {
              const usage = chunk?.usage;
              chatTokensIn = usage?.prompt_tokens ?? usage?.input_tokens ?? chatTokensIn;
              chatTokensOut = usage?.completion_tokens ?? usage?.output_tokens ?? chatTokensOut;
              mergeToolCallDeltas(toolCalls, chunk?.choices?.[0]?.delta?.tool_calls);
              if (canceledRequests.has(id)) continue;
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
                chatFirstTokenAt ??= Date.now();
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
            chatExecutionProvider = await detectActiveExecutionProvider(chatModel);
            reply({
              ok: true,
              result: {
                ...normalizeChatResponse({
                  choices: [{
                    message: {
                      role: 'assistant',
                      content,
                      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                    },
                  }],
                  ...(typeof chatTokensIn === 'number' || typeof chatTokensOut === 'number'
                    ? {
                        usage: {
                          ...(typeof chatTokensIn === 'number' ? { prompt_tokens: chatTokensIn } : {}),
                          ...(typeof chatTokensOut === 'number' ? { completion_tokens: chatTokensOut } : {}),
                        },
                      }
                    : {}),
                }),
                acceleration: {
                  requested: preferred?.requested ?? null,
                  preferredApplied: preferred?.applied ?? null,
                  active: chatExecutionProvider
                },
                // True per-token delivery; emulated single-delta branches below must not
                // be treated as time-to-first-token.
                nativeStreaming: shouldStream,
                servedVariantId: chatVariantId
              }
            });
          } else if (typeof client?.completeChat === 'function') {
            const result = await client.completeChat(
              sdkMessages,
              payload.tools,
              { toolChoice: payload.toolChoice, responseFormat: payload.responseFormat },
            );
            const normalizedResult = normalizeChatResponse(result);
            chatTokensIn = normalizedResult?.usage?.prompt_tokens
              ?? normalizedResult?.usage?.input_tokens ?? null;
            chatTokensOut = normalizedResult?.usage?.completion_tokens
              ?? normalizedResult?.usage?.output_tokens ?? null;
            if (shouldStream && !canceledRequests.has(id)) {
              const content = normalizedResult?.choices?.[0]?.message?.content || '';
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
            chatExecutionProvider = await detectActiveExecutionProvider(chatModel);
            reply({
              ok: true,
              result: {
                ...normalizedResult,
                acceleration: {
                  requested: preferred?.requested ?? null,
                  preferredApplied: preferred?.applied ?? null,
                  active: chatExecutionProvider
                },
                // Emulated: the whole response was buffered, then one synthetic delta.
                nativeStreaming: false,
                servedVariantId: chatVariantId
              }
            });
          } else if (typeof client?.completeStreamingChat === 'function') {
            let content = '';
            const toolCalls = [];
            for await (const chunk of client.completeStreamingChat(
              sdkMessages,
              payload.tools,
              { toolChoice: payload.toolChoice, responseFormat: payload.responseFormat },
            )) {
              const usage = chunk?.usage;
              chatTokensIn = usage?.prompt_tokens ?? usage?.input_tokens ?? chatTokensIn;
              chatTokensOut = usage?.completion_tokens ?? usage?.output_tokens ?? chatTokensOut;
              mergeToolCallDeltas(toolCalls, chunk?.choices?.[0]?.delta?.tool_calls);
              if (canceledRequests.has(id)) continue;
              const delta = chunk?.choices?.[0]?.delta?.content || '';
              if (delta) {
                chatFirstTokenAt ??= Date.now();
                content += delta;
              }
            }
            chatOk = true;
            chatExecutionProvider = await detectActiveExecutionProvider(chatModel);
            reply({
              ok: true,
              result: {
                ...normalizeChatResponse({
                  choices: [{
                    message: {
                      role: 'assistant',
                      content,
                      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                    },
                  }],
                  ...(typeof chatTokensIn === 'number' || typeof chatTokensOut === 'number'
                    ? {
                        usage: {
                          ...(typeof chatTokensIn === 'number' ? { prompt_tokens: chatTokensIn } : {}),
                          ...(typeof chatTokensOut === 'number' ? { completion_tokens: chatTokensOut } : {}),
                        },
                      }
                    : {}),
                }),
                acceleration: {
                  requested: preferred?.requested ?? null,
                  preferredApplied: preferred?.applied ?? null,
                  active: chatExecutionProvider
                },
                // Buffered here regardless of what the caller asked for.
                nativeStreaming: false,
                servedVariantId: chatVariantId
              }
            });
          } else {
            throw new Error('Model chat client does not expose completion methods');
          }
        } else {
          const resp = await fetch(`${apiBase}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: poolEntry.variantId,
              messages: sdkMessages,
              stream: false,
              max_tokens: payload.maxTokens,
              temperature: payload.temperature,
              ...(payload.tools ? { tools: payload.tools } : {}),
              ...(payload.toolChoice !== undefined ? { tool_choice: payload.toolChoice } : {}),
              ...(payload.responseFormat !== undefined ? { response_format: payload.responseFormat } : {}),
            })
          });
          if (!resp.ok) {
            const details = await readErrorBody(resp);
            throw new Error(`Chat completion failed (${resp.status} ${resp.statusText}): ${details}`);
          }
          const httpResult = await resp.json();
          const normalizedHttpResult = normalizeChatResponse(httpResult);
          chatTokensIn = normalizedHttpResult?.usage?.prompt_tokens
            ?? normalizedHttpResult?.usage?.input_tokens ?? null;
          chatTokensOut = normalizedHttpResult?.usage?.completion_tokens
            ?? normalizedHttpResult?.usage?.output_tokens ?? null;
          // This response is not streamed, but a caller that asked for a stream is waiting on
          // deltas to render. Emitting the whole text as one delta keeps the streaming
          // contract, exactly as the non-streaming SDK branch above does.
          if (shouldStream && !canceledRequests.has(id)) {
            const content = normalizedHttpResult?.choices?.[0]?.message?.content || '';
            if (content) {
              send({
                id,
                stream: true,
                delta: content,
                chunk: { choices: [{ delta: { role: 'assistant', content } }] }
              });
            }
          }
          chatOk = true;
          chatExecutionProvider = await detectActiveExecutionProvider(chatModel);
          reply({
            ok: true,
            result: {
              ...normalizedHttpResult,
              acceleration: {
                requested: preferred?.requested ?? null,
                preferredApplied: preferred?.applied ?? null,
                active: chatExecutionProvider
              },
              // HTTP always requests stream:false; any delta above is one emulated chunk.
              nativeStreaming: false,
              servedVariantId: chatVariantId
            }
          });
        }
      } finally {
        if (chatModelForMetrics && !chatExecutionProvider) {
          try {
            chatExecutionProvider = await detectActiveExecutionProvider(chatModelForMetrics);
          } catch (err) {
            log('warn', `Execution provider probe failed during chat cleanup: ${err?.message || err}`);
          }
        }
        activeStreamCount = Math.max(0, activeStreamCount - 1);
        if (activeStreamCount === 0) activeStreamOldest = null;
        noteActivity(modelAlias, 'end', chatBooking);
        canceledRequests.delete(id);
        appendAccessLog({
          ts: chatAccessTs,
          type: 'chat',
          modelAlias,
          ...buildInferenceMetrics({
            startedAt: chatAccessTs,
            loadMs: chatLoadMs,
            firstTokenAt: chatFirstTokenAt,
            completedAt: Date.now(),
            tokensIn: chatTokensIn,
            tokensOut: chatTokensOut,
            variantId: chatVariantId,
            executionProvider: chatExecutionProvider,
            warm: chatWarm,
          }),
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
      const audioAccessTs = Date.now();
      let audioOk = false;
      const audioBooking = noteActivity(requestedAlias, 'start');
      if (!audioBooking) {
        throw new Error(`Cannot use ${requestedAlias} while it is being unloaded or deleted. Retry shortly.`);
      }
      let tempPath = null;
      activeStreamCount++;
      if (!activeStreamOldest) activeStreamOldest = { type: 'audio', modelAlias: requestedAlias, startedAt: audioAccessTs };
      try {
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
        tempPath = path.join(os.tmpdir(), tempFileName);
        await fs.promises.writeFile(tempPath, bytes);

        // Try the new Session/Request/Item AudioSession API first (see tryAudioSessionTranscription
        // for scope/limitations); any failure falls back to the legacy AudioClient/HTTP paths below
        // unchanged, so this is purely additive for models where it already works (Whisper family).
        let sdkModule = null;
        try {
          sdkModule = await getFoundrySdkModule();
        } catch (err) {
          log('debug', `AudioSession: could not resolve SDK module (${err?.message || err})`);
        }
        const audioSessionSupport = audioSessionUriSupport(audioModel);
        if (sdkModule && audioSessionSupport !== 'unsupported') {
          const attempt = await tryAudioSessionTranscription(sdkModule, audioModel, tempPath, payload);
          if (attempt.ok) {
            const result = buildTranscriptResult(attempt.candidate, {
              transcriptionPath: 'audioSession'
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
          log('debug', `AudioSession transcription unavailable, using legacy path: ${attempt.reason}`);
        } else if (audioSessionSupport === 'unsupported') {
          log('debug', 'AudioSession URI path is not supported for this speech model family; using legacy path');
        }

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
        const apiBase = getNativeOpenAiApiBase();
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
        noteActivity(requestedAlias, 'end', audioBooking);
        if (tempPath) {
          try { fs.unlinkSync(tempPath); } catch {}
        }
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
      // Independent hardware probes run beside catalog telemetry, not after its
      // deadline: either can consume 10 seconds within the 20-second IPC budget.
      const acceleratorMemory = collectAcceleratorMemory().catch((error) => {
        log('warn', `Accelerator memory probe failed: ${error?.message || error}`);
        return accelMemCache?.devices ?? [];
      });
      let loadedIds = new Set();
      const snapshotConfirmed = catalogReadConfirmed();
      let loadedStateKnown = false;
      try {
        // Automatic telemetry must not become the first catalog access: doing so
        // would freeze the snapshot and disable useful registration retries.
        // After getModels confirms the snapshot, track this native read so local
        // catalog mutations cannot overlap its scan.
        const loaded = snapshotConfirmed
          ? await readCatalogTelemetry(() => manager.catalog.getLoadedModels())
          : [];
        for (const m of loaded) loadedIds.add(m.id);
        if (snapshotConfirmed) loadedStateKnown = true;
      } catch (error) {
        log('warn', `Loaded-model telemetry unavailable: ${error?.message || error}`);
      }
      const entries = [...pool.entries()].map(([alias, { variantId }]) => {
        const use = usageFor(alias);
        return {
          alias,
          variantId,
          // Pool entries are created only after load succeeds and removed on
          // unload. Before the public snapshot is confirmed, avoid a native
          // catalog read but still report the state this sidecar owns.
          isLoaded: snapshotConfirmed
            ? (loadedStateKnown ? loadedIds.has(variantId) : null)
            : true,
          lastUsedAt: use.lastUsedAt,
          inFlight: inFlightFor(alias),
          priority: normalizePriority(modelPriorities.get(alias)),
        };
      });
      const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
      const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
      const accelerators = await acceleratorMemory;
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
    } else if (cmd === 'getCacheInventory') {
      reply({ ok: true, result: await getCacheInventory() });
    } else if (cmd === 'setBenchmarkExclusive') {
      // Page-local busy flags cannot see OpenAI-gateway clients, and cannot see IPC calls left
      // running by a *previous*, now-gone page instance either (this sidecar outlives a reload).
      // Exclusive admission lives here: new gateway work is rejected, and already-admitted
      // gateway requests, inference (chatCompletion/transcribeAudio/embedTexts), and resident-
      // pool mutations (load/unload/deleteModel/startService) all drain before this resolves.
      // An in-flight download is refused up front instead of drained — see
      // `BENCHMARK_DRAIN_COMMANDS`. New IPC chat/load calls (the benchmark's own) still run
      // once granted.
      // Serialized (see serializeBenchmarkExclusiveTransition) so a concurrently-dispatched
      // release cannot clear the flag out from under an in-progress acquire's drain wait.
      await serializeBenchmarkExclusiveTransition(async () => {
        if (payload.exclusive === true) {
          // Flag first, synchronously, so a download that has not yet been admitted is
          // rejected above instead of slipping in during the check below.
          benchmarkExclusive = true;
          if (downloadInFlight()) {
            benchmarkExclusive = false;
            reply({ error: 'A model download is still in progress. Wait for it to finish before starting a benchmark.' });
            return;
          }
          const drained = await waitForBenchmarkDrainIdle(BENCHMARK_EXCLUSIVE_DRAIN_MS);
          if (!drained) {
            benchmarkExclusive = false;
            reply({ error: 'Could not drain in-flight gateway/inference/pool-mutation operations before taking exclusive admission' });
            return;
          }
          reply({ ok: true, result: { exclusive: true, drained: true } });
        } else {
          benchmarkExclusive = false;
          reply({ ok: true, result: { exclusive: false } });
        }
      });
    } else if (cmd === 'setEvictionConfig') {
      // Apply immediately: a user who has just lowered the cap expects the pool to shrink
      // now, not at some point in the next half minute.
      const evicted = await installAndSweep(() => installEvictionConfig(payload));
      reply({ ok: true, result: { config: { ...evictionConfig }, evicted } });
    } else if (cmd === 'setModelPriorities') {
      // A model that just became evictable should not wait for the next sweep.
      const evicted = await installAndSweep(() => installModelPriorities(payload.priorities));
      reply({
        ok: true,
        result: {
          priorities: [...modelPriorities.entries()].map(([alias, priority]) => ({ alias, priority })),
          evicted,
        },
      });
    } else if (cmd === 'applyMemorySettings') {
      // Both settings, then exactly one sweep. Sending them as two commands means the first
      // sweep runs under half-old settings — enough to evict a model the user just pinned, or
      // to evict under a cap they were in the process of raising.
      //
      // The seq check and the install must share one lock acquisition: checking, then installing
      // in a second, separately-queued `withSweepLock` call would let two calls both pass the
      // check before either updates `lastAppliedMemorySettingsSeq`, defeating the guard exactly
      // when it matters (two nearly-simultaneous, out-of-order arrivals).
      const seq = typeof payload.seq === 'number' ? payload.seq : null;
      const { evicted, stale } = await withSweepLock(async () => {
        if (seq !== null && seq <= lastAppliedMemorySettingsSeq) {
          return { evicted: [], stale: true };
        }
        if (seq !== null) lastAppliedMemorySettingsSeq = seq;
        installModelPriorities(payload.priorities);
        if (payload.eviction !== undefined) installEvictionConfig(payload.eviction);
        return { evicted: await runEvictionSweepLocked(), stale: false };
      });
      reply({
        ok: true,
        result: {
          config: { ...evictionConfig },
          priorities: [...modelPriorities.entries()].map(([alias, priority]) => ({ alias, priority })),
          evicted,
          stale,
        },
      });
    } else if (cmd === 'getAccessLog') {
      reply({ ok: true, result: accessLog });
    } else if (cmd === 'getHealthRing') {
      reply({ ok: true, result: healthRing.snapshot() });
    } else if (cmd === 'fetchUrl') {
      const fetchTs = Date.now();
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
        const raw = await fetchBoundedResponseText(fetch, rawUrl, {
          maxBytes: DEFAULT_FETCH_BODY_LIMIT,
          headers: { 'User-Agent': 'Flint/0.3 (local-AI-client; +https://github.com/joelst/flint)' },
          redirect: 'follow',
        });

        const contentType = raw.response.headers.get('content-type') || '';
        const capped = raw.text;

        let title = '';
        let extractedText = '';

        if (contentType.includes('text/html')) {
          // Dynamically import jsdom + readability (both ship in node_modules)
          const { JSDOM } = await import('jsdom');
          const { Readability } = await import('@mozilla/readability');
          const dom = new JSDOM(capped, { url: rawUrl });
          title = dom.window.document.title?.trim() || '';
          const reader = new Readability(dom.window.document, { charThreshold: 50 });
          const article = reader.parse();
          if (article) {
            title = article.title?.trim() || title;
            extractedText = article.textContent?.replace(/\s+/g, ' ').trim() || '';
          } else {
            extractedText = dom.window.document.body?.textContent?.replace(/\s+/g, ' ').trim() || '';
          }
        } else {
          extractedText = capped.replace(/\s+/g, ' ').trim();
        }

        const truncated = raw.truncated || extractedText.length > maxChars;
        const finalText = extractedText.length > maxChars
          ? extractedText.slice(0, maxChars)
          : extractedText;

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
    } else if (cmd === 'embedTexts') {
      const inputs = payload.inputs;
      const modelAlias = payload.model;
      const embedTs = Date.now();
      let embedOk = false;
      const embedBooking = noteActivity(modelAlias, 'start');
      if (!embedBooking) {
        throw new Error(`Cannot use ${modelAlias} while it is being unloaded or deleted. Retry shortly.`);
      }
      try {
        const poolEntry = await ensureModel(modelAlias);
        const embedModel = poolEntry.catModel;
        // Prefer the EmbeddingsSession-backed replacement (see createSessionEmbeddingClient)
        // over the deprecated createEmbeddingClient() wrapper it mirrors, removed end of 2026.
        // Falls back to createEmbeddingClient() unchanged on any SDK build that doesn't export
        // EmbeddingsSession/Request/Item.
        let client = null;
        try {
          const sdkModule = await getFoundrySdkModule();
          client = createSessionEmbeddingClient(embedModel, sdkModule);
        } catch (err) {
          log('debug', `EmbeddingsSession client unavailable, using createEmbeddingClient(): ${err?.message || err}`);
        }
        if (!client) {
          if (typeof embedModel?.createEmbeddingClient !== 'function') {
            throw new Error(`Model ${modelAlias} does not expose createEmbeddingClient`);
          }
          client = embedModel.createEmbeddingClient();
        }
        const result = await client.generateEmbeddings(inputs);
        embedOk = true;
        audit('embedTexts', { alias: modelAlias, count: inputs.length });
        reply({ ok: true, result });
      } finally {
        noteActivity(modelAlias, 'end', embedBooking);
        appendAccessLog({
          ts: embedTs,
          type: 'embeddings',
          modelAlias,
          durationMs: Date.now() - embedTs,
          tokensIn: null,
          tokensOut: null,
          source: 'ipc',
          ok: embedOk,
        });
      }
    } else if (cmd === 'getEps') {
      const eps = await readExecutionProviders(
        () => typeof manager.discoverEps === 'function' ? manager.discoverEps() : [],
      );
      reply({ ok: true, result: eps });
    } else if (cmd === 'ensureAccelerators') {
      if (typeof manager.downloadAndRegisterEps === 'function') {
        const progress = reportCatalogProgress;
        const rebuild = payload.rebuildBroken === true ? async (onProgress) => {
          const epRoot = path.join(os.homedir(), `.${initConfig?.appName || 'flint'}`, 'ep');
          const outcome = await rebuildBrokenExecutionProviders({
            discover: () => (typeof manager.discoverEps === 'function' ? manager.discoverEps() : []),
            downloadAndRegister: (names, onProgress) => manager.downloadAndRegisterEps(names, onProgress),
            removeCache: (name) => removeProviderCache(epRoot, name),
            onProgress,
            epRoot,
          });
          if (outcome.removed.length) {
            log('info', `Removed broken execution provider cache: ${outcome.removed.join(', ')}`);
          }
          if (outcome.busy.length) {
            log('warn', `Left execution provider cache in place because a file is in use: ${outcome.busy.join(', ')}`);
          }
          return {
            ...(outcome.result ?? {}),
            attemptedProviderRebuilds: outcome.attempted,
            removedProviderCaches: outcome.removed,
            busyProviderCaches: outcome.busy,
          };
        } : undefined;
        const result = await rerunAcceleratorRegistration(progress, rebuild);
        reply({ ok: true, result: result ?? null });
      } else {
        reply({ ok: true, result: null });
      }
    } else if (cmd === 'setLogLevel') {
      if (!LOG_LEVELS.includes(payload.level)) {
        throw new Error(`Unsupported log level "${payload.level}". Expected one of: ${LOG_LEVELS.join(', ')}`);
      }
      if (initConfig && payload.level !== initConfig.logLevel) {
        throw new Error(
          `Native log level is fixed at runtime initialization (${initConfig.logLevel}); restart the runtime to change it.`,
        );
      }
      activeLogLevel = payload.level;
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
  } finally {
    if (operationAdmitted) operationAdmission.complete(id);
    releaseServiceTransition?.();
  }
});

let shutdownExitScheduled = false;

function shutdownAfterInputClosed (reason) {
  if (shutdownExitScheduled) return;
  shutdownExitScheduled = true;
  writeToDisk({
    type: 'log',
    level: 'info',
    message: `Runtime shutdown requested by ${reason}`,
    timestamp: Date.now(),
  });
  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  void performRuntimeShutdown()
    .then(() => {
      if (!explicitShutdownInProgress) {
        void flushDiskLog().finally(() => process.exit(0));
      }
    }, () => {
      if (!explicitShutdownInProgress) {
        void flushDiskLog().finally(() => process.exit(1));
      }
    });
}

rl.on('close', () => shutdownAfterInputClosed('stdin close'));
process.once('SIGTERM', () => shutdownAfterInputClosed('SIGTERM'));
process.once('SIGINT', () => shutdownAfterInputClosed('SIGINT'));

// initDiskLog opens today's log file and prunes files older than 7 days.
initDiskLog();

// Send ready as early as possible (after readline setup) so the host does not time out.
// We lazy-load the heavy Foundry SDK only on first 'init' command.
const readyMsg = {
  ready: true,
  protocolVersion: SIDECAR_PROTOCOL_VERSION,
  pid: process.pid,
  version: '0.1.0',
};
send(readyMsg);
log('info', `Sidecar process started (pid ${process.pid}) and listening`);