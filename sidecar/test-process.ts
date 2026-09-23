import type { ChildProcess } from 'child_process';

type KillableChild = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'pid' | 'kill' | 'once' | 'off'>;

/**
 * Stops a child and resolves only once its exit is observed. A child that outlives a forced
 * kill rejects instead, so a caller never removes files or closes servers the child may still
 * be using.
 */
export function killAndWait(proc: KillableChild, graceMs = 1500): Promise<void> {
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  if (exited()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error) => {
      if (forceTimer) clearTimeout(forceTimer);
      if (finalTimer) clearTimeout(finalTimer);
      proc.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => settle();
    proc.once('exit', onExit);
    proc.kill();
    forceTimer = setTimeout(() => {
      if (exited()) {
        settle();
        return;
      }
      proc.kill('SIGKILL');
      finalTimer = setTimeout(() => {
        if (exited()) settle();
        else settle(new Error(`Child process ${proc.pid ?? '(unknown pid)'} did not exit after SIGKILL.`));
      }, graceMs);
    }, graceMs);
  });
}
