// Live qualification for a real ONNX GenAI folder through Flint's sidecar and gateway.
// Flint gets a copy or temporary junction under an isolated app home; the source
// is hashed before and after the run and is never modified.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_BUFFERED_BODY } from '../sidecar/gateway-http.js';
import { disconnectStream, runOpenAiLive } from './openai-live.mjs';
import { evaluateRetrieval } from './retrieval-quality.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIAS = 'flint-byom-live';
const PROMPT = 'What is 6 times 7? Reply with one short sentence.';
const EMBEDDING_INPUTS = ['A cat rests on a windowsill.', 'A bicycle needs a new chain.'];

function parseArgs(argv) {
  const args = {
    model: null, selfTest: false, copy: false, restart: false, embeddings: false,
    retrieval: null, catalogAlias: null, catalogVariant: null, preflight: false,
    admissionErrors: false, switchModel: null, switchVariant: null, concurrent: false,
    cancelStream: false, idleEviction: false, requireTools: false, probeResponses: false,
    disconnectOnly: false, packagedRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--self-test') args.selfTest = true;
    else if (argv[i] === '--copy') args.copy = true;
    else if (argv[i] === '--restart') args.restart = true;
    else if (argv[i] === '--embeddings') args.embeddings = true;
    else if (argv[i] === '--preflight') args.preflight = true;
    else if (argv[i] === '--admission-errors') args.admissionErrors = true;
    else if (argv[i] === '--concurrent') args.concurrent = true;
    else if (argv[i] === '--cancel-stream') args.cancelStream = true;
    else if (argv[i] === '--idle-eviction') args.idleEviction = true;
    else if (argv[i] === '--require-tools') args.requireTools = true;
    else if (argv[i] === '--probe-responses') args.probeResponses = true;
    else if (argv[i] === '--disconnect-only') args.disconnectOnly = true;
    else if (argv[i] === '--packaged-root') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--packaged-root requires a release resource directory.');
      args.packagedRoot = path.resolve(value);
    }
    else if (argv[i] === '--switch-model' || argv[i] === '--switch-variant') {
      const option = argv[i];
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
      args[option === '--switch-model' ? 'switchModel' : 'switchVariant'] =
        option === '--switch-model' ? path.resolve(value) : value;
    }
    else if (argv[i] === '--retrieval') {
      args.retrieval = argv[++i];
      if (!args.retrieval || args.retrieval.startsWith('--')) throw new Error('--retrieval requires a JSON dataset path.');
    }
    else if (argv[i] === '--model') {
      const model = argv[++i];
      if (!model || model.startsWith('--')) throw new Error('--model requires a folder path.');
      args.model = path.resolve(model);
    }
    else if (argv[i] === '--catalog-alias' || argv[i] === '--catalog-variant') {
      const option = argv[i];
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
      args[option === '--catalog-alias' ? 'catalogAlias' : 'catalogVariant'] = value;
    }
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (args.retrieval && !args.embeddings) throw new Error('--retrieval requires --embeddings.');
  if (args.preflight && args.embeddings) throw new Error('--preflight requires a chat model.');
  if (args.admissionErrors && (!args.catalogAlias || args.embeddings)) {
    throw new Error('--admission-errors requires a cached catalog chat model.');
  }
  if (args.concurrent && (!args.catalogAlias || args.embeddings)) {
    throw new Error('--concurrent requires a cached catalog chat model.');
  }
  if (args.cancelStream && (!args.catalogAlias || args.embeddings)) {
    throw new Error('--cancel-stream requires a cached catalog chat model.');
  }
  if (args.idleEviction && (!args.catalogAlias || args.embeddings)) {
    throw new Error('--idle-eviction requires a cached catalog chat model.');
  }
  if (args.requireTools && (!args.catalogAlias || args.embeddings)) {
    throw new Error('--require-tools requires a cached catalog chat model.');
  }
  if (args.probeResponses && (!args.catalogAlias || args.embeddings)) {
    throw new Error('--probe-responses requires a cached catalog chat model.');
  }
  if (args.disconnectOnly && (!args.catalogAlias || args.embeddings || args.requireTools)) {
    throw new Error('--disconnect-only requires a cached catalog chat model without --require-tools.');
  }
  if (args.probeResponses && (args.disconnectOnly || args.requireTools)) {
    throw new Error('--probe-responses must run without tool or disconnect probes.');
  }
  if (args.switchModel || args.switchVariant) {
    if (!args.switchModel || !args.switchVariant || !args.catalogAlias || args.embeddings) {
      throw new Error('Variant switching requires --switch-model, --switch-variant, and a cached catalog chat model.');
    }
    if (args.switchVariant === args.catalogVariant) {
      throw new Error('Variant switching requires a different versioned model id.');
    }
  }
  if (args.catalogAlias || args.catalogVariant) {
    if (!args.catalogAlias || !args.catalogVariant) {
      throw new Error('Catalog runs require both --catalog-alias and --catalog-variant.');
    }
    if (args.copy || args.restart) {
      throw new Error('Catalog runs cannot copy or restart an import.');
    }
  }
  return args;
}

function flintIsRunning() {
  if (process.platform !== 'win32') return false;
  const listed = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Flint.exe', '/NH'], {
    encoding: 'utf8',
  });
  return /Flint\.exe/i.test(listed);
}

async function snapshotFolder(root) {
  const files = [];
  async function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to hash a model source containing a link: ${fullPath}`);
      }
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(fullPath)) hash.update(chunk);
      const stat = fs.statSync(fullPath);
      files.push({
        path: path.relative(root, fullPath),
        bytes: stat.size,
        sha256: hash.digest('hex'),
      });
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function listenOnFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local test port.'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startSidecar(home, appName, stderrLines, packagedRoot) {
  const child = spawn(
    packagedRoot ? path.join(packagedRoot, 'node.exe') : process.execPath,
    [packagedRoot ? path.join(packagedRoot, 'sidecar', 'foundry-sidecar.js') : 'sidecar/foundry-sidecar.js'],
    {
      cwd: packagedRoot || repoRoot,
      env: {
        ...process.env,
        ...(packagedRoot ? { NODE_PATH: packagedRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const pending = new Map();
  let nextId = 1;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const stdout = readline.createInterface({ input: child.stdout });
  let exitResolve;
  let hasClosed = false;
  const exited = new Promise((resolve) => { exitResolve = resolve; });
  stdout.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.ready === true) readyResolve();
    const entry = pending.get(message?.id);
    if (!entry || message.progress !== undefined) return;
    if (message.stream) {
      entry.onStream?.(message);
      return;
    }
    pending.delete(message.id);
    entry.resolve(message);
  });
  child.stderr.on('data', (chunk) => {
    stderrLines.push(chunk.toString());
    while (stderrLines.join('').length > 16000) stderrLines.shift();
  });
  child.once('error', readyReject);
  child.once('close', (code, signal) => {
    hasClosed = true;
    exitResolve({ code, signal });
    readyReject(new Error(`Sidecar exited before readiness (${code ?? signal}).`));
    for (const entry of pending.values()) {
      entry.reject(new Error(`Sidecar exited before command response (${code ?? signal}).`));
    }
    pending.clear();
  });

  function send(cmd, payload = {}, timeoutMs = 10 * 60 * 1000, onStream) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Sidecar command ${cmd} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      pending.set(id, {
        onStream,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`, (error) => {
        if (!error) return;
        const entry = pending.get(id);
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  return { child, ready, send, exited, get hasClosed() { return hasClosed; } };
}

async function waitForClose(sidecar, timeoutMs) {
  if (sidecar.hasClosed) return true;
  let timer;
  try {
    return await Promise.race([
      sidecar.exited.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopSidecar(sidecar, { graceMs = 1500, forceMs = 5000 } = {}) {
  let error = null;
  if (sidecar.hasClosed) {
    return { error: 'Sidecar closed before graceful runtime shutdown could be confirmed.', forced: false };
  }
  try {
    const shutdown = assertReply(
      await sidecar.send('shutdownRuntime', { drainTimeoutMs: 10000 }, 15000),
      'shutdownRuntime',
    );
    if (shutdown.result?.cleanup !== 'confirmed') {
      throw new Error(
        `Runtime cleanup not confirmed (${shutdown.result?.cleanup ?? 'missing status'}): ` +
        JSON.stringify(shutdown.result ?? null),
      );
    }
  } catch (failure) {
    error = `Graceful sidecar shutdown failed: ${failure?.message || failure}`;
  }
  if (await waitForClose(sidecar, graceMs)) return { error, forced: false };
  sidecar.child.kill();
  if (!await waitForClose(sidecar, forceMs)) {
    error = 'The isolated sidecar did not close; temporary files were retained.';
  } else {
    error ??= 'The isolated sidecar required forced termination; graceful shutdown was not confirmed.';
  }
  return { error, forced: true };
}

function assertReply(reply, command) {
  if (reply?.ok !== true) {
    throw new Error(`${command} failed: ${reply?.error || JSON.stringify(reply)}`);
  }
  return reply;
}

function validateEmbeddings(response) {
  const vectors = Array.isArray(response?.data)
    ? response.data.map((row) => row?.embedding)
    : null;
  if (!Array.isArray(vectors) || vectors.length !== EMBEDDING_INPUTS.length ||
    !vectors.every((vector) => Array.isArray(vector) && vector.length > 0 &&
      vector.length === vectors[0]?.length &&
      vector.every((component) => typeof component === 'number' && Number.isFinite(component)) &&
      vector.some((component) => component !== 0))) {
    throw new Error('Embedding response must contain finite, nonzero vectors of matching dimensions.');
  }
  return vectors;
}

function validateBase64Embeddings(response, floats) {
  const rows = response?.data;
  if (!Array.isArray(rows) || rows.length !== floats.length) {
    throw new Error('Base64 embedding response has the wrong number of vectors.');
  }
  for (let index = 0; index < rows.length; index++) {
    const encoded = rows[index]?.embedding;
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error(`Base64 embedding ${index} is not encoded text.`);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== floats[index].length * 4 || bytes.toString('base64') !== encoded) {
      throw new Error(`Base64 embedding ${index} has an invalid float32 payload.`);
    }
    for (let component = 0; component < floats[index].length; component++) {
      if (bytes.readFloatLE(component * 4) !== Math.fround(floats[index][component])) {
        throw new Error(`Base64 embedding ${index} differs from its float response at ${component}.`);
      }
    }
  }
}

function cosine(a, b) {
  const dot = a.reduce((sum, component, index) => sum + component * b[index], 0);
  const normA = Math.hypot(...a);
  const normB = Math.hypot(...b);
  return dot / (normA * normB);
}

async function complete(endpoint, body, stream = false) {
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream }),
  });
  if (!response.ok) {
    throw new Error(`Gateway chat returned HTTP ${response.status}: ${await response.text()}`);
  }
  if (!stream) return await response.json();

  let text = '';
  let done = false;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      const event = JSON.parse(data);
      if (event.error) throw new Error(event.error.message || 'Gateway stream failed.');
      text += event.choices?.[0]?.delta?.content || '';
    }
  }
  return { text, done };
}

function catalogCacheTarget(modelPath, variantId, home, appName) {
  const versionDir = path.basename(modelPath);
  const variantDir = path.basename(path.dirname(modelPath));
  if (path.basename(path.dirname(path.dirname(modelPath))) !== 'Microsoft'
      || !/^v[1-9]\d*$/.test(versionDir)
      || !variantDir.endsWith(`-${versionDir.slice(1)}`)
      || `${variantDir.replace(/-(\d+)$/, '')}:${versionDir.slice(1)}` !== variantId) {
    throw new Error('The cached catalog folder does not match the requested variant id.');
  }
  return path.join(home, `.${appName}`, 'cache', 'models', 'Microsoft', variantDir, versionDir);
}

async function run(modelPath, {
  copy = false, restart = false, embeddings = false, retrieval = null,
  catalogAlias = null, catalogVariant = null, preflight = false, admissionErrors = false,
  switchModel = null, switchVariant = null, concurrent = false, cancelStream = false,
  idleEviction = false, requireTools = false, probeResponses = false,
  disconnectOnly = false, packagedRoot = null,
} = {}) {
  if (process.platform !== 'win32') {
    throw new Error('The Foundry Local native SDK live spike requires Windows.');
  }
  if (!path.isAbsolute(modelPath) || !fs.statSync(modelPath).isDirectory()) {
    throw new Error('--model must name an existing model directory.');
  }
  if (switchModel && (!path.isAbsolute(switchModel) || !fs.statSync(switchModel).isDirectory())) {
    throw new Error('--switch-model must name an existing model directory.');
  }
  if (packagedRoot) {
    for (const resource of ['node.exe', path.join('sidecar', 'foundry-sidecar.js'),
      path.join('foundry-local-sdk', 'package.json')]) {
      if (!fs.statSync(path.join(packagedRoot, resource), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Packaged runtime is missing ${resource}.`);
      }
    }
  }
  if (flintIsRunning()) {
    throw new Error('Quit Flint before this spike creates an isolated Foundry runtime.');
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flt-live-'));
  const home = path.join(work, 'home');
  fs.mkdirSync(home, { recursive: true });
  const appName = 'flint-live';
  const modelAlias = catalogAlias || (embeddings ? 'flint-byom-embedding-live' : ALIAS);
  const stderrLines = [];
  const report = {
    modelPath,
    mode: catalogAlias ? 'catalog-cache-copy' : (copy ? 'copy' : 'link'),
    runtime: packagedRoot ? 'staged-bundle' : 'repository',
    catalogVariant,
    task: embeddings ? 'embeddings' : 'chat',
    cudaDevice: process.env.CUDA_VISIBLE_DEVICES ?? null,
    restarted: false,
    phase: 'source snapshot',
    sourceUnchanged: null,
    sourceFileCount: 0,
    ipc: null,
    gateway: null,
    retrieval: null,
    preflight: null,
    admissionErrors: null,
    switch: null,
    concurrent: null,
    cancelStream: null,
    idleEviction: null,
    tools: null,
    responses: null,
    disconnect: null,
    error: null,
    cleanupError: null,
    cleanupForced: false,
  };
  let sidecar;
  let linkedPath = null;
  let sourceBefore;
  let switchBefore;
  try {
    sourceBefore = await snapshotFolder(modelPath);
    report.sourceFileCount = sourceBefore.length;
    if (catalogAlias) {
      const isolated = catalogCacheTarget(modelPath, catalogVariant, home, appName);
      fs.mkdirSync(path.dirname(isolated), { recursive: true });
      fs.cpSync(modelPath, isolated, { recursive: true, errorOnExist: true, force: false });
    }
    if (switchModel) {
      switchBefore = await snapshotFolder(switchModel);
      const isolated = catalogCacheTarget(switchModel, switchVariant, home, appName);
      fs.mkdirSync(path.dirname(isolated), { recursive: true });
      fs.cpSync(switchModel, isolated, { recursive: true, errorOnExist: true, force: false });
    }
    sidecar = startSidecar(home, appName, stderrLines, packagedRoot);
    await sidecar.ready;
    report.phase = 'first init';
    assertReply(await sidecar.send('init', { appName, logLevel: 'error' }), 'init');
    report.phase = 'first accelerator registration';
    const accelerators = assertReply(await sidecar.send('ensureAccelerators'), 'ensureAccelerators').result;
    if ((embeddings || (catalogAlias && /-cuda-/i.test(catalogVariant))
      || (switchVariant && /-cuda-/i.test(switchVariant)))
      && !accelerators?.registeredEps?.includes('CUDAExecutionProvider')) {
      throw new Error('CUDA provider was not registered for the selected qualification.');
    }
    if (!catalogAlias) {
      const addCommand = copy ? 'importModelFolder' : 'linkModelFolder';
      report.phase = addCommand;
      const added = assertReply(await sidecar.send(addCommand, {
        folderPath: modelPath,
        name: modelAlias,
      }), addCommand).result;
      if (added.registered !== true) {
        throw new Error(`Local registration failed: ${added.registrationError || added.registrationTask || 'unknown reason'}`);
      }
      if (embeddings && added.registrationTask !== 'embeddings') {
        throw new Error(`The imported embedding was registered as '${added.registrationTask}'.`);
      }
      linkedPath = copy ? added.path : added.linkPath;
    }

    if (restart) {
      report.phase = 'pre-restart shutdown';
      const cleanup = await stopSidecar(sidecar);
      if (cleanup.error) throw new Error(`Pre-restart sidecar shutdown failed: ${cleanup.error}`);
      sidecar = startSidecar(home, appName, stderrLines, packagedRoot);
      await sidecar.ready;
      report.phase = 'restart init';
      assertReply(await sidecar.send('init', { appName, logLevel: 'error' }), 'restart init');
      report.phase = 'restart accelerator registration';
      assertReply(await sidecar.send('ensureAccelerators'), 'restart ensureAccelerators');
      report.restarted = true;
    }

    report.phase = 'post-registration discovery';
    const listed = assertReply(await sidecar.send('listModels'), 'listModels').result;
    const local = listed.find((model) => model.alias === modelAlias);
    if (!local || (catalogAlias
      ? !local.variants?.some((variant) => variant.id === catalogVariant && variant.cached)
      : local.info?.uri !== `local://${modelAlias}`)) {
      throw new Error('The selected model was not visible as cached in Flint model discovery.');
    }
    if (switchVariant && !local.variants?.some((variant) => variant.id === switchVariant && variant.cached)) {
      throw new Error('The switch target was not visible as cached in Flint model discovery.');
    }
    report.phase = 'model load and IPC';
    const loaded = assertReply(await sidecar.send('load', {
      alias: modelAlias, ...(catalogVariant ? { variantId: catalogVariant } : {}),
    }), 'load').result;
    if (catalogVariant && loaded.variantId !== catalogVariant) {
      throw new Error(`Loaded ${loaded.variantId} instead of the selected catalog variant.`);
    }
    const prompt = [{ role: 'user', content: PROMPT }];
    let ipcVectors;
    if (embeddings) {
      const ipc = assertReply(await sidecar.send('embedTexts', {
        model: modelAlias,
        inputs: EMBEDDING_INPUTS,
      }, 3 * 60 * 1000), 'embedTexts').result;
      ipcVectors = validateEmbeddings(ipc);
      report.ipc = {
        variantId: loaded.variantId,
        dimensions: ipcVectors[0].length,
        count: ipcVectors.length,
        activeProvider: loaded.acceleration?.active ?? null,
      };
    } else {
      const ipc = assertReply(await sidecar.send('chatCompletion', {
        model: modelAlias,
        messages: prompt,
        maxTokens: 32,
      }, 3 * 60 * 1000), 'chatCompletion').result;
      const ipcText = ipc?.choices?.[0]?.message?.content;
      if (typeof ipcText !== 'string' || !ipcText.trim()) {
        throw new Error('Flint IPC completed without assistant text.');
      }
      report.ipc = { variantId: loaded.variantId, text: ipcText.slice(0, 240) };
      if (cancelStream) {
        report.phase = 'stream cancellation';
        let cancelAck = null;
        let firstDelta = '';
        let deltasAfterAck = 0;
        let acknowledged = false;
        const streaming = sidecar.send('chatCompletion', {
          model: modelAlias,
          messages: [{ role: 'user', content: 'Count from 1 to 200, one number per line.' }],
          maxTokens: 256,
          stream: true,
        }, 3 * 60 * 1000, (message) => {
          if (!firstDelta && typeof message.delta === 'string' && message.delta) {
            firstDelta = message.delta;
            cancelAck = sidecar.send('cancelChatRequest', { requestId: message.id }).then((reply) => {
              assertReply(reply, 'cancelChatRequest');
              acknowledged = true;
            });
            void cancelAck.catch(() => {});
          } else if (acknowledged && message.delta) {
            deltasAfterAck++;
          }
        });
        const terminal = await streaming;
        if (!cancelAck) throw new Error('No streaming delta arrived before the terminal response.');
        await cancelAck;
        if (terminal.ok === true || terminal.certainty !== 'cancelled' || terminal.result !== undefined) {
          throw new Error(`Canceled stream returned a successful or unclassified terminal response: ${JSON.stringify(terminal)}`);
        }
        if (deltasAfterAck !== 0) throw new Error(`${deltasAfterAck} stream deltas arrived after cancellation was acknowledged.`);
        const pool = assertReply(await sidecar.send('poolStatus'), 'cancel poolStatus').result;
        if (pool?.models?.length !== 1 || pool.models[0].variantId !== loaded.variantId
          || pool.models[0].inFlight !== 0) {
          throw new Error('Canceled stream left an activity lease or changed residency.');
        }
        const healthy = assertReply(await sidecar.send('chatCompletion', {
          model: modelAlias, messages: prompt, maxTokens: 32,
        }, 3 * 60 * 1000), 'post-cancel chatCompletion').result;
        if (typeof healthy?.choices?.[0]?.message?.content !== 'string'
          || !healthy.choices[0].message.content.trim()) {
          throw new Error('The model did not serve a reply after cancellation.');
        }
        report.cancelStream = {
          firstDelta: firstDelta.slice(0, 80),
          terminalCertainty: terminal.certainty,
          deltasAfterAck,
          inFlightAfter: 0,
          healthyAfter: true,
        };
      }
      if (preflight) {
        report.phase = 'native structural preflight';
        const oversized = [{ role: 'user', content: 'word '.repeat(40000) }];
        const reasons = {};
        for (const stream of [false, true]) {
          const rejected = await sidecar.send('chatCompletion', {
            model: modelAlias,
            messages: oversized,
            maxTokens: 32,
            stream,
          }, 3 * 60 * 1000);
          if (rejected?.ok === true
            || !/structural context limit by \d+ tokens \(requires \d+, limit \d+\)/.test(rejected.error ?? '')) {
            throw new Error(`Oversized native ${stream ? 'streaming' : 'buffered'} chat was not rejected by structural preflight: ${JSON.stringify(rejected)}`);
          }
          reasons[stream ? 'streaming' : 'buffered'] = rejected.error;
        }
        report.preflight = reasons;
      }
    }

    report.phase = 'gateway';
    const port = await listenOnFreePort();
    assertReply(await sidecar.send('startService', {
      port,
      bindAddress: '127.0.0.1',
      gateway: true,
      deferCatalogRead: false,
    }), 'startService');
    const endpointReply = await sidecar.send('getEndpoint');
    if (typeof endpointReply?.endpoint !== 'string' || !endpointReply.endpoint) {
      throw new Error('Flint did not publish its gateway endpoint.');
    }
    const endpoint = endpointReply.endpoint.replace(/\/+$/, '');
    const modelListing = await fetch(`${endpoint}/models`);
    if (!modelListing.ok) throw new Error(`Gateway model listing returned HTTP ${modelListing.status}.`);
    const modelRows = (await modelListing.json())?.data;
    if (!Array.isArray(modelRows) || !modelRows.some((model) => catalogAlias
      ? model.id === catalogVariant || model.id === catalogVariant.split(':')[0]
      : model.parent === modelAlias)) {
      throw new Error('The gateway model listing omitted the selected model.');
    }
    if (embeddings) {
      const response = await fetch(`${endpoint}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelAlias, input: EMBEDDING_INPUTS }),
        signal: AbortSignal.timeout(3 * 60 * 1000),
      });
      if (!response.ok) {
        throw new Error(`Gateway embeddings returned HTTP ${response.status}: ${await response.text()}`);
      }
      const gatewayVectors = validateEmbeddings(await response.json());
      if (gatewayVectors[0].length !== ipcVectors[0].length) {
        throw new Error('Gateway and IPC embedding dimensions differ.');
      }
      const agreement = gatewayVectors.map((vector, index) => cosine(vector, ipcVectors[index]));
      if (!agreement.every((score) => Number.isFinite(score) && score > 0.99)) {
        throw new Error(`Gateway and IPC embeddings disagree: ${JSON.stringify(agreement)}`);
      }
      const base64Response = await fetch(`${endpoint}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelAlias, input: EMBEDDING_INPUTS, encoding_format: 'base64' }),
        signal: AbortSignal.timeout(3 * 60 * 1000),
      });
      if (!base64Response.ok) {
        throw new Error(`Gateway base64 embeddings returned HTTP ${base64Response.status}: ${await base64Response.text()}`);
      }
      validateBase64Embeddings(await base64Response.json(), gatewayVectors);
      report.gateway = {
        endpoint,
        discoveredId: modelRows.find((model) => catalogAlias
          ? model.id === catalogVariant || model.id === catalogVariant.split(':')[0]
          : model.parent === modelAlias).id,
        count: gatewayVectors.length,
        dimensions: gatewayVectors[0].length,
        ipcCosine: agreement,
        base64MatchesFloat32: true,
      };
      if (retrieval) {
        report.phase = 'retrieval quality';
        report.retrieval = await evaluateRetrieval(endpoint, modelAlias, retrieval, (progress) => {
          if (progress.completed % 320 === 0 || progress.completed === progress.total) {
            console.error(`Retrieval ${progress.kind}: ${progress.completed}/${progress.total}`);
          }
        });
      }
    } else {
      const request = { model: modelAlias, messages: prompt, max_tokens: 32 };
      const buffered = await complete(endpoint, request);
      const bufferedText = buffered?.choices?.[0]?.message?.content;
      if (typeof bufferedText !== 'string' || !bufferedText.trim()) {
        throw new Error('Gateway buffered inference completed without assistant text.');
      }
      const streamed = await complete(endpoint, request, true);
      if (!streamed.done || !streamed.text.trim()) {
        throw new Error('Gateway streaming inference did not emit text and [DONE].');
      }
      report.gateway = {
        endpoint,
        discoveredId: modelRows.find((model) => catalogAlias
          ? model.id === catalogVariant || model.id === catalogVariant.split(':')[0]
          : model.parent === modelAlias).id,
        bufferedText: bufferedText.slice(0, 240),
        streamedText: streamed.text.slice(0, 240),
        streamDone: streamed.done,
      };
      if (probeResponses) {
        report.phase = 'optional responses route';
        const response = await fetch(`${endpoint}/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: catalogVariant, input: 'Reply with ready.' }),
          signal: AbortSignal.timeout(3 * 60 * 1000),
        });
        await response.body?.cancel();
        report.responses = { status: response.status };
      }
      if (disconnectOnly) {
        report.phase = 'isolated gateway disconnect';
        const disconnected = await disconnectStream(endpoint, catalogVariant, 3 * 60 * 1000);
        if (!disconnected.ok) throw new Error(`Gateway disconnect did not settle: ${disconnected.detail}`);
        report.disconnect = { clientSettled: true };
      }
      if (requireTools) {
        report.phase = 'gateway tool round trip';
        const qualification = await runOpenAiLive({
          base: endpoint, model: catalogVariant, requireTools: true, skipOptional: true,
        });
        if (!qualification.requiredOk) {
          throw new Error(`Gateway tool qualification failed: ${JSON.stringify(qualification.checks.filter(
            (check) => check.required && !check.ok,
          ))}`);
        }
        report.tools = {
          requiredChecks: qualification.checks.filter((check) => check.required).map((check) => check.name),
          optionalFailures: qualification.checks.filter((check) => !check.required && !check.ok).map((check) => check.name),
        };
      }
      if (concurrent) {
        report.phase = 'concurrent chat submissions';
        const ipcReplies = await Promise.allSettled(Array.from({ length: 2 }, () =>
          sidecar.send('chatCompletion', {
            model: modelAlias, messages: prompt, maxTokens: 32,
          }, 3 * 60 * 1000),
        ));
        for (const reply of ipcReplies) {
          if (reply.status !== 'fulfilled') throw reply.reason;
          const text = assertReply(reply.value, 'concurrent chatCompletion').result
            ?.choices?.[0]?.message?.content;
          if (typeof text !== 'string' || !text.trim()) {
            throw new Error('Concurrent IPC chat returned no assistant text.');
          }
        }
        const gatewayReplies = await Promise.allSettled(Array.from({ length: 2 }, () =>
          complete(endpoint, request),
        ));
        for (const reply of gatewayReplies) {
          if (reply.status !== 'fulfilled') throw reply.reason;
          if (typeof reply.value?.choices?.[0]?.message?.content !== 'string'
            || !reply.value.choices[0].message.content.trim()) {
            throw new Error('Concurrent gateway chat returned no assistant text.');
          }
        }
        const pool = assertReply(await sidecar.send('poolStatus'), 'concurrent poolStatus').result;
        if (pool?.models?.length !== 1 || pool.models[0].variantId !== loaded.variantId
          || pool.models[0].inFlight !== 0) {
          throw new Error('Concurrent chat changed residency or left an activity lease.');
        }
        report.concurrent = { ipc: ipcReplies.length, gateway: gatewayReplies.length, inFlightAfter: 0 };
      }
      if (admissionErrors) {
        report.phase = 'gateway model admission';
        const failures = [
          ['unknownAlias', 'flint-unknown-model-live'],
          ['wrongVersion', `${catalogVariant.split(':')[0]}:99999`],
        ];
        const statuses = {};
        for (const [kind, model] of failures) {
          const response = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, messages: prompt, max_tokens: 32 }),
            signal: AbortSignal.timeout(3 * 60 * 1000),
          });
          if (response.status !== 404) {
            throw new Error(`${kind} returned HTTP ${response.status} instead of 404.`);
          }
          await response.body?.cancel();
          statuses[kind] = response.status;
        }
        const malformed = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"model":',
          signal: AbortSignal.timeout(3 * 60 * 1000),
        });
        if (malformed.status !== 400) {
          throw new Error(`Malformed chat JSON returned HTTP ${malformed.status} instead of 400.`);
        }
        await malformed.body?.cancel();
        statuses.malformedJson = malformed.status;
        const oversizedStatus = await new Promise((resolve, reject) => {
          const oversized = http.request(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(DEFAULT_MAX_BUFFERED_BODY + 1),
            },
            signal: AbortSignal.timeout(30_000),
          }, (response) => {
            response.once('error', reject);
            response.once('end', () => resolve(response.statusCode));
            response.resume();
          });
          oversized.once('error', reject);
          oversized.end('x');
        });
        if (oversizedStatus !== 413) {
          throw new Error(`Oversized declared chat JSON returned HTTP ${oversizedStatus} instead of 413.`);
        }
        statuses.oversizedJson = oversizedStatus;
        const acquired = assertReply(await sidecar.send('setBenchmarkExclusive', {
          exclusive: true,
        }), 'setBenchmarkExclusive').result;
        let admissionFailure = null;
        try {
          if (acquired?.exclusive !== true || acquired.drained !== true) {
            throw new Error('Benchmark-exclusive admission was not confirmed after drain.');
          }
          const denied = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(3 * 60 * 1000),
          });
          if (denied.status !== 503) {
            throw new Error(`Benchmark-exclusive gateway chat returned HTTP ${denied.status} instead of 503.`);
          }
          await denied.body?.cancel();
          statuses.benchmarkExclusive = denied.status;
        } catch (error) {
          admissionFailure = error;
        }
        try {
          assertReply(await sidecar.send('setBenchmarkExclusive', {
            exclusive: false,
          }), 'release setBenchmarkExclusive');
        } catch (releaseFailure) {
          if (admissionFailure) {
            throw new AggregateError(
              [admissionFailure, releaseFailure],
              `${admissionFailure.message}; benchmark release failed: ${releaseFailure.message}`,
              { cause: admissionFailure },
            );
          }
          throw releaseFailure;
        }
        if (admissionFailure) throw admissionFailure;
        const pool = assertReply(await sidecar.send('poolStatus'), 'poolStatus').result;
        if (pool?.models?.length !== 1 || pool.models[0].alias !== modelAlias
          || pool.models[0].variantId !== loaded.variantId || pool.models[0].inFlight !== 0) {
          throw new Error('Rejected model requests changed the resident pool or left an activity lease.');
        }
        const healthy = await complete(endpoint, request);
        if (typeof healthy?.choices?.[0]?.message?.content !== 'string'
          || !healthy.choices[0].message.content.trim()) {
          throw new Error('The original catalog model stopped serving after rejected requests.');
        }
        report.admissionErrors = { ...statuses, residentVariantId: loaded.variantId, healthyAfter: true };
      }
      if (idleEviction) {
        report.phase = 'idle eviction';
        assertReply(await sidecar.send('setModelPriorities', {
          priorities: [{ alias: modelAlias, priority: 'pinned' }],
        }), 'pin model');
        const configured = assertReply(await sidecar.send('setEvictionConfig', {
          idleUnloadEnabled: true, idleTimeoutMs: 60_000,
        }), 'enable idle eviction').result;
        if (configured?.config?.idleTimeoutMs !== 60_000) {
          throw new Error('The one-minute idle eviction threshold was not applied.');
        }
        await new Promise((resolve) => setTimeout(resolve, 61_000));
        const pinned = assertReply(await sidecar.send('poolStatus'), 'pinned poolStatus').result;
        if (pinned?.models?.length !== 1 || pinned.models[0].variantId !== loaded.variantId
          || pinned.models[0].priority !== 'pinned' || pinned.models[0].inFlight !== 0) {
          throw new Error('The pinned model did not survive the idle eviction threshold.');
        }
        const unpinned = assertReply(await sidecar.send('setModelPriorities', {
          priorities: [{ alias: modelAlias, priority: 'normal' }],
        }), 'unpin model').result;
        if (!unpinned?.evicted?.some((entry) => entry.alias === modelAlias && entry.reason === 'idle')) {
          throw new Error('The idle model was not evicted immediately after unpinning.');
        }
        const empty = assertReply(await sidecar.send('poolStatus'), 'evicted poolStatus').result;
        if (empty?.models?.length !== 0) throw new Error('The evicted model remained resident.');
        assertReply(await sidecar.send('setEvictionConfig', {
          idleUnloadEnabled: false,
        }), 'disable idle eviction');
        const recovered = await complete(endpoint, request);
        if (typeof recovered?.choices?.[0]?.message?.content !== 'string'
          || !recovered.choices[0].message.content.trim()) {
          throw new Error('The gateway did not serve a reply after idle eviction.');
        }
        const reloaded = assertReply(await sidecar.send('poolStatus'), 'reloaded poolStatus').result;
        if (reloaded?.models?.length !== 1 || reloaded.models[0].variantId !== loaded.variantId
          || reloaded.models[0].inFlight !== 0) {
          throw new Error('Gateway recovery after idle eviction changed residency or left a lease.');
        }
        report.idleEviction = { thresholdMs: 60_000, pinnedSurvived: true, evictedOnUnpin: true, gatewayRecovered: true };
      }
      if (switchVariant) {
        report.phase = 'same-alias variant switch';
        const switched = assertReply(await sidecar.send('load', {
          alias: modelAlias, variantId: switchVariant,
        }), 'switch load').result;
        if (switched?.variantId !== switchVariant) {
          throw new Error(`The sidecar selected ${switched?.variantId} instead of ${switchVariant}.`);
        }
        const alternate = await complete(endpoint, request);
        if (typeof alternate?.choices?.[0]?.message?.content !== 'string'
          || !alternate.choices[0].message.content.trim()) {
          throw new Error('The gateway did not serve a reply after switching variants.');
        }
        const pool = assertReply(await sidecar.send('poolStatus'), 'post-switch poolStatus').result;
        if (pool?.models?.length !== 1 || pool.models[0].alias !== modelAlias
          || pool.models[0].variantId !== switchVariant || pool.models[0].inFlight !== 0) {
          throw new Error('The gateway did not retain only the selected switch variant.');
        }
        report.switch = { from: loaded.variantId, to: switchVariant, healthyAfter: true };
      }
    }

    if (requireTools || disconnectOnly) {
      report.phase = 'post-disconnect drain';
      const deadline = Date.now() + 15_000;
      let pool;
      do {
        pool = assertReply(await sidecar.send('poolStatus'), 'post-disconnect poolStatus').result;
        if (pool?.models?.length !== 1 || pool.models[0].variantId !== loaded.variantId) {
          throw new Error('The disconnected stream changed model residency.');
        }
        if (pool.models[0].inFlight === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      if (pool.models[0].inFlight !== 0) {
        throw new Error('The disconnected stream did not release its activity lease within 15 seconds.');
      }
    }
    report.phase = 'model removal';
    assertReply(await sidecar.send('unload', { alias: modelAlias }), 'unload');
    if (!catalogAlias) assertReply(await sidecar.send('deleteModel', { alias: modelAlias }), 'deleteModel');
    const finalFiles = await snapshotFolder(modelPath);
    const primaryUnchanged = JSON.stringify(sourceBefore) === JSON.stringify(finalFiles);
    const switchUnchanged = !switchModel ||
      JSON.stringify(switchBefore) === JSON.stringify(await snapshotFolder(switchModel));
    report.sourceUnchanged = primaryUnchanged && switchUnchanged;
    if (!report.sourceUnchanged) {
      throw new Error(`${!primaryUnchanged ? 'Primary' : 'Switch'} source model files changed during the test.`);
    }
    if (linkedPath && fs.existsSync(linkedPath)) {
      throw new Error('Flint did not remove the isolated model assets during cleanup.');
    }
    report.phase = 'completed';
  } catch (error) {
    report.error = error?.message || String(error);
    if (stderrLines.length) report.sidecarStderr = stderrLines.join('').slice(-8000);
  } finally {
    if (sidecar?.child) {
      const cleanup = await stopSidecar(sidecar);
      report.cleanupError = cleanup.error;
      report.cleanupForced = cleanup.forced;
    }
    if (!sidecar || sidecar.hasClosed) {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  if (report.cleanupError && !report.error) report.error = report.cleanupError;
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    assert.equal(parseArgs(['--model', 'model']).model, path.resolve('model'));
    assert.equal(parseArgs(['--model', 'model', '--copy']).copy, true);
    assert.equal(parseArgs(['--model', 'model', '--restart']).restart, true);
    assert.equal(parseArgs(['--model', 'model', '--embeddings']).embeddings, true);
    assert.equal(parseArgs(['--model', 'model', '--preflight']).preflight, true);
    assert.throws(() => parseArgs(['--model', 'model', '--embeddings', '--preflight']), /requires a chat model/);
    assert.throws(() => parseArgs(['--model', 'model', '--admission-errors']), /requires a cached catalog chat model/);
    assert.throws(() => parseArgs(['--model', 'model', '--concurrent']), /requires a cached catalog chat model/);
    assert.throws(() => parseArgs(['--model', 'model', '--cancel-stream']), /requires a cached catalog chat model/);
    assert.throws(() => parseArgs(['--model', 'model', '--idle-eviction']), /requires a cached catalog chat model/);
    assert.throws(() => parseArgs(['--model', 'model', '--require-tools']), /requires a cached catalog chat model/);
    assert.throws(() => parseArgs(['--model', 'model', '--probe-responses']), /requires a cached catalog chat model/);
    assert.throws(() => parseArgs(['--model', 'model', '--disconnect-only']), /requires a cached catalog chat model/);
    assert.throws(() => parseArgs(['--model', 'model', '--switch-model', 'other']), /Variant switching requires/);
    assert.equal(parseArgs(['--model', 'model', '--embeddings', '--retrieval', 'dataset.json']).retrieval, 'dataset.json');
    assert.throws(() => parseArgs(['--model', 'model', '--retrieval', 'dataset.json']), /requires --embeddings/);
    assert.throws(() => parseArgs(['--model']), /requires a folder/);
    assert.throws(() => parseArgs(['--unexpected']), /Unknown argument/);
    console.log('BYOM live runner self-test passed.');
    return;
  }
  if (!args.model) throw new Error('Usage: node .\\scripts\\byom-gateway-live.mjs --model <onnx-genai-folder> [--copy] [--restart] [--embeddings] [--retrieval <dataset.json>] [--preflight] [--admission-errors] [--concurrent] [--cancel-stream] [--idle-eviction] [--require-tools] [--probe-responses] [--disconnect-only] [--packaged-root <release-dir>] [--catalog-alias <alias> --catalog-variant <id>] [--switch-model <folder> --switch-variant <id>]');
  const report = await run(args.model, {
    copy: args.copy, restart: args.restart, embeddings: args.embeddings,
    retrieval: args.retrieval, catalogAlias: args.catalogAlias, catalogVariant: args.catalogVariant,
    preflight: args.preflight, admissionErrors: args.admissionErrors,
    switchModel: args.switchModel, switchVariant: args.switchVariant,
    concurrent: args.concurrent, cancelStream: args.cancelStream, idleEviction: args.idleEviction,
    requireTools: args.requireTools,
    probeResponses: args.probeResponses,
    disconnectOnly: args.disconnectOnly,
    packagedRoot: args.packagedRoot,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.error) process.exitCode = 2;
}

export { catalogCacheTarget, parseArgs, stopSidecar, validateBase64Embeddings, validateEmbeddings };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
