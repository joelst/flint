// Live qualification for a real ONNX GenAI folder through Flint's sidecar and gateway.
// The model stays at its source path; Flint gets a temporary junction under an isolated
// app home, and cleanup removes that junction without touching the source.

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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIAS = 'flint-byom-live';
const PROMPT = 'What is 6 times 7? Reply with one short sentence.';

function parseArgs(argv) {
  const args = { model: null, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--self-test') args.selfTest = true;
    else if (argv[i] === '--model') args.model = path.resolve(argv[++i] ?? '');
    else throw new Error(`Unknown argument: ${argv[i]}`);
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

function startSidecar(home, appName, stderrLines) {
  const child = spawn(process.execPath, ['sidecar/foundry-sidecar.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  const exited = new Promise((resolve) => { exitResolve = resolve; });
  stdout.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.ready === true) readyResolve();
    const entry = pending.get(message?.id);
    if (!entry || message.progress !== undefined || message.stream) return;
    pending.delete(message.id);
    entry.resolve(message);
  });
  child.stderr.on('data', (chunk) => {
    stderrLines.push(chunk.toString());
    while (stderrLines.join('').length > 16000) stderrLines.shift();
  });
  child.once('error', readyReject);
  child.once('exit', (code, signal) => {
    exitResolve({ code, signal });
    readyReject(new Error(`Sidecar exited before readiness (${code ?? signal}).`));
    for (const entry of pending.values()) {
      entry.reject(new Error(`Sidecar exited before command response (${code ?? signal}).`));
    }
    pending.clear();
  });

  function send(cmd, payload = {}, timeoutMs = 10 * 60 * 1000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Sidecar command ${cmd} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      pending.set(id, {
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

  return { child, ready, send, exited };
}

function assertReply(reply, command) {
  if (reply?.ok !== true) {
    throw new Error(`${command} failed: ${reply?.error || JSON.stringify(reply)}`);
  }
  return reply;
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

async function run(modelPath) {
  if (process.platform !== 'win32') {
    throw new Error('The Foundry Local native SDK live spike requires Windows.');
  }
  if (!path.isAbsolute(modelPath) || !fs.statSync(modelPath).isDirectory()) {
    throw new Error('--model must name an existing model directory.');
  }
  if (flintIsRunning()) {
    throw new Error('Quit Flint before this spike creates an isolated Foundry runtime.');
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-byom-gateway-live-'));
  const home = path.join(work, 'home');
  fs.mkdirSync(home, { recursive: true });
  const appName = `flint-byom-live-${process.pid}`;
  const stderrLines = [];
  const report = {
    modelPath,
    sourceUnchanged: false,
    sourceFileCount: 0,
    ipc: null,
    gateway: null,
    error: null,
    cleanupError: null,
  };
  let sidecar;
  let linkedPath = null;
  let sourceBefore;
  try {
    sourceBefore = await snapshotFolder(modelPath);
    report.sourceFileCount = sourceBefore.length;
    sidecar = startSidecar(home, appName, stderrLines);
    await sidecar.ready;
    assertReply(await sidecar.send('init', { appName, logLevel: 'error' }), 'init');
    assertReply(await sidecar.send('ensureAccelerators'), 'ensureAccelerators');
    const linked = assertReply(await sidecar.send('linkModelFolder', {
      folderPath: modelPath,
      name: ALIAS,
    }), 'linkModelFolder').result;
    if (linked.registered !== true) {
      throw new Error(`Local registration failed: ${linked.registrationError || linked.registrationTask || 'unknown reason'}`);
    }
    linkedPath = linked.linkPath;

    const listed = assertReply(await sidecar.send('listModels'), 'listModels').result;
    const local = listed.find((model) => model.alias === ALIAS);
    if (!local || local.info?.uri !== `local://${ALIAS}`) {
      throw new Error('The registered model was not visible in Flint model discovery.');
    }
    const loaded = assertReply(await sidecar.send('load', { alias: ALIAS }), 'load').result;
    const prompt = [{ role: 'user', content: PROMPT }];
    const ipc = assertReply(await sidecar.send('chatCompletion', {
      model: ALIAS,
      messages: prompt,
      maxTokens: 32,
    }, 3 * 60 * 1000), 'chatCompletion').result;
    const ipcText = ipc?.choices?.[0]?.message?.content;
    if (typeof ipcText !== 'string' || !ipcText.trim()) {
      throw new Error('Flint IPC completed without assistant text.');
    }
    report.ipc = { variantId: loaded.variantId, text: ipcText.slice(0, 240) };

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
    if (!Array.isArray(modelRows) || !modelRows.some((model) => model.parent === ALIAS)) {
      throw new Error('The gateway model listing omitted the registered BYOM.');
    }
    const request = { model: ALIAS, messages: prompt, max_tokens: 32 };
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
      discoveredId: modelRows.find((model) => model.parent === ALIAS).id,
      bufferedText: bufferedText.slice(0, 240),
      streamedText: streamed.text.slice(0, 240),
      streamDone: streamed.done,
    };

    assertReply(await sidecar.send('unload', { alias: ALIAS }), 'unload');
    assertReply(await sidecar.send('deleteModel', { alias: ALIAS }), 'deleteModel');
    const finalFiles = await snapshotFolder(modelPath);
    report.sourceUnchanged = JSON.stringify(sourceBefore) === JSON.stringify(finalFiles);
    if (!report.sourceUnchanged) throw new Error('The source model files changed during the test.');
    if (linkedPath && fs.existsSync(linkedPath)) {
      throw new Error('Flint did not remove the isolated link during cleanup.');
    }
  } catch (error) {
    report.error = error?.message || String(error);
    if (stderrLines.length) report.sidecarStderr = stderrLines.join('').slice(-8000);
  } finally {
    if (sidecar?.child && sidecar.child.exitCode === null) {
      try {
        await sidecar.send('shutdownRuntime', { drainTimeoutMs: 10000 }, 15000);
      } catch (error) {
        report.cleanupError = `Graceful sidecar shutdown failed: ${error?.message || error}`;
      }
      if (sidecar.child.exitCode === null) {
        sidecar.child.kill();
        await Promise.race([
          sidecar.exited,
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
      if (sidecar.child.exitCode === null) {
        report.cleanupError = 'The isolated sidecar did not exit; temporary files were retained.';
      }
    }
    if (!sidecar || sidecar.child.exitCode !== null) {
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
    assert.throws(() => parseArgs(['--unexpected']), /Unknown argument/);
    console.log('BYOM live runner self-test passed.');
    return;
  }
  if (!args.model) throw new Error('Usage: node .\\scripts\\byom-gateway-live.mjs --model <onnx-genai-folder>');
  const report = await run(args.model);
  console.log(JSON.stringify(report, null, 2));
  if (report.error) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
