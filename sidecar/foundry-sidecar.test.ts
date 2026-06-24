// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { describe, expect, it } from 'vitest';

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
