// Isolated Foundry Local SDK 2.1.0 spike. See docs/spikes/foundry-2.1.0-spike.md.
//
// Installs and loads the SDK outside this repo. It does not read or write
// Flint's node_modules. After a model loads, it starts Foundry's own listener
// on the port the SDK chooses and runs scripts/openai-live.mjs against it.
//
// --self-test checks this file's bookkeeping and does not load Foundry.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  COLOR_TOOL,
  READY_PROMPT,
  TOOL_PROMPT,
  judgeToolCall,
  mergeToolDeltas,
  runOpenAiLive,
  secondTurnMessages,
  waitForHttpOk,
} from './openai-live.mjs';

const SDK_SPEC = 'foundry-local-sdk@2.1.0';
const APP_NAME = 'flint-spike-210';
const ALIAS = 'flint-spike-model:1';
const LISTING_CAP = 5000;
const LARGE_FOLDER_BYTES = 10_000_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {
    install: false,
    model: null,
    keep: false,
    force: false,
    work: path.join(os.tmpdir(), 'flint-foundry-210-spike'),
    task: 'chat-completion',
    ep: 'CPUExecutionProvider',
    context: 4096,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--install') out.install = true;
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--work') out.work = path.resolve(argv[++i] ?? '');
    else if (arg === '--model') out.model = path.resolve(argv[++i] ?? '');
    else if (arg === '--task') out.task = requiredText(argv[++i], '--task');
    else if (arg === '--ep') out.ep = requiredText(argv[++i], '--ep');
    else if (arg === '--context') out.context = requiredInt(argv[++i], '--context');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function requiredText(value, flag) {
  if (!value) throw new Error(`${flag} needs a value`);
  return value;
}

function requiredInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function flintIsRunning() {
  if (process.platform !== 'win32') return false;
  const listed = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Flint.exe', '/NH'], { encoding: 'utf8' });
  return /Flint\.exe/i.test(listed);
}

function assertWorkDir(work) {
  const resolved = path.resolve(work);
  const relative = path.relative(repoRoot, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`Work directory must sit outside the Flint repo: ${resolved}`);
  }
  return resolved;
}

function walkPrototype(value, visit) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
  let current = value;
  while (current && current !== Object.prototype && current !== Function.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === 'constructor') continue;
      visit(current, name);
    }
    current = Object.getPrototypeOf(current);
  }
}

function methodNames(value) {
  const names = new Set();
  walkPrototype(value, (current, name) => {
    const desc = Object.getOwnPropertyDescriptor(current, name);
    if (typeof desc?.value === 'function') names.add(name);
  });
  return [...names].sort();
}

function accessorNames(value) {
  const names = new Set();
  walkPrototype(value, (current, name) => {
    const desc = Object.getOwnPropertyDescriptor(current, name);
    if (typeof desc?.get === 'function') names.add(name);
  });
  return [...names].sort();
}

function interesting(names) {
  return names.filter((name) => /register|unregister|catalog|session|tool|chat|modelinfo/i.test(name));
}

function folderListing(root) {
  const rows = [];
  const seen = new Set();
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop();
    const abs = path.join(root, rel);
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { /* keep the logical path */ }
    if (seen.has(real)) continue;
    seen.add(real);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) {
        const stat = fs.statSync(path.join(root, child));
        rows.push({ path: child.replaceAll('\\', '/'), size: stat.size, mtimeMs: stat.mtimeMs });
        if (rows.length > LISTING_CAP) {
          throw new Error(`Folder listing stopped at ${LISTING_CAP} files: ${root}`);
        }
      }
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return { fileCount: 0, totalBytes: 0, rows: [] };
  const rows = folderListing(root);
  return {
    fileCount: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + row.size, 0),
    rows,
  };
}

function diffSnapshots(before, after) {
  const beforeMap = new Map(before.rows.map((row) => [row.path, row]));
  const afterMap = new Map(after.rows.map((row) => [row.path, row]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [filePath, row] of afterMap) {
    const prior = beforeMap.get(filePath);
    if (!prior) added.push(filePath);
    else if (prior.size !== row.size || prior.mtimeMs !== row.mtimeMs) changed.push(filePath);
  }
  for (const filePath of beforeMap.keys()) {
    if (!afterMap.has(filePath)) removed.push(filePath);
  }
  return {
    unchanged: added.length === 0 && removed.length === 0 && changed.length === 0,
    fileCount: after.fileCount,
    totalBytes: after.totalBytes,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    added: added.slice(0, 20),
    removed: removed.slice(0, 20),
    changed: changed.slice(0, 20),
  };
}

function cacheMayHoldACopy(sourceBytes, growthBytes) {
  return sourceBytes >= LARGE_FOLDER_BYTES && growthBytes >= sourceBytes * 0.9;
}

function markerStatus(root, rows) {
  const top = fs.readdirSync(root);
  const has = (want) => top.some((name) => name.toLowerCase() === want);
  return {
    genaiConfig: has('genai_config.json'),
    inferenceModel: has('inference_model.json'),
    gguf: rows.some((row) => row.path.toLowerCase().endsWith('.gguf')),
  };
}

function readVersions(sdkDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8'));
  const depsPath = path.join(sdkDir, 'deps_versions.json');
  const deps = fs.existsSync(depsPath) ? JSON.parse(fs.readFileSync(depsPath, 'utf8')) : null;
  const natives = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/onnx|genai/i.test(entry.name)) natives.push(path.relative(sdkDir, abs).replaceAll('\\', '/'));
    }
  };
  walk(path.join(sdkDir, 'prebuilds'));
  return {
    sdkVersion: pkg.version ?? null,
    deps,
    nativeFiles: natives.sort(),
  };
}

function declarationHints(sdkDir) {
  const lines = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !fs.existsSync(dir) || lines.length >= 80) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (lines.length >= 80) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.d.ts')) continue;
      const rel = path.relative(sdkDir, abs).replaceAll('\\', '/');
      for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
        if (!/register|unregister|localCatalog|LocalCatalog|createModelInfo|setStringProperty|setIntProperty|ModelInfo/i.test(line)) continue;
        lines.push(`${rel}: ${line.trim()}`);
        if (lines.length >= 80) return;
      }
    }
  };
  walk(path.join(sdkDir, 'dist'), 0);
  return lines;
}

function describeSurface(label, value) {
  const methods = methodNames(value);
  let catalogName = null;
  try {
    if (value && typeof value.name === 'string') catalogName = value.name;
  } catch {
    catalogName = null;
  }
  return {
    label,
    value,
    methods,
    accessors: accessorNames(value),
    interesting: interesting(methods),
    catalogName,
  };
}

function readCatalog(manager, prop) {
  let value;
  try {
    value = manager[prop];
  } catch (error) {
    return { label: `manager.${prop}`, error: error?.message ?? String(error) };
  }
  if (typeof value === 'function' && /^(localCatalog|getLocalCatalog|local_catalog)$/.test(prop)) {
    try {
      value = value.call(manager);
    } catch (error) {
      return { label: `manager.${prop}()`, error: error?.message ?? String(error) };
    }
  }
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  return describeSurface(typeof manager[prop] === 'function' ? `manager.${prop}()` : `manager.${prop}`, value);
}

function catalogSurfaces(manager, catalogType) {
  const surfaces = [describeSurface('manager', manager)];
  const errors = [];
  for (const prop of ['catalog', 'localCatalog', 'local_catalog', 'getLocalCatalog']) {
    const surface = readCatalog(manager, prop);
    if (!surface) continue;
    if (surface.value) surfaces.push(surface);
    else if (surface.error) errors.push({ label: surface.label, error: surface.error });
  }
  if (typeof manager?.getCatalog === 'function' && catalogType) {
    for (const name of ['Local', 'Public']) {
      const type = catalogType[name];
      if (type == null) continue;
      const label = `manager.getCatalog(${name})`;
      try {
        const catalog = manager.getCatalog(type);
        if (catalog) surfaces.push(describeSurface(label, catalog));
      } catch (error) {
        errors.push({ label, error: errorText(error) });
      }
    }
  }
  return { surfaces, errors };
}

function registrationPairs(surfaces) {
  const pairs = [];
  for (const surface of surfaces) {
    const register = surface.methods.find((name) => /^register/i.test(name));
    const unregister = surface.methods.find((name) => /^unregister/i.test(name));
    if (!register) continue;
    pairs.push({
      surface: surface.label,
      register,
      unregister: unregister ?? null,
      target: surface.value,
      catalogName: surface.catalogName ?? null,
    });
  }
  return pairs;
}

function preferRegistration(pairs) {
  return pairs.find((pair) => /local/i.test(pair.surface)) ?? pairs[0] ?? null;
}

function errorText(error) {
  return error?.message ?? String(error);
}

function functionSource(fn) {
  try {
    return Function.prototype.toString.call(fn).slice(0, 400);
  } catch {
    return null;
  }
}

function obtainMetadata(targets) {
  const tried = [];
  for (const target of targets) {
    if (!target) continue;
    for (const name of ['MutableModelInfo', 'ModelInfoBuilder', 'createModelInfo', 'CreateModelInfo', 'ModelInfo']) {
      if (typeof target.value?.[name] !== 'function') continue;
      try {
        const metadata = name === 'createModelInfo' || name === 'CreateModelInfo'
          ? target.value[name]()
          : new target.value[name]();
        tried.push({ surface: target.label, method: name, ok: true, methods: methodNames(metadata) });
        return { metadata, tried };
      } catch (error) {
        tried.push({ surface: target.label, method: name, ok: false, error: errorText(error) });
      }
    }
  }
  return { metadata: null, tried };
}

function applyMetadata(metadata, args) {
  const attempts = [];
  if (!metadata || (typeof metadata !== 'object' && typeof metadata !== 'function')) {
    return { attempts, methods: [] };
  }
  const methods = methodNames(metadata);
  const stringSetter = ['setStringProperty', 'set_string_property'].find((name) => typeof metadata[name] === 'function') ?? null;
  const intSetter = ['setIntProperty', 'set_int_property'].find((name) => typeof metadata[name] === 'function') ?? null;
  const plan = [
    { setter: stringSetter, key: 'task', value: args.task, kind: 'string' },
    { setter: stringSetter, key: 'execution_provider', value: args.ep, kind: 'string' },
    { setter: intSetter, key: 'context_length', value: args.context, kind: 'int' },
  ];
  for (const step of plan) {
    if (!step.setter) {
      attempts.push({ key: step.key, ok: false, error: `no ${step.kind} setter on the metadata object` });
      continue;
    }
    try {
      metadata[step.setter](step.key, step.value);
      attempts.push({ key: step.key, setter: step.setter, value: step.value, ok: true });
    } catch (error) {
      attempts.push({ key: step.key, setter: step.setter, value: step.value, ok: false, error: errorText(error) });
    }
  }
  return { attempts, methods };
}

function looksLikeArityError(text) {
  return /expected \d+|too many arguments|too few arguments|wrong number of arguments/i.test(text);
}

async function quietUnregister(target, name) {
  if (!name || typeof target?.[name] !== 'function') return;
  try {
    await target[name](ALIAS);
  } catch {
    // The failed attempt may not have registered an alias.
  }
}

async function registerAlias(pair, modelPath, metadata) {
  const fn = pair.target[pair.register];
  const attempts = [];
  let model = null;
  const call = async (args, label) => {
    try {
      model = await fn.apply(pair.target, args);
      attempts.push({ label, ok: true });
      return true;
    } catch (error) {
      attempts.push({ label, ok: false, error: errorText(error) });
      await quietUnregister(pair.target, pair.unregister);
      model = null;
      return false;
    }
  };
  if (metadata) {
    const accepted = await call([modelPath, ALIAS, metadata], 'with-metadata');
    const failedAttempt = attempts.at(-1);
    if (!accepted && !looksLikeArityError(failedAttempt?.error ?? '')) {
      await call([modelPath, ALIAS], 'without-metadata');
    }
  } else {
    await call([modelPath, ALIAS], 'without-metadata');
  }
  return { model, attempts, source: functionSource(fn) };
}

function readMaybe(owner, name) {
  try {
    const value = owner?.[name];
    return typeof value === 'function' ? undefined : value;
  } catch (error) {
    return { error: errorText(error) };
  }
}

async function modelFacts(model) {
  const info = readMaybe(model, 'info');
  const runtime = info && typeof info === 'object' ? info.runtime ?? null : null;
  let loaded = null;
  if (typeof model?.isLoaded === 'function') {
    try {
      loaded = await model.isLoaded();
    } catch (error) {
      loaded = { error: errorText(error) };
    }
  }
  return {
    id: readMaybe(model, 'id') ?? null,
    alias: readMaybe(model, 'alias') ?? null,
    path: readMaybe(model, 'path') ?? null,
    contextLength: readMaybe(model, 'contextLength') ?? null,
    supportsToolCalling: readMaybe(model, 'supportsToolCalling') ?? null,
    task: info?.task ?? null,
    executionProvider: info?.executionProvider ?? runtime?.executionProvider ?? null,
    deviceType: info?.deviceType ?? runtime?.deviceType ?? null,
    isLoaded: loaded,
  };
}

function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    promptTokens: usage.promptTokens ?? usage.prompt_tokens ?? null,
    completionTokens: usage.completionTokens ?? usage.completion_tokens ?? null,
    totalTokens: usage.totalTokens ?? usage.total_tokens ?? null,
  };
}

function absorbCompletion(state, parsed) {
  const choice = parsed?.choices?.[0];
  const message = choice?.message;
  const delta = choice?.delta;
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  const content = message?.content ?? delta?.content;
  if (typeof content === 'string' && state.text.length < 4000) state.text += content;
  const calls = message?.tool_calls ?? delta?.tool_calls;
  if (Array.isArray(calls)) state.deltas.push(...calls);
  const usage = mapUsage(parsed?.usage);
  if (usage) state.usage = usage;
}

function absorbItem(state, item) {
  const kind = item?.type ?? 'unknown';
  state.itemTypes[kind] = (state.itemTypes[kind] ?? 0) + 1;
  if (item?.type === 'text' && item.textType === 'openai-json' && typeof item.text === 'string') {
    try {
      absorbCompletion(state, JSON.parse(item.text));
    } catch (error) {
      state.parseError = state.parseError ?? errorText(error);
    }
    return;
  }
  if (item?.type === 'text' && typeof item.text === 'string' && item.textType !== 'reasoning' && state.text.length < 4000) {
    state.text += item.text;
    return;
  }
  if (item?.type === 'toolCall') {
    state.deltas.push({ callId: item.callId, name: item.name, arguments: item.arguments });
    return;
  }
  if (item && Array.isArray(item.choices)) absorbCompletion(state, item);
}

async function collectStream(stream) {
  const state = {
    chunkCount: 0,
    text: '',
    deltas: [],
    usage: null,
    finishReason: null,
    itemTypes: {},
    parseError: null,
    terminalError: null,
  };
  let iterated = false;
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    iterated = true;
    for await (const item of stream) {
      state.chunkCount += 1;
      absorbItem(state, item);
    }
  }
  if (stream?.response && typeof stream.response.then === 'function') {
    try {
      const response = await stream.response;
      if (!iterated) {
        for (const item of response?.output ?? []) absorbItem(state, item);
      }
      state.finishReason = state.finishReason ?? response?.finishReason ?? null;
      state.usage = state.usage ?? mapUsage(response?.usage);
    } catch (error) {
      if (!iterated && state.chunkCount === 0) throw error;
      state.terminalError = errorText(error);
    }
  }
  const toolCalls = mergeToolDeltas(state.deltas).map((call) => ({
    ...call,
    arguments: call.arguments.slice(0, 8000),
  }));
  return {
    chunkCount: state.chunkCount,
    text: state.text.slice(0, 2000),
    toolCalls,
    usage: state.usage,
    finishReason: state.finishReason,
    itemTypes: state.itemTypes,
    parseError: state.parseError,
    terminalError: state.terminalError,
  };
}

function abortAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done() { clearTimeout(timer); } };
}

function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* the original call still owns the failure */ }
      reject(new Error(`Timed out after ${ms} ms`));
    }, ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function sessionStream(session, request, timeoutMs) {
  let handle = null;
  let stream;
  let streamed = true;
  if (typeof session.processStreamingRequest === 'function') {
    try {
      handle = abortAfter(timeoutMs);
      stream = session.processStreamingRequest(request, { signal: handle.signal });
    } catch {
      handle?.done();
      handle = null;
      stream = session.processStreamingRequest(request);
    }
  } else if (typeof session.processRequest === 'function') {
    streamed = false;
    stream = { response: session.processRequest(request) };
  } else {
    throw new Error('ChatSession has neither processStreamingRequest nor processRequest');
  }
  if (stream && typeof stream.then === 'function') stream = await stream;
  try {
    const collected = await collectStream(stream);
    return { streamed, ...collected };
  } finally {
    handle?.done();
  }
}

async function runCompletion(sdk, model, body, timeoutMs) {
  const priorErrors = [];
  if (typeof sdk.ChatSession === 'function' && typeof sdk.Request === 'function' && typeof sdk.Item?.text === 'function') {
    let session;
    try {
      session = new sdk.ChatSession(model);
      const request = new sdk.Request();
      request.addItem(sdk.Item.text(JSON.stringify({ ...body, stream: true }), 'openai-json'));
      const collected = await withTimeout(
        sessionStream(session, request, timeoutMs),
        timeoutMs + 1000,
        () => { try { session.dispose?.(); } catch { /* abort path */ } },
      );
      return { path: collected.streamed ? 'ChatSession.processStreamingRequest' : 'ChatSession.processRequest', ...collected };
    } catch (error) {
      priorErrors.push(`ChatSession: ${errorText(error)}`);
    } finally {
      try { session?.dispose?.(); } catch { /* already disposed */ }
    }
  } else {
    priorErrors.push('ChatSession, Request, or Item.text is not exported');
  }

  if (typeof model?.createChatClient !== 'function') {
    return {
      path: null,
      streamed: false,
      error: priorErrors.join(' | ') || 'no chat method',
      chunkCount: 0,
      text: '',
      toolCalls: [],
      usage: null,
      finishReason: null,
    };
  }
  const client = model.createChatClient();
  try {
    const run = async () => {
      if (typeof client.completeStreamingChat === 'function') {
        const iterable = body.tools
          ? client.completeStreamingChat(body.messages, body.tools)
          : client.completeStreamingChat(body.messages);
        return { path: 'ChatClient.completeStreamingChat', streamed: true, ...(await collectStream(iterable)) };
      }
      if (typeof client.completeChat === 'function') {
        const result = body.tools
          ? await client.completeChat(body.messages, body.tools)
          : await client.completeChat(body.messages);
        const collected = await collectStream({ [Symbol.asyncIterator]: async function* iterate() { yield result; } });
        return { path: 'ChatClient.completeChat', streamed: false, ...collected };
      }
      throw new Error('ChatClient has neither completeStreamingChat nor completeChat');
    };
    const collected = await withTimeout(run(), timeoutMs, () => { try { client.dispose?.(); } catch { /* abort path */ } });
    return { ...collected, priorErrors };
  } catch (error) {
    priorErrors.push(`ChatClient: ${errorText(error)}`);
    return {
      path: null,
      streamed: false,
      error: priorErrors.join(' | '),
      chunkCount: 0,
      text: '',
      toolCalls: [],
      usage: null,
      finishReason: null,
    };
  } finally {
    try { client.dispose?.(); } catch { /* already disposed */ }
  }
}

function publicExportNames(imported) {
  return Object.keys(imported)
    .filter((name) => /catalog|session|request|item|model|register/i.test(name))
    .sort();
}

function summarizeCompletion(result) {
  if (!result) return null;
  if (result.skipped) return { skipped: result.skipped };
  return {
    path: result.path ?? null,
    streamed: result.streamed ?? false,
    text: (result.text || '').slice(0, 160),
    usage: result.usage ?? null,
    finishReason: result.finishReason ?? null,
    error: result.error ?? null,
  };
}

async function lookupAlias(surfaces, alias) {
  const tried = [];
  for (const surface of surfaces) {
    if (typeof surface.value?.getModel !== 'function') continue;
    try {
      const found = await surface.value.getModel(alias);
      tried.push({ surface: surface.label, ok: true, id: readMaybe(found, 'id') ?? null });
      return { found: true, tried };
    } catch (error) {
      tried.push({ surface: surface.label, ok: false, error: errorText(error) });
    }
  }
  return { found: false, tried };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const work = assertWorkDir(args.work);
  if (args.model && (!fs.existsSync(args.model) || !fs.statSync(args.model).isDirectory())) {
    throw new Error(`--model must be an existing directory: ${args.model}`);
  }
  fs.mkdirSync(work, { recursive: true });

  if (args.install) {
    const install = spawnSync('npm', ['install', '--no-fund', '--no-audit', '--prefix', work, SDK_SPEC], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (install.status !== 0) process.exit(install.status ?? 1);
  }

  const sdkDir = path.join(work, 'node_modules', 'foundry-local-sdk');
  if (!fs.existsSync(path.join(sdkDir, 'package.json'))) {
    throw new Error(`SDK is not installed in ${work}. Run with --install first.`);
  }
  if (!args.force && flintIsRunning()) {
    throw new Error('Quit Flint before this spike creates a manager. Pass --force only when you mean to overlap the two runtimes.');
  }

  const versions = readVersions(sdkDir);
  const declarations = declarationHints(sdkDir);
  const sdkEntry = path.join(sdkDir, 'dist', 'index.js');
  const imported = await import(pathToFileURL(fs.existsSync(sdkEntry) ? sdkEntry : path.join(sdkDir, 'package.json')).href);
  const FoundryLocalManager = imported.FoundryLocalManager;
  if (!FoundryLocalManager?.create) throw new Error('FoundryLocalManager.create is missing from the installed package.');

  const cacheDir = path.join(work, 'cache');
  const logsDir = path.join(work, 'logs');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const report = {
    createdAt: new Date().toISOString(),
    work,
    versions,
    declarations,
    exports: publicExportNames(imported),
    surfaces: [],
    registration: null,
    model: null,
    managerError: null,
  };

  let manager = null;
  try {
    const created = FoundryLocalManager.create({
      appName: APP_NAME,
      modelCacheDir: cacheDir,
      logsDir,
      logLevel: 'info',
      disableNonessentialTelemetry: true,
    });
    manager = created && typeof created.then === 'function' ? await created : created;
    const discovered = catalogSurfaces(manager, imported.CatalogType);
    const surfaces = discovered.surfaces;
    report.catalogErrors = discovered.errors;
    report.surfaces = surfaces.map(({ label, methods, accessors, interesting: marked, catalogName }) => ({
      label,
      catalogName,
      methods,
      accessors,
      interesting: marked,
    }));
    const pairs = registrationPairs(surfaces);
    const registration = preferRegistration(pairs);
    report.registrationCandidates = pairs.map(({ surface, register, unregister, catalogName }) => ({
      surface,
      catalogName,
      register,
      unregister,
    }));
    report.registration = registration
      ? {
        surface: registration.surface,
        catalogName: registration.catalogName,
        register: registration.register,
        unregister: registration.unregister,
      }
      : null;

    if (args.model) {
      report.model = await runModel(args, imported, surfaces, registration, cacheDir, manager);
    }
  } catch (error) {
    report.managerError = errorText(error);
  } finally {
    try { manager?.shutdown?.(); } catch { /* the report still records the attempt */ }
    try { manager?.dispose?.(); } catch { /* already shut down */ }
  }

  const outFile = path.join(work, 'inspect.json');
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    sdkVersion: versions.sdkVersion,
    registration: report.registration,
    model: report.model
      ? {
        registered: report.model.registered ?? false,
        metadataAttempts: report.model.metadataAttempts ?? null,
        markers: report.model.markers ?? null,
        folderUnchanged: report.model.folder?.afterCleanup?.unchanged === true
          && report.model.folder?.afterRegister?.unchanged !== false
          && report.model.folder?.afterUse?.unchanged !== false,
        cacheGrowthBytes: report.model.cache?.afterUseGrowthBytes ?? report.model.cache?.growthBytes ?? null,
        cacheMayHoldACopy: report.model.cache?.mayHoldACopy ?? null,
        facts: report.model.facts ?? null,
        openai: report.model.openai
          ? {
            requiredOk: report.model.openai.requiredOk ?? null,
            url: report.model.openai.url ?? null,
            checks: (report.model.openai.checks ?? []).map((item) => ({
              name: item.name,
              ok: item.ok,
              required: item.required,
              detail: typeof item.detail === 'string' ? item.detail.slice(0, 160) : null,
            })),
            error: report.model.openai.error ?? null,
          }
          : null,
        chat: summarizeCompletion(report.model.chat),
        toolCall: report.model.toolCall
          ? {
            path: report.model.toolCall.path ?? null,
            streamed: report.model.toolCall.streamed ?? false,
            judgment: report.model.toolCall.judgment ?? null,
            secondTurn: summarizeCompletion(report.model.toolCall.secondTurn),
            error: report.model.toolCall.error ?? null,
          }
          : null,
        error: report.model.error ?? null,
      }
      : null,
    managerError: report.managerError,
    wrote: outFile,
  }, null, 2));

  if (versions.sdkVersion !== '2.1.0' || report.managerError) process.exitCode = 2;
  if (args.model && !report.model?.registered) process.exitCode = 2;
  if (args.model && report.model?.openai?.requiredOk === false) process.exitCode = 2;
}

async function runFoundryOpenAi(manager, modelId) {
  if (typeof manager?.startWebService !== 'function') {
    return { error: 'startWebService is missing on this manager' };
  }
  let started = false;
  try {
    manager.startWebService();
    started = true;
    const raw = Array.isArray(manager.urls) ? manager.urls[0] : null;
    if (!raw) return { error: 'The web service started and reported no URL.' };
    const origin = new URL(raw).origin;
    const ready = await waitForHttpOk(`${origin}/status`);
    if (!ready.ok) return { url: raw, error: `Service was not ready: ${ready.error}` };
    const live = await runOpenAiLive({ base: `${origin}/v1`, model: modelId, timeoutMs: 180_000 });
    return { url: `${origin}/v1`, ...live };
  } catch (error) {
    return { error: errorText(error) };
  } finally {
    if (started) {
      try { manager.stopWebService?.(); } catch { /* unload still runs */ }
    }
  }
}

async function runModel(args, sdk, surfaces, registration, cacheDir, manager) {
  const sourceBefore = snapshotTree(args.model);
  const markers = markerStatus(args.model, sourceBefore.rows);
  const cacheBefore = snapshotTree(cacheDir);
  const modelReport = {
    modelPath: args.model,
    markers,
    sourceBytes: sourceBefore.totalBytes,
    registered: false,
    metadataAttempts: [],
    metadataMethods: [],
    metadataTried: [],
    registerAttempts: [],
    folder: { beforeFileCount: sourceBefore.fileCount },
    cache: null,
    facts: null,
    chat: null,
    toolCall: null,
    error: null,
  };
  if (markers.gguf && !markers.genaiConfig) {
    modelReport.error = 'Folder contains a .gguf file and no genai_config.json. This spike registers ONNX GenAI folders.';
    return modelReport;
  }
  if (!registration?.register || !registration.unregister) {
    modelReport.error = 'No register/unregister pair is visible yet. Use the method names in this report before retrying --model.';
    return modelReport;
  }

  const metadataTargets = [
    { label: registration.surface, value: registration.target },
    ...surfaces,
    { label: 'module', value: sdk },
  ];
  const obtained = obtainMetadata(metadataTargets);
  modelReport.metadataTried = obtained.tried;
  const applied = applyMetadata(obtained.metadata, args);
  modelReport.metadataAttempts = applied.attempts;
  modelReport.metadataMethods = applied.methods;

  let registeredModel = null;
  try {
    const registered = await registerAlias(registration, args.model, obtained.metadata);
    modelReport.registerAttempts = registered.attempts;
    modelReport.registerSource = registered.source;
    registeredModel = registered.model;
    modelReport.registered = registered.attempts.some((attempt) => attempt.ok);
    if (!modelReport.registered) {
      modelReport.error = registered.attempts.at(-1)?.error ?? 'register returned no model';
    }
  } catch (error) {
    modelReport.error = errorText(error);
  }

  const sourceAfterRegister = snapshotTree(args.model);
  const cacheAfterRegister = snapshotTree(cacheDir);
  modelReport.folder.afterRegister = diffSnapshots(sourceBefore, sourceAfterRegister);
  modelReport.cache = {
    growthBytes: cacheAfterRegister.totalBytes - cacheBefore.totalBytes,
    mayHoldACopy: cacheMayHoldACopy(sourceBefore.totalBytes, cacheAfterRegister.totalBytes - cacheBefore.totalBytes),
  };

  if (registeredModel) {
    const lookup = await lookupAlias(surfaces, ALIAS);
    modelReport.catalogLookup = lookup;
    if (typeof registeredModel.load !== 'function' && lookup.found) {
      for (const surface of surfaces) {
        if (typeof surface.value?.getModel !== 'function') continue;
        try {
          registeredModel = await surface.value.getModel(ALIAS);
          break;
        } catch {
          // The next catalog surface may own the alias.
        }
      }
    }
    if (typeof registeredModel?.load === 'function') {
      try {
        await withTimeout(registeredModel.load(), 10 * 60 * 1000);
      } catch (error) {
        modelReport.loadError = errorText(error);
      }
    }
    modelReport.facts = await modelFacts(registeredModel);
    const modelId = typeof modelReport.facts.id === 'string' ? modelReport.facts.id : ALIAS;
    modelReport.openai = await runFoundryOpenAi(manager, modelId);
    if (!modelReport.openai?.requiredOk) {
      modelReport.chat = await runCompletion(sdk, registeredModel, {
        model: modelId,
        messages: [{ role: 'user', content: READY_PROMPT }],
        max_tokens: 256,
      }, 120_000);
      modelReport.toolCall = await runToolCall(sdk, registeredModel, modelId);
    }
    const cacheAfterUse = snapshotTree(cacheDir);
    const useGrowth = cacheAfterUse.totalBytes - cacheBefore.totalBytes;
    modelReport.cache.afterUseGrowthBytes = useGrowth;
    modelReport.cache.mayHoldACopy = modelReport.cache.mayHoldACopy || cacheMayHoldACopy(sourceBefore.totalBytes, useGrowth);
    modelReport.folder.afterUse = diffSnapshots(sourceBefore, snapshotTree(args.model));
    if (typeof registeredModel.unload === 'function') {
      try { await registeredModel.unload(); } catch (error) { modelReport.unloadError = errorText(error); }
    }
  }

  if (modelReport.registered && !args.keep) {
    try {
      await registration.target[registration.unregister](ALIAS);
      modelReport.unregistered = true;
    } catch (error) {
      modelReport.unregistered = false;
      modelReport.unregisterError = errorText(error);
    }
  }
  modelReport.folder.afterCleanup = diffSnapshots(sourceBefore, snapshotTree(args.model));
  return modelReport;
}

async function runToolCall(sdk, model, modelId) {
  const first = await runCompletion(sdk, model, {
    model: modelId,
    messages: [{ role: 'user', content: TOOL_PROMPT }],
    tools: COLOR_TOOL,
    tool_choice: 'auto',
    max_tokens: 256,
  }, 180_000);
  const call = first.toolCalls?.[0] ?? null;
  const judgment = judgeToolCall(call);
  const followUp = secondTurnMessages(call, judgment);
  let secondTurn = null;
  if (followUp) {
    secondTurn = await runCompletion(sdk, model, {
      model: modelId,
      messages: followUp,
      max_tokens: 256,
    }, 180_000);
  } else {
    secondTurn = { skipped: call ? 'tool call had no id' : 'first response had no tool call' };
  }
  return {
    path: first.path,
    streamed: first.streamed,
    text: first.text,
    usage: first.usage,
    finishReason: first.finishReason,
    error: first.error ?? null,
    itemTypes: first.itemTypes ?? null,
    judgment,
    secondTurn,
  };
}

function runSelfTest() {
  const parsed = parseArgs(['--ep', 'CUDAExecutionProvider', '--context', '8192', '--task', 'chat-completion', '--keep']);
  assert.equal(parsed.ep, 'CUDAExecutionProvider');
  assert.equal(parsed.context, 8192);
  assert.equal(parsed.keep, true);
  assert.throws(() => parseArgs(['--context', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);

  assert.throws(() => assertWorkDir(repoRoot), /outside the Flint repo/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-spike-selftest-'));
  assert.equal(assertWorkDir(outside), outside);

  const folder = path.join(outside, 'folder');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'genai_config.json'), '{"model":{"type":"test"}}\n');
  const first = snapshotTree(folder);
  const second = snapshotTree(folder);
  assert.equal(diffSnapshots(first, second).unchanged, true);
  fs.writeFileSync(path.join(folder, 'weights.onnx'), 'abcd');
  const added = diffSnapshots(first, snapshotTree(folder));
  assert.equal(added.unchanged, false);
  assert.deepEqual(added.added, ['weights.onnx']);
  const marked = markerStatus(folder, snapshotTree(folder).rows);
  assert.equal(marked.genaiConfig, true);
  assert.equal(marked.inferenceModel, false);
  assert.equal(marked.gguf, false);
  assert.equal(cacheMayHoldACopy(20_000_000, 19_000_000), true);
  assert.equal(cacheMayHoldACopy(20_000_000, 1000), false);

  const merged = mergeToolDeltas([
    { index: 0, id: 'call_1', function: { name: 'pick_', arguments: '' } },
    { index: 0, function: { name: 'color', arguments: '{"color":' } },
    { index: 0, function: { arguments: '"blue"}' } },
  ]);
  assert.equal(merged.length, 1);
  const judgment = judgeToolCall(merged[0]);
  assert.equal(judgment.wellFormed, true);
  assert.equal(judgment.color, 'blue');
  assert.equal(judgeToolCall({ id: 'call_2', name: 'pick_color', arguments: '{"color":"green"}' }).wellFormed, false);
  assert.equal(judgeToolCall({ id: 'call_3', name: 'pick_color', arguments: '{' }).parseError == null, false);
  const messages = secondTurnMessages(merged[0], judgment);
  assert.equal(messages[1].tool_calls[0].id, 'call_1');
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].content, '{"color":"blue"}');
  assert.equal(secondTurnMessages({ name: 'pick_color', arguments: '{}' }, { wellFormed: false }), null);

  const preferred = preferRegistration([
    { surface: 'manager.catalog', register: 'registerModel' },
    { surface: 'manager.localCatalog', register: 'register' },
  ]);
  assert.equal(preferred.surface, 'manager.localCatalog');
  assert.equal(preferRegistration([]), null);
  const localCatalog = { name: 'LocalCatalog', registerModel() {}, unregisterModel() {} };
  const publicCatalog = { name: 'AzureFoundryCatalog', registerModel() {}, unregisterModel() {} };
  const discovered = catalogSurfaces({
    catalog: publicCatalog,
    getCatalog(type) { return type === 1 ? localCatalog : publicCatalog; },
  }, { Local: 1, Public: 0 });
  const picked = preferRegistration(registrationPairs(discovered.surfaces));
  assert.equal(picked.surface, 'manager.getCatalog(Local)');
  assert.equal(picked.catalogName, 'LocalCatalog');
  assert.equal(picked.register, 'registerModel');
  class MutableModelInfo {
    setStringProperty() { return this; }
    setIntProperty() { return this; }
  }
  const obtained = obtainMetadata([{ label: 'module', value: { MutableModelInfo } }]);
  assert.equal(obtained.tried[0].method, 'MutableModelInfo');
  assert.equal(obtained.tried[0].ok, true);
  const applied = applyMetadata(obtained.metadata, {
    task: 'chat-completion',
    ep: 'CPUExecutionProvider',
    context: 4096,
  });
  assert.deepEqual(applied.attempts.map((attempt) => attempt.key), ['task', 'execution_provider', 'context_length']);
  assert.equal(applied.attempts.every((attempt) => attempt.ok), true);
  assert.equal(looksLikeArityError('Expected 2 arguments, got 3'), true);
  assert.equal(looksLikeArityError('invalid argument: execution_provider'), false);
  assert.equal(looksLikeArityError('metadata rejected execution_provider'), false);
  fs.mkdirSync(path.join(folder, 'inner'));
  fs.writeFileSync(path.join(folder, 'inner', 'weights.gguf'), 'g');
  assert.equal(markerStatus(folder, snapshotTree(folder).rows).gguf, true);

  fs.rmSync(outside, { recursive: true, force: true });
  console.log('self-test ok');
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--self-test')) {
  if (rawArgs.length !== 1) {
    console.error('--self-test takes no other arguments');
    process.exit(1);
  }
  try {
    runSelfTest();
  } catch (error) {
    console.error(error?.stack ?? errorText(error));
    process.exit(1);
  }
} else {
  main().catch((error) => {
    console.error(error?.stack ?? errorText(error));
    process.exit(1);
  });
}
