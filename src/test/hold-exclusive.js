import { spawn } from 'node:child_process';

/**
 * Open a file with no sharing, the way a loaded DLL blocks delete and rename.
 * Node opens files with delete sharing, so a child PowerShell holds the lock.
 * Windows only.
 * @param {string} file
 * @returns {Promise<() => Promise<void>>} Releases the lock.
 */
export function holdExclusive (file) {
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); `
    + "[Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine(); $f.Close()";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    // A pipe read does not keep write boundaries, so the marker can arrive in pieces.
    let output = '';
    let locked = false;
    child.stdout.on('data', (chunk) => {
      if (locked) return;
      output += String(chunk);
      if (!output.includes('locked')) return;
      locked = true;
      resolve(async () => {
        child.stdin.end('\n');
        await exited;
      });
    });
    exited.then((code) => reject(new Error(`lock holder exited early (${code})`)));
  });
}
