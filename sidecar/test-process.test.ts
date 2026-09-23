// @vitest-environment node
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { killAndWait } from './test-process.js';

/** A child that never reports an exit, whatever it is sent. */
function unkillableChild() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    pid: 4242,
    signals: [] as Array<string | undefined>,
    kill(signal?: string) {
      child.signals.push(signal);
      return true;
    },
  });
  return child;
}

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

  it('rejects rather than resolving when the child never confirms its exit', async () => {
    const child = unkillableChild();
    await expect(killAndWait(child as never, 10)).rejects.toThrow('4242 did not exit after SIGKILL');
    expect(child.signals).toEqual([undefined, 'SIGKILL']);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('resolves when the exit arrives during the forced-kill grace period', async () => {
    const child = unkillableChild();
    const stopped = killAndWait(child as never, 10);
    setTimeout(() => child.emit('exit', null, 'SIGKILL'), 15);
    await expect(stopped).resolves.toBeUndefined();
    expect(child.listenerCount('exit')).toBe(0);
  });
});
