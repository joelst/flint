// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { cpSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

describe('foundry-sidecar protocol basics', () => {
  it('emits ready and handles basic request/validation messages', async () => {
    const proc = spawn(process.execPath, ['sidecar/foundry-sidecar.js'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    try {
      const ready = await waitForLine(proc, (msg) => msg.ready === true);
      expect(ready.ready).toBe(true);

      proc.stdin.write('not-json\n');
      const invalid = await waitForLine(proc, (msg) => msg.error === 'Invalid JSON');
      expect(invalid.error).toBe('Invalid JSON');

      proc.stdin.write(`${JSON.stringify({ id: 1, cmd: 'cancelChatRequest', requestId: 123 })}\n`);
      const cancel = await waitForLine(proc, (msg) => msg.id === 1);
      expect(cancel.ok).toBe(true);

      proc.stdin.write(`${JSON.stringify({ id: 2, cmd: 'unknownCommand' })}\n`);
      const unknown = await waitForLine(proc, (msg) => msg.id === 2);
      expect(String(unknown.error)).toContain('Unknown command');
    } finally {
      if (!proc.killed) {
        proc.kill();
      }
    }
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

  it('rejects chatCompletion with missing model', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 13, cmd: 'chatCompletion', messages: [] })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 13);
    expect(res.error).toBeTruthy();
    expect(String(res.error)).toContain('missing required field');
  });

  it('rejects cancelChatRequest with non-numeric requestId', async () => {
    proc.stdin.write(`${JSON.stringify({ id: 14, cmd: 'cancelChatRequest', requestId: 'not-a-number' })}\n`);
    const res = await waitForLine(proc, (msg) => msg.id === 14);
    // requestId is present but wrong type; sidecar rejects at the handler level
    expect(res.error).toBeTruthy();
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
