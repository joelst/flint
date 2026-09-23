import type { ChildProcess } from 'child_process';

export function killAndWait(proc: ChildProcess, graceMs = 1500): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (forceTimer) clearTimeout(forceTimer);
      if (finalTimer) clearTimeout(finalTimer);
      proc.off('exit', done);
      resolve();
    };
    proc.once('exit', done);
    proc.kill();
    forceTimer = setTimeout(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        done();
        return;
      }
      proc.kill('SIGKILL');
      finalTimer = setTimeout(done, graceMs);
    }, graceMs);
  });
}
