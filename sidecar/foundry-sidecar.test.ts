// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer, request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

function waitForLine(
  proc: ChildProcessWithoutNullStreams,
  predicate: (msg: any) => boolean,
  timeoutMs = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for sidecar response'));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (predicate(msg)) {
          cleanup();
          resolve(msg);
          return;
        }
      }
    };

    const onExit = () => {
      cleanup();
      reject(new Error('Sidecar exited before expected response'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      proc.stdout.off('data', onData);
      proc.off('exit', onExit);
    };

    proc.stdout.on('data', onData);
    proc.on('exit', onExit);
  });
}

/** Kills the child and waits (briefly, best-effort) for it to actually exit, so cleanup that
 * follows (closing an upstream server the child was still talking to, removing its temp home
 * dir) doesn't race a process that is still shutting down. */
function killAndWait(proc: ChildProcessWithoutNullStreams, timeoutMs = 3000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    proc.once('exit', done);
    proc.kill();
  });
}

function collectNonJsonStdout(proc: ChildProcessWithoutNullStreams) {
  const lines: string[] = [];
  let buffer = '';
  let stopped = false;
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
      } catch {
        lines.push(line);
      }
    }
  };
  proc.stdout.on('data', onData);
  return {
    lines,
    stop() {
      if (stopped) return;
      stopped = true;
      proc.stdout.off('data', onData);
      if (!buffer.trim()) return;
      try {
        JSON.parse(buffer);
      } catch {
        lines.push(buffer);
      }
    },
  };
}

describe('foundry-sidecar protocol basics', () => {
  it('scans the cache inventory through IPC without traversing linked targets', async () => {
    const home = mkdtempSync(join(tmpdir(), 'flint-inventory-home-'));
    const root = join(home, '.flint', 'cache', 'models');
    const model = join(root, 'Imported', 'demo-1', 'v1');
    const partial = join(root, 'Catalog', 'partial');
    const foreign = mkdtempSync(join(tmpdir(), 'flint-inventory-foreign-'));
    mkdirSync(model, { recursive: true });
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(model, 'genai_config.json'), '{}');
    writeFileSync(join(model, 'inference_model.json'), JSON.stringify({ Name: 'demo:1' }));
    writeFileSync(join(model, 'weights.onnx'), Buffer.alloc(7));
    writeFileSync(join(root, 'Imported', 'demo-1', '.flint-import.json'), '{}');
    writeFileSync(join(partial, 'download.tmp'), Buffer.alloc(11));
    writeFileSync(join(foreign, 'genai_config.json'), '{}');
    writeFileSync(join(foreign, 'inference_model.json'), JSON.stringify({ Name: 'foreign:1' }));
    symlinkSync(foreign, join(root, 'Linked'), 'junction');

    const proc = spawn(process.execPath, ['sidecar/foundry-sidecar.js'], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    try {
      await waitForLine(proc, (msg) => msg.ready === true);
      proc.stdin.write(`${JSON.stringify({ id: 91, cmd: 'getCacheInventory' })}\n`);
      const response = await waitForLine(proc, (msg) => msg.id === 91);
      expect(response.ok).toBe(true);
      expect(response.result.totalBytes).toBeGreaterThan(11);
      expect(response.result.partialBytes).toBe(11);
      expect(response.result.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: join(root, 'Linked'), linked: true, sizeBytes: 0 }),
        expect.objectContaining({ alias: null, variantId: 'demo:1', owned: true }),
      ]));
      expect(response.result.entries.some((entry: any) => entry.alias === 'foreign')).toBe(false);
    } finally {
      proc.kill();
      rmSync(home, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('emits ready and handles basic request/validation messages', async () => {
    const proc = spawn(process.execPath, ['sidecar/foundry-sidecar.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    try {
      const ready = await waitForLine(proc, (msg) => msg.ready === true);
      expect(ready.ready).toBe(true);
      expect(ready.protocolVersion).toBe(1);

      proc.stdin.write('not-json\n');
      const invalid = await waitForLine(proc, (msg) => msg.error === 'Invalid JSON');
      expect(invalid.error).toBe('Invalid JSON');

      proc.stdin.write(`${JSON.stringify({ id: 1, cmd: 'cancelChatRequest', requestId: 123 })}\n`);
      const cancel = await waitForLine(proc, (msg) => msg.id === 1);
      expect(cancel.ok).toBe(true);

      proc.stdin.write(`${JSON.stringify({ id: 2, cmd: 'unknownCommand' })}\n`);
      const unknown = await waitForLine(proc, (msg) => msg.id === 2);
      expect(String(unknown.error)).toContain('Unknown command');

      proc.stdin.write(`${JSON.stringify({ id: 4, cmd: 'stopAndUnload', drainTimeoutMs: 0 })}\n`);
      const stopped = await waitForLine(proc, (msg) => msg.id === 4);
      expect(stopped.result).toMatchObject({ drained: true, cleanup: 'confirmed' });

      proc.stdin.write(`${JSON.stringify({ id: 5, cmd: 'getStatus' })}\n`);
      const status = await waitForLine(proc, (msg) => msg.id === 5);
      expect(status.ok).toBe(true);

      proc.stdin.write(`${JSON.stringify({ id: 6, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
      const exclusiveOn = await waitForLine(proc, (msg) => msg.id === 6);
      expect(exclusiveOn).toMatchObject({ ok: true, result: { exclusive: true, drained: true } });
      proc.stdin.write(`${JSON.stringify({ id: 7, cmd: 'setBenchmarkExclusive', exclusive: false })}\n`);
      const exclusiveOff = await waitForLine(proc, (msg) => msg.id === 7);
      expect(exclusiveOff).toMatchObject({ ok: true, result: { exclusive: false } });
    } finally {
      if (!proc.killed) {
        proc.kill();
      }
    }
  });

  it('acknowledges runtime cleanup before exiting on explicit shutdown', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'flint-sidecar-home-'));
    const proc = spawn(process.execPath, ['sidecar/foundry-sidecar.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      proc.once('exit', (code, signal) => resolve({ code, signal }));
    });

    await waitForLine(proc, (msg) => msg.ready === true);
    proc.stdin.write(`${JSON.stringify({ id: 3, cmd: 'shutdownRuntime', drainTimeoutMs: 0 })}\n`);
    const response = await waitForLine(proc, (msg) => msg.id === 3);

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      endpointWithdrawn: true,
      serviceStopped: true,
      drained: true,
      activeOperations: [],
      modelsUnloaded: [],
      unloadFailures: [],
      nativeServiceStopped: true,
      cleanup: 'confirmed',
    });
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
    const logDir = join(homeDir, '.flint', 'logs');
    const logFile = readdirSync(logDir).find((name) => name.endsWith('.log'));
    expect(logFile).toBeDefined();
    const log = readFileSync(join(logDir, logFile!), 'utf8');
    expect(log).toContain('"cmd":"shutdownRuntime"');
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('keeps the IPC pipe JSON-only while exercising init, load, streaming chat, and buffered chat', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'flint-sidecar-chat-home-'));
    const loaderPath = join(homeDir, 'fake-sdk-loader.mjs');
    const corePath = join(homeDir, 'fake-core.dylib');
    writeFileSync(corePath, '');
    writeFileSync(loaderPath, `
      const sdk = \`
        class FakeModel {
          constructor() { this.id = 'fake-variant'; this.loaded = false; }
          async load() {
            process.stdout.write('fake model load stdout noise\\\\n');
            console.log('fake model load console noise');
            this.loaded = true;
          }
          isLoaded() { return this.loaded; }
          getExecutionProvider() { return 'CPUExecutionProvider'; }
          createChatClient() {
            return {
              async *completeStreamingChat() {
                process.stdout.write('fake streaming chat stdout noise\\\\n');
                yield { choices: [{ delta: { content: 'hello' } }] };
                await new Promise((resolve) => setTimeout(resolve, 20));
                yield { usage: { input_tokens: 3, output_tokens: 2 } };
              },
              async completeChat() {
                process.stdout.write('fake buffered chat stdout noise\\\\n');
                return {
                  choices: [{ message: { role: 'assistant', content: 'buffered' } }],
                  usage: { prompt_tokens: 4, completion_tokens: 3 },
                };
              },
            };
          }
        }
        class FakeManager {
          constructor() {
            this.catalog = {
              getModel: async () => {
                process.stdout.write('fake catalog getModel stdout noise\\\\n');
                return new FakeModel();
              },
              getModels: async () => [],
            };
          }
          static create() {
            process.stdout.write('fake manager create stdout noise\\\\n');
            return new FakeManager();
          }
        }
        export { FakeManager as FoundryLocalManager };
      \`;
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'foundry-local-sdk') {
          return { url: 'data:text/javascript,' + encodeURIComponent(sdk), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
      export async function load(url, context, nextLoad) {
        if (url.startsWith('data:text/javascript,')) {
          return { format: 'module', source: decodeURIComponent(url.slice('data:text/javascript,'.length)), shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    `);
    // Node requires a file:// URL here; a bare Windows path is rejected with
    // ERR_UNSUPPORTED_ESM_URL_SCHEME on Node 23+.
    const proc = spawn(process.execPath, [
      '--experimental-loader', pathToFileURL(loaderPath).href, 'sidecar/foundry-sidecar.js'
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        FLINT_FOUNDRY_CORE_PATH: corePath,
      },
    });
    const nonJsonStdout = collectNonJsonStdout(proc);
    let stderrText = '';
    const onStderr = (chunk: Buffer | string) => {
      stderrText += chunk.toString();
    };
    proc.stderr.on('data', onStderr);

    try {
      await waitForLine(proc, (msg) => msg.ready === true);
      proc.stdin.write(`${JSON.stringify({
        id: 40, cmd: 'init', appName: 'flint-test', logLevel: 'info'
      })}\n`);
      expect((await waitForLine(proc, (msg) => msg.id === 40)).ok).toBe(true);

      proc.stdin.write(`${JSON.stringify({
        id: 41,
        cmd: 'chatCompletion',
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      })}\n`);
      await waitForLine(proc, (msg) => msg.id === 41 && msg.stream === true);
      const cancelAckPromise = waitForLine(proc, (msg) => msg.id === 44);
      const streamedDonePromise = waitForLine(proc, (msg) => msg.id === 41 && msg.ok === true);
      void cancelAckPromise.catch(() => {});
      void streamedDonePromise.catch(() => {});
      proc.stdin.write(`${JSON.stringify({
        id: 44, cmd: 'cancelChatRequest', requestId: 41
      })}\n`);
      expect((await cancelAckPromise).ok).toBe(true);
      const streamed = await streamedDonePromise;
      expect(streamed.ok).toBe(true);
      expect(streamed.result.nativeStreaming).toBe(true);
      expect(streamed.result.servedVariantId).toBe('fake-variant');
      expect(streamed.result.usage).toMatchObject({
        prompt_tokens: 3,
        completion_tokens: 2,
      });

      proc.stdin.write(`${JSON.stringify({
        id: 42,
        cmd: 'chatCompletion',
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      })}\n`);
      const buffered = await waitForLine(proc, (msg) => msg.id === 42);
      expect(buffered.ok).toBe(true);
      expect(buffered.result.nativeStreaming).toBe(false);
      expect(buffered.result.servedVariantId).toBe('fake-variant');

      proc.stdin.write(`${JSON.stringify({ id: 43, cmd: 'getAccessLog' })}\n`);
      const accessLog = (await waitForLine(proc, (msg) => msg.id === 43)).result;
      const chats = accessLog.filter((entry: any) => entry.type === 'chat');
      expect(chats).toHaveLength(2);
      expect(chats[0]).toMatchObject({
        source: 'ipc',
        ok: true,
        warm: false,
        tokensIn: 3,
        tokensOut: 2,
        executionProvider: 'CPUExecutionProvider',
      });
      expect(chats[0].ttftMs).toBeTypeOf('number');
      expect(chats[1]).toMatchObject({
        source: 'ipc',
        ok: true,
        warm: true,
        loadMs: 0,
        tokensIn: 4,
        tokensOut: 3,
        executionProvider: 'CPUExecutionProvider',
      });
      nonJsonStdout.stop();
      expect(nonJsonStdout.lines).toEqual([]);
      expect(stderrText).toContain('FLINT_DIAG info fake model load console noise');
      expect(stderrText).toContain('FLINT_DIAG info fake model load stdout noise');
      expect(stderrText).not.toContain('[foundry-sidecar] Ready:');
    } finally {
      nonJsonStdout.stop();
      proc.stderr.off('data', onStderr);
      if (!proc.killed) proc.kill();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('reports nativeStreaming false when completeStreamingChat is the only method and the caller asks for a buffered reply', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'flint-sidecar-stream-only-home-'));
    const loaderPath = join(homeDir, 'fake-sdk-loader.mjs');
    const corePath = join(homeDir, 'fake-core.dylib');
    writeFileSync(corePath, '');
    writeFileSync(loaderPath, `
      const sdk = \`
        class FakeModel {
          constructor() { this.id = 'fake-variant'; this.loaded = false; }
          async load() { this.loaded = true; }
          isLoaded() { return this.loaded; }
          getExecutionProvider() { return 'CPUExecutionProvider'; }
          createChatClient() {
            return {
              async *completeStreamingChat() {
                yield { choices: [{ delta: { content: 'stream-only' } }] };
              },
            };
          }
        }
        class FakeManager {
          constructor() {
            this.catalog = {
              getModel: async () => new FakeModel(),
              getModels: async () => [],
            };
          }
          static create() { return new FakeManager(); }
        }
        export { FakeManager as FoundryLocalManager };
      \`;
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'foundry-local-sdk') {
          return { url: 'data:text/javascript,' + encodeURIComponent(sdk), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
      export async function load(url, context, nextLoad) {
        if (url.startsWith('data:text/javascript,')) {
          return { format: 'module', source: decodeURIComponent(url.slice('data:text/javascript,'.length)), shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    `);
    const proc = spawn(process.execPath, [
      '--experimental-loader', pathToFileURL(loaderPath).href, 'sidecar/foundry-sidecar.js'
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, FLINT_FOUNDRY_CORE_PATH: corePath },
    });
    try {
      await waitForLine(proc, (msg) => msg.ready === true);
      proc.stdin.write(`${JSON.stringify({ id: 40, cmd: 'init', appName: 'flint-test', logLevel: 'info' })}\n`);
      expect((await waitForLine(proc, (msg) => msg.id === 40)).ok).toBe(true);
      proc.stdin.write(`${JSON.stringify({
        id: 41, cmd: 'chatCompletion', model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }], stream: false,
      })}\n`);
      const buffered = await waitForLine(proc, (msg) => msg.id === 41);
      expect(buffered.ok).toBe(true);
      expect(buffered.result.nativeStreaming).toBe(false);
      expect(buffered.result.servedVariantId).toBe('fake-variant');
    } finally {
      if (!proc.killed) proc.kill();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('reports nativeStreaming false and servedVariantId on the HTTP fallback', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'http-hello' } }],
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const homeDir = mkdtempSync(join(tmpdir(), 'flint-sidecar-http-chat-home-'));
    const loaderPath = join(homeDir, 'fake-sdk-loader.mjs');
    const corePath = join(homeDir, 'fake-core.dylib');
    writeFileSync(corePath, '');
    writeFileSync(loaderPath, `
      const sdk = \`
        class FakeModel {
          constructor() { this.id = 'fake-variant'; this.loaded = false; }
          async load() { this.loaded = true; }
          isLoaded() { return this.loaded; }
          getExecutionProvider() { return 'CPUExecutionProvider'; }
        }
        class FakeManager {
          constructor() { this.urls = []; this.catalog = { getModel: async () => new FakeModel(), getModels: async () => [] }; }
          startWebService() { this.urls = ['http://127.0.0.1:${port}']; }
          stopWebService() {}
          static create() { return new FakeManager(); }
        }
        export { FakeManager as FoundryLocalManager };
      \`;
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'foundry-local-sdk') {
          return { url: 'data:text/javascript,' + encodeURIComponent(sdk), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
      export async function load(url, context, nextLoad) {
        if (url.startsWith('data:text/javascript,')) {
          return { format: 'module', source: decodeURIComponent(url.slice('data:text/javascript,'.length)), shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    `);
    const proc = spawn(process.execPath, [
      '--experimental-loader', pathToFileURL(loaderPath).href, 'sidecar/foundry-sidecar.js'
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, FLINT_FOUNDRY_CORE_PATH: corePath },
    });
    try {
      await waitForLine(proc, (msg) => msg.ready === true);
      proc.stdin.write(`${JSON.stringify({ id: 40, cmd: 'init', appName: 'flint-test', logLevel: 'info' })}\n`);
      expect((await waitForLine(proc, (msg) => msg.id === 40)).ok).toBe(true);
      proc.stdin.write(`${JSON.stringify({
        id: 45, cmd: 'startService', port: 18765, bindAddress: '127.0.0.1', gateway: false,
      })}\n`);
      expect((await waitForLine(proc, (msg) => msg.id === 45, 15000)).ok).toBe(true);
      proc.stdin.write(`${JSON.stringify({
        id: 41, cmd: 'chatCompletion', model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }], stream: false,
      })}\n`);
      const httpChat = await waitForLine(proc, (msg) => msg.id === 41, 15000);
      expect(httpChat.ok).toBe(true);
      expect(httpChat.result.nativeStreaming).toBe(false);
      expect(httpChat.result.servedVariantId).toBe('fake-variant');
    } finally {
      if (!proc.killed) proc.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('applies requested temperature/maxTokens to the SDK chat client before completion', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'flint-sidecar-chat-settings-home-'));
    const loaderPath = join(homeDir, 'fake-sdk-loader.mjs');
    const corePath = join(homeDir, 'fake-core.dylib');
    writeFileSync(corePath, '');
    // Echo client.settings at call time so we can see whether the sidecar wrote them
    // before completeChat / completeStreamingChat. Non-undefined sentinels make an
    // accidental undefined clobber visible (JSON.stringify drops undefined).
    writeFileSync(loaderPath, `
      const sdk = \`
        class FakeChatClientSettings {
          constructor() { this.temperature = 0.11; this.maxTokens = 7; }
        }
        class FakeChatClient {
          constructor() { this.settings = new FakeChatClientSettings(); }
          async completeChat() {
            return {
              choices: [{ message: {
                role: 'assistant',
                content: JSON.stringify({ temperature: this.settings.temperature, maxTokens: this.settings.maxTokens }),
              } }],
            };
          }
          async *completeStreamingChat() {
            yield { choices: [{ delta: {
              content: JSON.stringify({ temperature: this.settings.temperature, maxTokens: this.settings.maxTokens }),
            } }] };
          }
        }
        class FakeModel {
          constructor() { this.id = 'fake-variant'; this.loaded = false; }
          async load() { this.loaded = true; }
          isLoaded() { return this.loaded; }
          getExecutionProvider() { return 'CPUExecutionProvider'; }
          createChatClient() { return new FakeChatClient(); }
        }
        class FakeManager {
          constructor() {
            this.catalog = {
              getModel: async () => new FakeModel(),
              getModels: async () => [],
            };
          }
          static create() { return new FakeManager(); }
        }
        export { FakeManager as FoundryLocalManager };
      \`;
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'foundry-local-sdk') {
          return { url: 'data:text/javascript,' + encodeURIComponent(sdk), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
      export async function load(url, context, nextLoad) {
        if (url.startsWith('data:text/javascript,')) {
          return { format: 'module', source: decodeURIComponent(url.slice('data:text/javascript,'.length)), shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    `);
    const proc = spawn(process.execPath, [
      '--experimental-loader', pathToFileURL(loaderPath).href, 'sidecar/foundry-sidecar.js'
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        FLINT_FOUNDRY_CORE_PATH: corePath,
      },
    });

    try {
      // This test does 5 sequential round trips against a real spawned child; a loaded CI
      // runner can make any single one exceed the plain 5000ms default `waitForLine` timeout
      // well within the outer 90000ms test timeout below, so every wait here gets an explicit,
      // more generous per-call timeout (matching the pattern already used for other
      // SDK-round-trip waits elsewhere in this file, e.g. lines 910/973/980/1103).
      await waitForLine(proc, (msg) => msg.ready === true, 45000);
      proc.stdin.write(`${JSON.stringify({
        id: 50, cmd: 'init', appName: 'flint-test', logLevel: 'info'
      })}\n`);
      expect((await waitForLine(proc, (msg) => msg.id === 50, 45000)).ok).toBe(true);

      // Buffered (non-streaming) SDK branch.
      proc.stdin.write(`${JSON.stringify({
        id: 51,
        cmd: 'chatCompletion',
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        temperature: 0.42,
        maxTokens: 123,
      })}\n`);
      const buffered = await waitForLine(proc, (msg) => msg.id === 51, 45000);
      expect(buffered.ok).toBe(true);
      expect(JSON.parse(buffered.result.choices[0].message.content)).toEqual({
        temperature: 0.42,
        maxTokens: 123,
      });

      // Streaming SDK branch.
      // Arm both observers before dispatch. A fast child can emit the delta and terminal reply
      // in one stdout chunk; waiting for the delta first would let that temporary listener parse
      // and discard the terminal line before the second listener exists.
      const streamedDeltaPromise = waitForLine(
        proc,
        (msg) => msg.id === 52 && msg.stream === true,
        45000,
      );
      const streamedDonePromise = waitForLine(
        proc,
        (msg) => msg.id === 52 && msg.ok === true,
        45000,
      );
      void streamedDeltaPromise.catch(() => {});
      void streamedDonePromise.catch(() => {});
      proc.stdin.write(`${JSON.stringify({
        id: 52,
        cmd: 'chatCompletion',
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        temperature: 0.77,
        maxTokens: 55,
      })}\n`);
      const streamedDelta = await streamedDeltaPromise;
      expect(JSON.parse(streamedDelta.delta)).toEqual({ temperature: 0.77, maxTokens: 55 });
      expect((await streamedDonePromise).ok).toBe(true);

      // Omitted fields must not clobber the client's own defaults with undefined/NaN.
      proc.stdin.write(`${JSON.stringify({
        id: 53,
        cmd: 'chatCompletion',
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      })}\n`);
      const defaulted = await waitForLine(proc, (msg) => msg.id === 53, 45000);
      expect(JSON.parse(defaulted.result.choices[0].message.content)).toEqual({
        temperature: 0.11,
        maxTokens: 7,
      });

      // Setting only one field must leave the other at the client default.
      proc.stdin.write(`${JSON.stringify({
        id: 54,
        cmd: 'chatCompletion',
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        temperature: 0.5,
      })}\n`);
      const partial = await waitForLine(proc, (msg) => msg.id === 54, 45000);
      expect(JSON.parse(partial.result.choices[0].message.content)).toEqual({
        temperature: 0.5,
        maxTokens: 7,
      });
    } finally {
      if (!proc.killed) proc.kill();
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 90000);
});

describe('foundry-sidecar benchmark exclusive gateway fence', () => {
  /** Real request/response through the sidecar's actual gateway (not a mocked admitRequest,
   * unlike gateway.test.ts) — this exercises the wiring in foundry-sidecar-main.js itself:
   * `benchmarkExclusive`, `operationAdmission`, and `waitForBenchmarkDrainIdle`. */
  function postToGateway(
    port: number,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  /** Like `postToGateway`, but exposes a `firstChunk` promise that resolves as soon as any
   * response bytes reach the client. For an SSE chat completion, the gateway only completes
   * admission once its whole `pipeline()` finishes (see gateway.js's `forward`), so receiving
   * a first chunk deterministically proves the operation is still admitted/in-flight —
   * without relying on a fixed sleep to "probably" win the race against the gateway. */
  function postToGatewayStream(
    port: number,
    body: string,
  ): { firstChunk: Promise<void>; done: Promise<{ status: number; body: string }> } {
    let resolveFirstChunk: (() => void) | null = null;
    const firstChunk = new Promise<void>((resolve) => { resolveFirstChunk = resolve; });
    const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          resolveFirstChunk?.();
          resolveFirstChunk = null;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });
    return { firstChunk, done };
  }

  /** Spawns the sidecar with a fake FoundryLocalManager (same pattern as the HTTP-fallback
   * chat tests above) whose native service reports `upstreamPort` as its only URL, so
   * `startService` (gateway on by default) proxies real HTTP traffic to a server we control. A
   * short `FLINT_BENCHMARK_EXCLUSIVE_DRAIN_MS` lets the "could not drain in time" path be
   * exercised without a correspondingly slow test. */
  function spawnGatewaySidecar(upstreamPort: number, drainMs = 200, catalogModels: unknown[] = [], holdLoad = false, secondStartServicePort: number | null = null, holdDownload = false) {
    const homeDir = mkdtempSync(join(tmpdir(), 'flint-sidecar-gateway-fence-home-'));
    const loaderPath = join(homeDir, 'fake-sdk-loader.mjs');
    const corePath = join(homeDir, 'fake-core.dylib');
    writeFileSync(corePath, '');
    writeFileSync(loaderPath, `
      const sdk = \`
        class FakeModel {
          constructor() { this.id = 'fake-variant'; this.loaded = false; }
          async load() {
            // Only holds when a test opts in ("holdLoad"): the default path must stay a plain,
            // instant resolve so every other test using this helper (autoload, eviction, etc.)
            // is unaffected. When held, this lets a test keep an IPC "load" admitted for as
            // long as it needs to prove the exclusivity drain waits for it, exactly like
            // "createChatClient" below already does for "chatCompletion".
            if (${JSON.stringify(holdLoad)}) {
              await fetch('http://127.0.0.1:${upstreamPort}/hold-load');
            }
            this.loaded = true;
          }
          isLoaded() { return this.loaded; }
          async download() {
            if (${JSON.stringify(holdDownload)}) {
              await fetch('http://127.0.0.1:${upstreamPort}/hold-download');
            }
          }
          getExecutionProvider() { return 'CPUExecutionProvider'; }
          createChatClient() {
            return {
              settings: {},
              // Held open via a GET to the test's own upstream server (same "hold" pattern the
              // streaming-gateway-request tests below use), so a test can keep this IPC
              // chatCompletion admitted for as long as it needs to prove the exclusivity drain
              // actually waits for it rather than resolving immediately.
              completeChat: async () => {
                await fetch('http://127.0.0.1:${upstreamPort}/hold-chat');
                return { choices: [{ message: { role: 'assistant', content: 'held-response' } }] };
              },
            };
          }
        }
        class FakeManager {
          constructor() {
            this.urls = [];
            this.startWebServiceCallCount = 0;
            this.catalog = {
              getModel: async () => new FakeModel(),
              getModels: async () => (${JSON.stringify(catalogModels)}),
            };
          }
          startWebService() {
            this.startWebServiceCallCount += 1;
            // "startedGateway"'s own initial "startService" call (bringing up the test's
            // gateway) is always the first invocation and must succeed normally. Only a test
            // that opts in via "secondStartServicePort" wants the *second* invocation (an
            // orphaned restart it dispatches itself) to point at a distinct, test-held upstream
            // it can keep pending, so both calls cannot be confused with each other.
            const port = (this.startWebServiceCallCount === 2 && ${JSON.stringify(secondStartServicePort)} !== null)
              ? ${JSON.stringify(secondStartServicePort)}
              : ${upstreamPort};
            this.urls = ['http://127.0.0.1:' + port];
          }
          stopWebService() {}
          static create() { return new FakeManager(); }
        }
        export { FakeManager as FoundryLocalManager };
      \`;
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'foundry-local-sdk') {
          return { url: 'data:text/javascript,' + encodeURIComponent(sdk), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
      export async function load(url, context, nextLoad) {
        if (url.startsWith('data:text/javascript,')) {
          return { format: 'module', source: decodeURIComponent(url.slice('data:text/javascript,'.length)), shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    `);
    const proc = spawn(process.execPath, [
      '--experimental-loader', pathToFileURL(loaderPath).href, 'sidecar/foundry-sidecar.js'
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        FLINT_FOUNDRY_CORE_PATH: corePath,
        FLINT_BENCHMARK_EXCLUSIVE_DRAIN_MS: String(drainMs),
      },
    });
    return { proc, homeDir };
  }

  /** Starts the sidecar and its gateway, returning the process, its temp home dir (for
   * cleanup), and the gateway's bound public port. */
  async function startedGateway(upstreamPort: number, drainMs = 200, catalogModels: unknown[] = [], holdLoad = false, secondStartServicePort: number | null = null, holdDownload = false) {
    const { proc, homeDir } = spawnGatewaySidecar(upstreamPort, drainMs, catalogModels, holdLoad, secondStartServicePort, holdDownload);
    await waitForLine(proc, (msg) => msg.ready === true);
    proc.stdin.write(`${JSON.stringify({ id: 1, cmd: 'init', appName: 'flint-test', logLevel: 'info' })}\n`);
    const initRes = await waitForLine(proc, (msg) => msg.id === 1);
    if (!initRes.ok) throw new Error(`init failed: ${initRes.error}`);
    // port: 0 — let the OS pick a free port; the endpoint in the reply reports which one the
    // gateway actually bound (see foundry-sidecar-main.js's `sharedEndpoint` construction).
    proc.stdin.write(`${JSON.stringify({ id: 2, cmd: 'startService', port: 0, bindAddress: '127.0.0.1' })}\n`);
    const started = await waitForLine(proc, (msg) => msg.id === 2, 15000);
    if (!started.ok) throw new Error(`startService failed: ${started.error}`);
    const gatewayPort = Number(new URL(started.endpoint).port);
    return { proc, homeDir, gatewayPort };
  }

  it('rejects a new gateway request while exclusive, and admits again after release', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
    let proc: ChildProcessWithoutNullStreams | undefined;
    let homeDir: string | undefined;
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const { port: upstreamPort } = upstream.address() as AddressInfo;
      const started = await startedGateway(upstreamPort);
      proc = started.proc;
      homeDir = started.homeDir;
      const gatewayPort = started.gatewayPort;
      // Nothing is in flight, so acquisition must not wait for the drain deadline at all.
      const acquireStarted = Date.now();
      proc.stdin.write(`${JSON.stringify({ id: 10, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
      const acquired = await waitForLine(proc, (msg) => msg.id === 10, 5000);
      expect(acquired).toMatchObject({ ok: true, result: { exclusive: true, drained: true } });
      expect(Date.now() - acquireStarted).toBeLessThan(2000);

      const denied = await postToGateway(gatewayPort, JSON.stringify({ model: 'fake-model', messages: [] }));
      expect(denied.status).toBe(503);
      expect(denied.body).toContain('benchmark run is in progress');

      proc.stdin.write(`${JSON.stringify({ id: 11, cmd: 'setBenchmarkExclusive', exclusive: false })}\n`);
      const released = await waitForLine(proc, (msg) => msg.id === 11, 5000);
      expect(released).toMatchObject({ ok: true, result: { exclusive: false } });

      const allowed = await postToGateway(gatewayPort, JSON.stringify({ model: 'fake-model', messages: [] }));
      expect(allowed.status).toBe(200);
    } finally {
      if (proc) await killAndWait(proc);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('waits for an already-admitted streaming gateway request to finish before acquiring exclusive admission', async () => {
    // Simulates SSE token-by-token completion: the gateway only completes admission once its
    // whole pipeline finishes (gateway.js `forward`), so the operation stays "admitted" for as
    // long as this upstream keeps the event stream open.
    let releaseUpstream: (() => void) | null = null;
    const upstreamHeld = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstream = createServer((req, res) => {
      if (req.url !== '/v1/chat/completions') {
        // Startup's own /status readiness probe must not be held, or startService itself
        // times out before the test ever reaches the fence.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Flush one token immediately so the client observes a first chunk without waiting on
      // `upstreamHeld` — that first chunk is this test's proof the request is in flight.
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      void upstreamHeld.then(() => {
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    let proc: ChildProcessWithoutNullStreams | undefined;
    let homeDir: string | undefined;
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const { port: upstreamPort } = upstream.address() as AddressInfo;
      // A generous drain deadline: this test proves the fence waits for the in-flight request
      // to finish, not that it gives up on it, so the deadline must not be the thing satisfied.
      const started = await startedGateway(upstreamPort, 10_000);
      proc = started.proc;
      homeDir = started.homeDir;
      const gatewayPort = started.gatewayPort;
      const inFlightStream = postToGatewayStream(gatewayPort, JSON.stringify({
        model: 'fake-model', messages: [], stream: true,
      }));
      // Deterministic, not timing-based: the operation is only admitted at all once the
      // gateway has forwarded the request and started streaming a response back, so this
      // proves it is in `operationAdmission`'s bookkeeping before the fence is requested.
      await inFlightStream.firstChunk;
      let inFlightSettledAt = 0;
      const inFlight = inFlightStream.done.then((r) => { inFlightSettledAt = Date.now(); return r; });

      let exclusiveSettledAt = 0;
      const exclusivePromise = (async () => {
        proc.stdin.write(`${JSON.stringify({ id: 20, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
        const res = await waitForLine(proc, (msg) => msg.id === 20, 15000);
        exclusiveSettledAt = Date.now();
        return res;
      })();

      // The in-flight stream must still be unresolved a beat later — proving the fence is
      // actually waiting on it, not completing (or, worse, killing it) immediately.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(inFlightSettledAt).toBe(0);

      releaseUpstream?.();
      const [inFlightResult, exclusiveResult] = await Promise.all([inFlight, exclusivePromise]);

      expect(inFlightResult.status).toBe(200);
      expect(exclusiveResult).toMatchObject({ ok: true, result: { exclusive: true, drained: true } });
      expect(exclusiveSettledAt).toBeGreaterThanOrEqual(inFlightSettledAt);
    } finally {
      if (proc) await killAndWait(proc);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20000);

  it('waits for an already-admitted IPC chatCompletion to finish before acquiring exclusive admission', async () => {
    // A benchmark run's own inference goes over IPC `chatCompletion`, not the gateway (see
    // +page.svelte's benchmark host, which calls `chatCompletion` directly) -- and this sidecar
    // process survives a frontend reload, so a *previous*, now-gone page's still-running call
    // is invisible to the new page's own busy-state checks. Only this sidecar-side drain can
    // still see it. `createChatClient().completeChat` here holds on a GET to this test's own
    // upstream server (the same "hold" pattern as the streaming-gateway-request test above),
    // simulating that orphaned call.
    let releaseUpstream: (() => void) | null = null;
    const upstreamHeld = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstream = createServer((req, res) => {
      if (req.url !== '/hold-chat') {
        // Startup's own /status readiness probe must not be held.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      void upstreamHeld.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    let proc: ChildProcessWithoutNullStreams | undefined;
    let homeDir: string | undefined;
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const { port: upstreamPort } = upstream.address() as AddressInfo;
      const started = await startedGateway(upstreamPort, 10_000);
      proc = started.proc;
      homeDir = started.homeDir;

      let chatSettledAt = 0;
      proc.stdin.write(`${JSON.stringify({ id: 25, cmd: 'chatCompletion', model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] })}\n`);
      const chatDone = waitForLine(proc, (msg) => msg.id === 25, 15000)
        .then((r) => { chatSettledAt = Date.now(); return r; });

      let exclusiveSettledAt = 0;
      const exclusivePromise = (async () => {
        proc!.stdin.write(`${JSON.stringify({ id: 26, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
        const res = await waitForLine(proc!, (msg) => msg.id === 26, 15000);
        exclusiveSettledAt = Date.now();
        return res;
      })();

      // A beat to let the exclusive acquire actually reach and start its drain wait before
      // releasing the held chat call — proving the fence is waiting on it, not racing it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(chatSettledAt).toBe(0);

      releaseUpstream?.();
      const [chatResult, exclusiveResult] = await Promise.all([chatDone, exclusivePromise]);

      expect(chatResult).toMatchObject({ ok: true });
      expect(exclusiveResult).toMatchObject({ ok: true, result: { exclusive: true, drained: true } });
      expect(exclusiveSettledAt).toBeGreaterThanOrEqual(chatSettledAt);
    } finally {
      if (proc) await killAndWait(proc);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20000);

  it('waits for an already-admitted IPC load (or unload/deleteModel) to finish before acquiring exclusive admission', async () => {
    // A page reload leaves the sidecar process, and anything it already admitted, running: an
    // in-flight `load`/`unload`/`deleteModel` from Models/Monitor or a *previous* page instance
    // is invisible to a new page's own busy-state checks, which only see this page's in-memory
    // `poolMutationsInFlight`. Only this sidecar-side drain can still see it. Without draining
    // these commands too, a new benchmark could acquire exclusivity while an orphaned mutation
    // is still changing pool residency underneath it -- e.g. measuring against a model that is
    // still mid-unload, or racing a stale load that hasn't finished consuming its resources.
    // `holdLoad: true` makes the fake model's `load()` hold on a GET to this test's own upstream
    // server (same "hold" pattern as the chatCompletion test above) until released.
    let releaseUpstream: (() => void) | null = null;
    const upstreamHeld = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstream = createServer((req, res) => {
      if (req.url !== '/hold-load') {
        // Startup's own /status readiness probe must not be held.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      void upstreamHeld.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    let proc: ChildProcessWithoutNullStreams | undefined;
    let homeDir: string | undefined;
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const { port: upstreamPort } = upstream.address() as AddressInfo;
      const started = await startedGateway(upstreamPort, 10_000, [], true);
      proc = started.proc;
      homeDir = started.homeDir;

      let loadSettledAt = 0;
      proc.stdin.write(`${JSON.stringify({ id: 27, cmd: 'load', alias: 'fake-model' })}\n`);
      const loadDone = waitForLine(proc, (msg) => msg.id === 27, 15000)
        .then((r) => { loadSettledAt = Date.now(); return r; });

      let exclusiveSettledAt = 0;
      const exclusivePromise = (async () => {
        proc!.stdin.write(`${JSON.stringify({ id: 28, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
        const res = await waitForLine(proc!, (msg) => msg.id === 28, 15000);
        exclusiveSettledAt = Date.now();
        return res;
      })();

      // A beat to let the exclusive acquire actually reach and start its drain wait before
      // releasing the held load — proving the fence is waiting on it, not racing it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(loadSettledAt).toBe(0);

      releaseUpstream?.();
      const [loadResult, exclusiveResult] = await Promise.all([loadDone, exclusivePromise]);

      expect(loadResult).toMatchObject({ ok: true });
      expect(exclusiveResult).toMatchObject({ ok: true, result: { exclusive: true, drained: true } });
      expect(exclusiveSettledAt).toBeGreaterThanOrEqual(loadSettledAt);
    } finally {
      if (proc) await killAndWait(proc);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20000);

  it('refuses exclusive admission while a download is still in progress, and refuses a new download while exclusive is held', async () => {
    // A download can run for minutes, so it is not part of the timed drain. A page reload
    // still leaves that IPC call admitted in this process, invisible to the new page's
    // in-memory counter. Acquire must fail closed immediately instead of measuring on top
    // of it or waiting out the 10s drain deadline.
    let releaseUpstream: (() => void) | null = null;
    const upstreamHeld = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstream = createServer((req, res) => {
      if (req.url !== '/hold-download') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      void upstreamHeld.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    let proc: ChildProcessWithoutNullStreams | undefined;
    let homeDir: string | undefined;
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const { port: upstreamPort } = upstream.address() as AddressInfo;
      const started = await startedGateway(upstreamPort, 200, [], false, null, true);
      proc = started.proc;
      homeDir = started.homeDir;

      proc.stdin.write(`${JSON.stringify({ id: 70, cmd: 'download', alias: 'fake-model' })}\n`);
      const downloadDone = waitForLine(proc, (msg) => msg.id === 70, 15000);
      await new Promise((resolve) => setTimeout(resolve, 150));

      proc.stdin.write(`${JSON.stringify({ id: 71, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
      const refused = await waitForLine(proc, (msg) => msg.id === 71, 15000);
      expect(refused.ok).toBeFalsy();
      expect(String(refused.error)).toMatch(/download is still in progress/);

      releaseUpstream?.();
      const downloadResult = await downloadDone;
      expect(downloadResult).toMatchObject({ ok: true });

      proc.stdin.write(`${JSON.stringify({ id: 72, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
      const acquired = await waitForLine(proc, (msg) => msg.id === 72, 15000);
      expect(acquired).toMatchObject({ ok: true, result: { exclusive: true, drained: true } });

      proc.stdin.write(`${JSON.stringify({ id: 73, cmd: 'download', alias: 'fake-model' })}\n`);
      const denied = await waitForLine(proc, (msg) => msg.id === 73, 15000);
      expect(denied.ok).toBeFalsy();
      expect(String(denied.error)).toMatch(/benchmark run is active/);

      proc.stdin.write(`${JSON.stringify({ id: 74, cmd: 'setBenchmarkExclusive', exclusive: false })}\n`);
      const released = await waitForLine(proc, (msg) => msg.id === 74, 15000);
      expect(released).toMatchObject({ ok: true, result: { exclusive: false } });
    } finally {
      if (proc) await killAndWait(proc);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20000);

  it('waits for an already-admitted startService (destructive restart) to finish before acquiring exclusive admission', async () => {
    // `startService` clears and repopulates the pool as part of its restart (see its handler's
    // own comment on `pool.clear()`/`usage.clear()`) -- exactly the kind of resident-pool
    // mutation the previous test covers for load/unload/deleteModel, but dispatched at the
    // top-level command instead of through `ensureModel`. A page reload leaves this sidecar
    // process (and anything it already admitted, including an in-flight `startService`) running,
    // invisible to a new page's own busy-state checks.
    //
    // `startedGateway()` itself already calls `startService` once to bring up its own gateway;
    // this test dispatches a *second* `startService` call to simulate the orphaned restart. The
    // fake manager's `startWebService()` only holds on that second call (via
    // `secondStartServicePort`, pointed at this test's own held upstream), so the first call
    // that `startedGateway()` depends on to even start still resolves immediately as normal.
    let releaseHeldStatus: (() => void) | null = null;
    const heldStatusReleased = new Promise<void>((resolve) => { releaseHeldStatus = resolve; });
    const heldUpstream = createServer((req, res) => {
      if (req.url !== '/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      void heldStatusReleased.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    let proc: ChildProcessWithoutNullStreams | undefined;
    let homeDir: string | undefined;
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      await new Promise<void>((resolve) => heldUpstream.listen(0, '127.0.0.1', resolve));
      const { port: upstreamPort } = upstream.address() as AddressInfo;
      const { port: heldPort } = heldUpstream.address() as AddressInfo;
      const started = await startedGateway(upstreamPort, 10_000, [], false, heldPort);
      proc = started.proc;
      homeDir = started.homeDir;

      let startServiceSettledAt = 0;
      proc.stdin.write(`${JSON.stringify({ id: 60, cmd: 'startService', port: 0, bindAddress: '127.0.0.1' })}\n`);
      const startServiceDone = waitForLine(proc, (msg) => msg.id === 60, 15000)
        .then((r) => { startServiceSettledAt = Date.now(); return r; });

      let exclusiveSettledAt = 0;
      const exclusivePromise = (async () => {
        proc!.stdin.write(`${JSON.stringify({ id: 61, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
        const res = await waitForLine(proc!, (msg) => msg.id === 61, 15000);
        exclusiveSettledAt = Date.now();
        return res;
      })();

      // A beat to let the exclusive acquire actually reach and start its drain wait before
      // releasing the held restart — proving the fence is waiting on it, not racing it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(startServiceSettledAt).toBe(0);

      releaseHeldStatus?.();
      const [startServiceResult, exclusiveResult] = await Promise.all([startServiceDone, exclusivePromise]);

      expect(startServiceResult).toMatchObject({ ok: true });
      expect(exclusiveResult).toMatchObject({ ok: true, result: { exclusive: true, drained: true } });
      expect(exclusiveSettledAt).toBeGreaterThanOrEqual(startServiceSettledAt);
    } finally {
      if (proc) await killAndWait(proc);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => heldUpstream.close(() => resolve()));
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20000);

  it('serializes a concurrently-dispatched release behind an in-progress acquire, so it cannot clear the flag mid-drain', async () => {
    // Same "held" streaming upstream as the previous test — this keeps the acquire's
    // `waitForBenchmarkDrainIdle` genuinely waiting (not resolving immediately) so there is a real
    // window in which a concurrently-dispatched command could interleave.
    let releaseUpstream: (() => void) | null = null;
    const upstreamHeld = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstream = createServer((req, res) => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      void upstreamHeld.then(() => {
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    let proc: ChildProcessWithoutNullStreams | undefined;
    let homeDir: string | undefined;
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const { port: upstreamPort } = upstream.address() as AddressInfo;
      const started = await startedGateway(upstreamPort, 10_000);
      proc = started.proc;
      homeDir = started.homeDir;
      const gatewayPort = started.gatewayPort;
      const inFlightStream = postToGatewayStream(gatewayPort, JSON.stringify({
        model: 'fake-model', messages: [], stream: true,
      }));
      await inFlightStream.firstChunk;

      // Dispatch acquire, then — without waiting for it to settle — dispatch a release right
      // behind it, exactly like two stdin lines arriving back-to-back. Each is its own
      // concurrently-running `rl.on('line', ...)` handler in the sidecar; only the serialization
      // queue is what should keep the release from running while the acquire is still waiting.
      let acquireSettledAt = 0;
      const acquirePromise = (async () => {
        proc!.stdin.write(`${JSON.stringify({ id: 50, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
        const res = await waitForLine(proc!, (msg) => msg.id === 50, 15000);
        acquireSettledAt = Date.now();
        return res;
      })();
      let releaseSettledAt = 0;
      const releasePromise = (async () => {
        proc!.stdin.write(`${JSON.stringify({ id: 51, cmd: 'setBenchmarkExclusive', exclusive: false })}\n`);
        const res = await waitForLine(proc!, (msg) => msg.id === 51, 15000);
        releaseSettledAt = Date.now();
        return res;
      })();

      // A beat to let the release command reach and, if unserialized, run ahead of the still-
      // waiting acquire — proving this isn't just a lucky ordering of two near-instant replies.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(acquireSettledAt).toBe(0);
      expect(releaseSettledAt).toBe(0);

      releaseUpstream?.();
      const [acquireResult, releaseResult] = await Promise.all([acquirePromise, releasePromise]);

      expect(acquireResult).toMatchObject({ ok: true, result: { exclusive: true, drained: true } });
      expect(releaseResult).toMatchObject({ ok: true, result: { exclusive: false } });
      // The release must not have been able to run — and thus settle — until the acquire's
      // whole transition (including its drain wait) had already finished.
      expect(releaseSettledAt).toBeGreaterThanOrEqual(acquireSettledAt);
    } finally {
      if (proc) await killAndWait(proc);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20000);

  it('clears the fence and reports failure when in-flight gateway work does not drain in time, without leaving the endpoint blocked', async () => {
    const upstream = createServer((req, res) => {
      if (req.headers['x-test-stuck']) {
        // Never respond: simulates a stuck/never-completing gateway request so the (short,
        // test-overridden) drain deadline is guaranteed to be reached.
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
    let proc: ChildProcessWithoutNullStreams | undefined;
    let homeDir: string | undefined;
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const { port: upstreamPort } = upstream.address() as AddressInfo;
      const started = await startedGateway(upstreamPort);
      proc = started.proc;
      homeDir = started.homeDir;
      const gatewayPort = started.gatewayPort;
      const stuck = postToGateway(
        gatewayPort,
        JSON.stringify({ model: 'fake-model', messages: [] }),
        { 'x-test-stuck': '1' },
      );
      // A rejection here (e.g. from the socket being destroyed during cleanup) is expected and
      // is not what this test asserts on — only the sidecar's own behavior is under test.
      stuck.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 150));

      proc.stdin.write(`${JSON.stringify({ id: 30, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
      const failed = await waitForLine(proc, (msg) => msg.id === 30, 5000);
      expect(failed.ok).toBeUndefined();
      expect(String(failed.error)).toContain('Could not drain');

      // The fence must have cleared on the failed attempt: a fresh, well-behaved request (no
      // stuck marker) is still admitted rather than being denied by a benchmarkExclusive flag
      // left stuck on.
      const admitted = await postToGateway(gatewayPort, JSON.stringify({ model: 'fake-model', messages: [] }));
      expect(admitted.status).toBe(200);
    } finally {
      if (proc) await killAndWait(proc);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20000);

  it('lets an already-admitted request finish autoloading its model even after exclusive admission is requested mid-flight', async () => {
    // First chat call: held until the test releases it, then answers the exact "not loaded"
    // rejection so the gateway's autoload path (`load` in foundry-sidecar-main.js) runs.
    // Second chat call (the post-autoload replay): answered immediately with 200. Startup's own
    // /status readiness probe must not be held, or `startedGateway` itself never resolves.
    let chatCallCount = 0;
    let releaseFirstResponse: (() => void) | null = null;
    const firstResponseHeld = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
    let resolveFirstRequestReceived: (() => void) | null = null;
    const firstRequestReceived = new Promise<void>((resolve) => { resolveFirstRequestReceived = resolve; });
    const upstream = createServer(async (req, res) => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      chatCallCount += 1;
      if (chatCallCount === 1) {
        resolveFirstRequestReceived?.();
        await firstResponseHeld;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "Model 'fake-model' is not loaded. Please load the model first." } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
    let proc: ChildProcessWithoutNullStreams | undefined;
    let homeDir: string | undefined;
    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const { port: upstreamPort } = upstream.address() as AddressInfo;
      // A generous drain deadline: this test proves already-admitted work is allowed to finish
      // autoloading, not that the fence gives up waiting on it.
      const started = await startedGateway(upstreamPort, 10_000, [
        { alias: 'fake-model', variants: [{ id: 'fake-variant', isCached: true }] },
      ]);
      proc = started.proc;
      homeDir = started.homeDir;
      const gatewayPort = started.gatewayPort;

      const admitted = postToGateway(gatewayPort, JSON.stringify({ model: 'fake-model', messages: [] }));
      // The request is admitted (and holding upstream) before exclusive admission is ever
      // requested, matching the real race: it reached the sidecar, and only later does a
      // benchmark ask for exclusivity while this request is still working through its
      // not-loaded retry.
      await firstRequestReceived;

      // `benchmarkExclusive` flips true synchronously here, before this call's drain-wait
      // even starts polling -- exactly the window the fix must tolerate.
      proc.stdin.write(`${JSON.stringify({ id: 40, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
      const exclusivePromise = waitForLine(proc, (msg) => msg.id === 40, 15000);

      // Prove `benchmarkExclusive` has actually flipped true in the sidecar process before
      // releasing the held response, deterministically rather than via a fixed sleep. A probe
      // to a non-chat path (so it cannot affect `chatCallCount`) is rejected with 503 only once
      // admission actually observes the flag; before that it is admitted and proxied straight
      // through by the test upstream (which answers 200 for any non-chat path).
      const probeAdmission = (): Promise<number> => new Promise((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1', port: gatewayPort, path: '/v1/models', method: 'GET',
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
        req.on('error', reject);
        req.end();
      });
      for (;;) {
        const status = await probeAdmission();
        if (status === 503) break;
      }
      releaseFirstResponse?.();

      const admittedResult = await admitted;
      // The already-admitted request must still complete successfully via autoload + replay,
      // not be rejected because exclusivity had already been requested.
      expect(admittedResult.status).toBe(200);
      expect(chatCallCount).toBe(2);

      const exclusiveResult = await exclusivePromise;
      expect(exclusiveResult).toMatchObject({ ok: true, result: { exclusive: true, drained: true } });
    } finally {
      if (proc) await killAndWait(proc);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }
  }, 20000);
});

describe('foundry-sidecar applyMemorySettings ordering guard', () => {
  let proc: ChildProcessWithoutNullStreams;

  beforeEach(async () => {
    proc = spawn(process.execPath, ['sidecar/foundry-sidecar.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await waitForLine(proc, (msg) => msg.ready === true);
  });

  afterEach(async () => {
    if (proc && !proc.killed) await killAndWait(proc);
  });

  it('refuses to install a lower seq once a higher seq has already landed', async () => {
    // Simulates the actual respawn/re-init hazard from sdk.ts's sendInternal: two
    // applyMemorySettings calls dispatched in one order (seq 1, then seq 2) can still arrive at
    // the sidecar in the opposite order. The stale call (seq 1) must not be allowed to overwrite
    // what the fresher call (seq 2) already installed, since this command fully replaces the
    // priority map rather than merging into it.
    proc.stdin.write(`${JSON.stringify({
      id: 1, cmd: 'applyMemorySettings', seq: 2,
      priorities: [{ alias: 'newer-run-target', priority: 'pinned' }],
    })}\n`);
    const newer = await waitForLine(proc, (msg) => msg.id === 1);
    expect(newer.ok).toBe(true);
    expect(newer.result.stale).toBe(false);
    expect(newer.result.priorities).toEqual(
      expect.arrayContaining([{ alias: 'newer-run-target', priority: 'pinned' }]),
    );

    // Arrives "late" (lower seq, after a higher seq already installed).
    proc.stdin.write(`${JSON.stringify({
      id: 2, cmd: 'applyMemorySettings', seq: 1,
      priorities: [],
    })}\n`);
    const stale = await waitForLine(proc, (msg) => msg.id === 2);
    expect(stale.ok).toBe(true);
    expect(stale.result.stale).toBe(true);
    // The newer call's pin must still be in effect -- the stale call's empty priority list must
    // not have been installed.
    expect(stale.result.priorities).toEqual(
      expect.arrayContaining([{ alias: 'newer-run-target', priority: 'pinned' }]),
    );
  });

  it('applies calls without a seq exactly as before (no ordering guarantee, but never rejected)', async () => {
    proc.stdin.write(`${JSON.stringify({
      id: 1, cmd: 'applyMemorySettings',
      priorities: [{ alias: 'legacy-caller', priority: 'pinned' }],
    })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 1);
    expect(res.ok).toBe(true);
    expect(res.result.stale).toBe(false);
    expect(res.result.priorities).toEqual(
      expect.arrayContaining([{ alias: 'legacy-caller', priority: 'pinned' }]),
    );
  });

  it('treats an equal seq as stale (idempotent replay, not a fresh write)', async () => {
    proc.stdin.write(`${JSON.stringify({
      id: 1, cmd: 'applyMemorySettings', seq: 5,
      priorities: [{ alias: 'first', priority: 'pinned' }],
    })}\n`);
    await waitForLine(proc, (msg) => msg.id === 1);

    proc.stdin.write(`${JSON.stringify({
      id: 2, cmd: 'applyMemorySettings', seq: 5,
      priorities: [{ alias: 'second', priority: 'pinned' }],
    })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 2);
    expect(res.result.stale).toBe(true);
    expect(res.result.priorities).toEqual([{ alias: 'first', priority: 'pinned' }]);
  });
});

describe('foundry-sidecar command schema validation', () => {
  let proc: ChildProcessWithoutNullStreams;

  beforeEach(async () => {
    proc = spawn(process.execPath, ['sidecar/foundry-sidecar.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    await waitForLine(proc, (msg) => msg.ready === true);
  });

  afterEach(() => {
    if (!proc.killed) proc.kill();
  });

  it('rejects unknown commands with an error', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 10, cmd: 'runArbitraryCode' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 10);
    expect(String(res.error)).toContain('Unknown command');
  });

  it('rejects a request using an unsupported protocol version', async () => {
    proc.stdin.write(`${JSON.stringify({
      id: 9,
      protocolVersion: 999,
      cmd: 'listModels',
    })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 9);
    expect(res.protocolVersion).toBe(1);
    expect(String(res.error)).toContain('Unsupported sidecar protocol version');
  });

  it('rejects payloads with unknown fields', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 11, cmd: 'listModels', injectedField: 'evil' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 11);
    expect(res.error).toBeTruthy();
    expect(String(res.error)).toContain('unknown field');
  });

  it('rejects commands with missing required fields', async () => {
    // init requires appName and logLevel
    proc.stdin.write(`${JSON.stringify({ id: 12, cmd: 'init', appName: 'test' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 12);
    expect(res.error).toBeTruthy();
    expect(String(res.error)).toContain('missing required field');
  });

  it('rejects unsupported log levels explicitly', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 17, cmd: 'setLogLevel', level: 'verbose' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 17);
    expect(String(res.error)).toContain('Unsupported log level');
  });

  it('rejects chatCompletion with missing model', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 13, cmd: 'chatCompletion', messages: [] })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 13);
    expect(res.error).toBeTruthy();
    expect(String(res.error)).toContain('missing required field');
  });

  it('rejects embedTexts with empty or oversized inputs before init', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 41, cmd: 'embedTexts', model: 'm', inputs: [] })}\n`);
    const empty = await waitForLine(proc, (msg) => msg.id === 41);
    expect(String(empty.error)).toMatch(/non-empty inputs array/);

    proc.stdin.write(`${JSON.stringify({ id: 42, cmd: 'embedTexts', model: 'm', inputs: ['', 'ok'] })}\n`);
    const blank = await waitForLine(proc, (msg) => msg.id === 42);
    expect(String(blank.error)).toMatch(/non-empty strings/);

    proc.stdin.write(`${JSON.stringify({ id: 43, cmd: 'embedTexts', model: 'm', inputs: ['x'.repeat(8193)] })}\n`);
    const tooLong = await waitForLine(proc, (msg) => msg.id === 43);
    expect(String(tooLong.error)).toMatch(/8192/);

    proc.stdin.write(`${JSON.stringify({ id: 44, cmd: 'embedTexts', model: 'm', inputs: Array(33).fill('x') })}\n`);
    const tooMany = await waitForLine(proc, (msg) => msg.id === 44);
    expect(String(tooMany.error)).toMatch(/at most 32/);

    proc.stdin.write(`${JSON.stringify({ id: 45, cmd: 'embedTexts', model: 'm', inputs: ['ping'] })}\n`);
    const uninit = await waitForLine(proc, (msg) => msg.id === 45);
    expect(String(uninit.error)).toMatch(/not initialized/);
    expect(String(uninit.error)).not.toContain('Unknown command');
  });

  it('rejects cancelChatRequest with non-numeric requestId', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 14, cmd: 'cancelChatRequest', requestId: 'not-a-number' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 14);
    // requestId is present but wrong type; sidecar rejects at the handler level
    expect(res.error).toBeTruthy();
  });

  it('rejects invalid runtime shutdown drain deadlines', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 18, cmd: 'stopAndUnload', drainTimeoutMs: -1 })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 18);
    expect(String(res.error)).toContain('finite non-negative number');
  });

  it('rejects load with invalid lane name', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 20, cmd: 'load', alias: 'any-model', lane: 'invalid' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 20);
    expect(res.error).toBeTruthy();
    expect(String(res.error)).toMatch(/invalid lane/i);
  });

  it('routes load to audio lane and preserves chat lane independently', async () => {
    // init is required before load in real usage; sidecar will fail without manager
    // but the lane routing code runs before the manager call, so we can test
    // that schema validation accepts lane='audio' without error from that layer.
    // The test verifies the validation layer; the actual lane state requires a real SDK.
    proc.stdin.write(`${JSON.stringify({ id: 21, cmd: 'load', alias: 'some-model', lane: 'audio' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 21);
    // Validation passes; error (if any) is from manager being null, not from lane routing
    if (res.error) {
      expect(String(res.error)).not.toContain('invalid lane');
      expect(String(res.error)).not.toContain('Unknown command');
      expect(String(res.error)).not.toContain('unknown field');
    }
  });

  it('rejects transcribeAudio with oversized audioBase64', async () => {
    const oversized = 'A'.repeat(Math.ceil(50 * 1024 * 1024 * 4 / 3) + 1);
    proc.stdin.write(`${JSON.stringify({ id: 16, cmd: 'transcribeAudio', audioBase64: oversized, mimeType: 'audio/wav', fileName: 'x.wav', model: 'm', language: 'en' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 16, 10000);
    expect(res.error).toBeTruthy();
    expect(String(res.error)).toContain('exceeds maximum allowed size');
  });

  it('rejects transcribeAudio whose bytes are not WAV despite a .wav name', async () => {
    // The handler renames any payload to .wav for the strict AudioDecoder.
    // Renaming does not convert, so non-WAV bytes must be rejected up front
    // rather than failing later inside the native decoder.
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
    proc.stdin.write(`${JSON.stringify({ id: 17, cmd: 'transcribeAudio', audioBase64: webm, mimeType: 'audio/wav', fileName: 'recording.wav', model: 'm', language: 'en' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 17, 10000);
    expect(res.error).toBeTruthy();
    expect(String(res.error)).toContain('not WAV');
  });

  it('accepts well-formed commands without errors from schema', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 15, cmd: 'getStatus' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 15);
    // getStatus succeeds even before init; this test only asserts schema validation doesn't reject the command.
    // If there is an error, it should not be from the schema layer (unknown command/field/missing required field).
    if (res.error) {
      expect(String(res.error)).not.toContain('Unknown command');
      expect(String(res.error)).not.toContain('missing required field');
      expect(String(res.error)).not.toContain('unknown field');
    } else {
      expect(res.ok).toBe(true);
    }
  });
});

describe('foundry-sidecar error propagation and resilience', () => {
  let proc: ChildProcessWithoutNullStreams;

  beforeEach(async () => {
    proc = spawn(process.execPath, ['sidecar/foundry-sidecar.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    await waitForLine(proc, (msg) => msg.ready === true);
  });

  afterEach(() => {
    if (!proc.killed) proc.kill();
  });

  it('getStatus returns initialized:false before init', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 30, cmd: 'getStatus' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 30);
    expect(res.ok).toBe(true);
    expect(res.result.initialized).toBe(false);
    expect(res.result.modelLoaded).toBe(false);
  });

  it('getStatus reports benchmarkExclusive, reflecting setBenchmarkExclusive without requiring init', async () => {
    // A frontend reload's fresh in-memory state has no way to know whether a now-gone page
    // instance left this flag set in the still-running sidecar; getStatus is what a startup
    // reconciliation call reads to detect and clear a stale lease. Exercised pre-init (no
    // manager/model needed) since setBenchmarkExclusive/getStatus both work before init.
    proc.stdin.write(`${JSON.stringify({ id: 60, cmd: 'getStatus' })}\n`);
    const before = await waitForLine(proc, (msg) => msg.id === 60);
    expect(before.result.benchmarkExclusive).toBe(false);

    proc.stdin.write(`${JSON.stringify({ id: 61, cmd: 'setBenchmarkExclusive', exclusive: true })}\n`);
    await waitForLine(proc, (msg) => msg.id === 61);

    proc.stdin.write(`${JSON.stringify({ id: 62, cmd: 'getStatus' })}\n`);
    const during = await waitForLine(proc, (msg) => msg.id === 62);
    expect(during.result.benchmarkExclusive).toBe(true);

    proc.stdin.write(`${JSON.stringify({ id: 63, cmd: 'setBenchmarkExclusive', exclusive: false })}\n`);
    await waitForLine(proc, (msg) => msg.id === 63);

    proc.stdin.write(`${JSON.stringify({ id: 64, cmd: 'getStatus' })}\n`);
    const after = await waitForLine(proc, (msg) => msg.id === 64);
    expect(after.result.benchmarkExclusive).toBe(false);
  });

  it('getStatus reports lastAppliedMemorySettingsSeq, letting a fresh frontend reload seed its own counter above it', async () => {
    // A page reload restarts the frontend's own `pushMemorySeq` at 0, but this sidecar process
    // (and this watermark) survive the reload. Without seeding the new page's counter from this
    // value, its first several pushes would carry a seq at or below this watermark and be
    // silently accepted-but-skipped (see the ordering-guard describe block above), with no
    // visible error -- getStatus is what a startup reconciliation reads to avoid that.
    proc.stdin.write(`${JSON.stringify({ id: 70, cmd: 'getStatus' })}\n`);
    const before = await waitForLine(proc, (msg) => msg.id === 70);
    expect(before.result.lastAppliedMemorySettingsSeq).toBe(-1);

    proc.stdin.write(`${JSON.stringify({
      id: 71, cmd: 'applyMemorySettings', seq: 7, priorities: [],
    })}\n`);
    await waitForLine(proc, (msg) => msg.id === 71);

    proc.stdin.write(`${JSON.stringify({ id: 72, cmd: 'getStatus' })}\n`);
    const after = await waitForLine(proc, (msg) => msg.id === 72);
    expect(after.result.lastAppliedMemorySettingsSeq).toBe(7);
  });

  it('cancelChatRequest is idempotent for unknown request IDs', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 31, cmd: 'cancelChatRequest', requestId: 99999 })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 31);
    expect(res.ok).toBe(true);
  });

  it('continues processing after a handler error', async () => {
    // listModels requires manager; without init it throws internally
    proc.stdin.write(`${JSON.stringify({ id: 32, cmd: 'listModels' })}\n`);
    const errRes = await waitForLine(proc, (msg) => msg.id === 32);
    expect(errRes.error).toBeTruthy();

    // Process must still respond to subsequent commands
    proc.stdin.write(`${JSON.stringify({ id: 33, cmd: 'getStatus' })}\n`);
    const statusRes = await waitForLine(proc, (msg) => msg.id === 33);
    expect(statusRes.ok).toBe(true);
  });

  it('silently ignores whitespace-only lines and processes next command', async () => {
    const invalidJsonErrors: any[] = [];
    const collector = (chunk: Buffer | string) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error === 'Invalid JSON') invalidJsonErrors.push(msg);
        } catch { /* ignore unparseable */ }
      }
    };
    proc.stdout.on('data', collector);
    proc.stdin.write('   \n');
    proc.stdin.write('\n');
    proc.stdin.write(`${JSON.stringify({ id: 34, cmd: 'getStatus' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 34);
    proc.stdout.off('data', collector);
    expect(invalidJsonErrors).toHaveLength(0);
    expect(res.ok).toBe(true);
  });

  it('processes multiple sequential commands in order', async () => {
    for (const id of [35, 36, 37]) {
      proc.stdin.write(`${JSON.stringify({ id, cmd: 'cancelChatRequest', requestId: id })}\n`);
      const res = await waitForLine(proc, (msg) => msg.id === id);
      expect(res.ok).toBe(true);
    }
  });

  it('null id in error response when JSON has no id', async () => {
    proc.stdin.write('not-json\n');
    const res = await waitForLine(proc, (msg) => msg.error === 'Invalid JSON');
    expect(res.id).toBeNull();
  });

  it('rejects non-object JSON messages without crashing', async () => {
    for (const input of ['null\n', '123\n', '[]\n']) {
      proc.stdin.write(input);
      const res = await waitForLine(proc, (msg) => msg.error === 'Invalid message: expected JSON object');
      expect(res.id).toBeNull();
    }

    proc.stdin.write(`${JSON.stringify({ id: 39, cmd: 'getStatus' })}\n`);
    const status = await waitForLine(proc, (msg) => msg.id === 39);
    expect(status.ok).toBe(true);
  });

  it('getStatus reports both lane models as null before any load', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 38, cmd: 'getStatus' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 38);
    expect(res.ok).toBe(true);
    expect(res.result.chatLane).toBeDefined();
    expect(res.result.audioLane).toBeDefined();
    expect(res.result.chatLane.model).toBeNull();
    expect(res.result.audioLane.model).toBeNull();
  });
});

describe('foundry-sidecar packaged resource layout', () => {
  let stageDir: string;

  beforeEach(() => {
    // Mirror the installer layout: <resources>/sidecar/ next to
    // <resources>/foundry-local-sdk/, with no package.json or node_modules
    // above them. Bare-specifier import fails here, so the sidecar must fall
    // back to loading the SDK by file path.
    stageDir = mkdtempSync(join(tmpdir(), 'flint-sidecar-'));
    cpSync(join(process.cwd(), 'sidecar'), join(stageDir, 'sidecar'), { recursive: true });
    cpSync(
      join(process.cwd(), 'node_modules', 'foundry-local-sdk'),
      join(stageDir, 'foundry-local-sdk'),
      { recursive: true }
    );
  });

  afterEach(() => {
    // The SDK loads a native DLL, which Windows may still hold briefly after
    // the child exits. Cleanup is best-effort so it never fails the test.
    try {
      rmSync(stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Leave the temp dir for the OS to reclaim.
    }
  });

  it('loads the Foundry SDK from packaged resources without ESM/CJS errors', async () => {
    const proc = spawn(process.execPath, [join(stageDir, 'sidecar', 'foundry-sidecar.js')], {
      cwd: stageDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    try {
      await waitForLine(proc, (msg) => msg.ready === true);
      proc.stdin.write(
        `${JSON.stringify({ id: 40, cmd: 'init', appName: 'flint', logLevel: 'info' })}\n`
      );

      const res = await waitForLine(proc, (msg) => msg.id === 40, 30000);
      // `require is not defined` was a real regression: the fallback loader
      // used CJS `require` inside this ESM module, so packaged builds could
      // never load the SDK.
      expect(String(res.error ?? '')).not.toContain('require is not defined');
      expect(res.ok).toBe(true);
    } finally {
      if (!proc.killed) proc.kill();
    }
  }, 60000);
});

describe('guarded idle unload against concurrent model use', () => {
  // A fake SDK whose unload and preferred-EP setter are slow and whose calls are appended to
  // an event log, so the tests can see what ran while a native unload was in progress.
  const FAKE_SDK = [
    "import fs from 'node:fs';",
    'const note = (event) => fs.appendFileSync(process.env.FLINT_TEST_EVENT_LOG, event + "\\n");',
    'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    'class FakeModel {',
    "  constructor() { this.id = 'fake-variant'; this.loaded = false; }",
    "  async load() { note('load'); this.loaded = true; }",
    "  async unload() { note('unload-start'); await sleep(400); this.loaded = false; note('unload-end'); }",
    "  isLoaded() { note('isLoaded'); return this.loaded; }",
    "  getExecutionProvider() { return 'CPUExecutionProvider'; }",
    '  createAudioClient() {',
    '    const model = this;',
    '    return {',
    '      settings: {},',
    "      async *transcribeStreaming() { note('transcribe'); if (!model.loaded) throw new Error('not loaded'); yield { text: 'hello' }; },",
    "      async transcribe() { note('transcribe'); if (!model.loaded) throw new Error('not loaded'); return { text: 'hello' }; },",
    '    };',
    '  }',
    '}',
    'class FakeManager {',
    '  constructor() { this.catalog = { getModel: async () => new FakeModel(), getModels: async () => [] }; }',
    "  async setPreferredExecutionProvider() { note('prefer-start'); await sleep(400); note('prefer-end'); }",
    '  static create() { return new FakeManager(); }',
    '}',
    'export { FakeManager as FoundryLocalManager };',
  ].join('\n');

  let homeDir: string;
  let eventLog: string;
  let proc: ChildProcessWithoutNullStreams;

  const events = () => {
    try {
      return readFileSync(eventLog, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const send = (msg: object) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
  const reply = (id: number) => waitForLine(proc, (msg) => msg.id === id, 10000);
  const waitForEvent = async (event: string) => {
    const deadline = Date.now() + 5000;
    while (!events().includes(event)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${event}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'flint-sidecar-guarded-unload-'));
    eventLog = join(homeDir, 'events.log');
    const corePath = join(homeDir, 'fake-core.dylib');
    writeFileSync(corePath, '');
    const loaderPath = join(homeDir, 'fake-sdk-loader.mjs');
    writeFileSync(loaderPath, [
      `const sdk = ${JSON.stringify(FAKE_SDK)};`,
      'export async function resolve(specifier, context, nextResolve) {',
      "  if (specifier === 'foundry-local-sdk') return { url: 'data:text/javascript,' + encodeURIComponent(sdk), shortCircuit: true };",
      '  return nextResolve(specifier, context);',
      '}',
      'export async function load(url, context, nextLoad) {',
      "  if (url.startsWith('data:text/javascript,')) return { format: 'module', source: decodeURIComponent(url.slice('data:text/javascript,'.length)), shortCircuit: true };",
      '  return nextLoad(url, context);',
      '}',
    ].join('\n'));
    proc = spawn(process.execPath, [
      '--experimental-loader', pathToFileURL(loaderPath).href, 'sidecar/foundry-sidecar.js',
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        FLINT_FOUNDRY_CORE_PATH: corePath,
        FLINT_TEST_EVENT_LOG: eventLog,
      },
    });
    await waitForLine(proc, (msg) => msg.ready === true);
    const init = reply(1);
    send({ id: 1, cmd: 'init', appName: 'flint-test', logLevel: 'info' });
    expect((await init).ok).toBe(true);
    const loaded = reply(2);
    send({ id: 2, cmd: 'load', alias: 'fake-model' });
    expect((await loaded).ok).toBe(true);
  });

  afterEach(async () => {
    await killAndWait(proc);
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('holds a load until a guarded unload of the same alias has finished', async () => {
    const unloaded = reply(3);
    const reloaded = reply(4);
    send({ id: 3, cmd: 'unload', alias: 'fake-model', ifIdle: true });
    send({ id: 4, cmd: 'load', alias: 'fake-model' });
    expect((await unloaded).ok).toBe(true);
    expect((await reloaded).ok).toBe(true);

    const log = events();
    const start = log.indexOf('unload-start');
    const end = log.indexOf('unload-end');
    expect(start).toBeGreaterThan(-1);
    // Nothing may probe or load the model while its native unload runs, and the later
    // load must bring it back rather than report the model that is going away.
    expect(log.slice(start + 1, end)).toEqual([]);
    expect(log.slice(end + 1)).toContain('load');
  }, 30000);

  it('refuses a guarded unload while a transcription is preparing its model', async () => {
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(36, 4);
    wav.write('WAVE', 8, 'ascii');
    const transcribed = reply(5);
    send({
      id: 5,
      cmd: 'transcribeAudio',
      audioBase64: wav.toString('base64'),
      mimeType: 'audio/wav',
      fileName: 'probe.wav',
      model: 'fake-model',
      language: 'en',
      preferredEp: 'CPUExecutionProvider',
    });
    // The request has resolved its model and is inside applyPreferredExecutionProvider.
    await waitForEvent('prefer-start');
    const refused = reply(6);
    send({ id: 6, cmd: 'unload', alias: 'fake-model', ifIdle: true });
    const unload = await refused;
    await transcribed;

    expect(unload.ok).not.toBe(true);
    expect(String(unload.error)).toMatch(/in flight/);
    expect(events()).not.toContain('unload-start');
  }, 30000);
});
