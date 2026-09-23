// @vitest-environment node
import { spawn } from 'child_process';
import { describe, expect, it } from 'vitest';
import { killAndWait } from './test-process.js';

describe('killAndWait', () => {
  it('waits until the child has exited', async () => {
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise<void>((resolve) => proc.once('spawn', resolve));
    await killAndWait(proc);
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('force-kills a child that ignores SIGTERM', async () => {
    const proc = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ]);
    await new Promise<void>((resolve) => proc.once('spawn', resolve));
    await killAndWait(proc, 50);
    expect(proc.signalCode).toBe('SIGKILL');
  });
});
