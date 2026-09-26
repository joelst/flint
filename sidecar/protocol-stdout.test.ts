// @vitest-environment node
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Writable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { DIAGNOSTIC_PREFIX, protectProtocolStdout, writeProtocolLine } from './protocol-stdout.js';
import { killAndWait } from './test-process.js';

function captureStream() {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as Writable & { output: () => string };
  stream.output = () => output;
  return stream;
}

describe('protocol stdout protection', () => {
  it('refuses protocol writes until the guard is installed on process.stdout', () => {
    expect(() => writeProtocolLine('{"ready":true}')).toThrow(/protectProtocolStdout/);
  });

  it('keeps protocol frames on stdout and tags redirected diagnostics on stderr', () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const consoleObject = {
      log: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const writeProtocolLine = protectProtocolStdout({ stdout, stderr, consoleObject });

    stdout.write('accidental stdout\n');
    consoleObject.log('dependency log %s', 'message');
    consoleObject.debug('trace %s', 'detail');
    writeProtocolLine(JSON.stringify({ ready: true }));

    expect(stdout.output()).toBe('{"ready":true}\n');
    expect(stderr.output()).toBe(
      `${DIAGNOSTIC_PREFIX} info accidental stdout\n` +
        `${DIAGNOSTIC_PREFIX} info dependency log message\n` +
        `${DIAGNOSTIC_PREFIX} debug trace detail\n`,
    );
  });

  it('decodes Uint8Array stdout chunks as text, not comma-separated bytes', () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const consoleObject = { log: vi.fn(), info: vi.fn(), debug: vi.fn() };
    protectProtocolStdout({ stdout, stderr, consoleObject });
    stdout.write(new Uint8Array(Buffer.from('uint8 noise\n')));
    expect(stderr.output()).toBe(`${DIAGNOSTIC_PREFIX} info uint8 noise\n`);
  });

  it('does not emit a tagged diagnostic for blank lines in console output', () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const consoleObject = {
      log: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    protectProtocolStdout({ stdout, stderr, consoleObject });
    consoleObject.log('before\n\nafter');
    expect(stderr.output()).toBe(
      `${DIAGNOSTIC_PREFIX} info before\n${DIAGNOSTIC_PREFIX} info after\n`,
    );
  });

  it('is the process entry and loads the command loop only after the guard', () => {
    const src = readFileSync(new URL('./foundry-sidecar.js', import.meta.url), 'utf8');
    expect(src).toContain('protectProtocolStdout()');
    expect(src).toContain("await import('./foundry-sidecar-main.js')");
    expect(src).not.toContain("from './gateway.js'");
    expect(src).not.toContain('KNOWN_COMMANDS');
  });

  it('redirects import-time stdout from modules loaded after the guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-stdout-boot-'));
    const protocolUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'protocol-stdout.js')).href;
    const noisyPath = join(dir, 'noisy.js');
    const bootPath = join(dir, 'boot.mjs');
    writeFileSync(noisyPath, 'process.stdout.write("import noise\\n");\n');
    writeFileSync(
      bootPath,
      `import { protectProtocolStdout, writeProtocolLine } from ${JSON.stringify(protocolUrl)};\n` +
        'protectProtocolStdout();\n' +
        `await import(${JSON.stringify(pathToFileURL(noisyPath).href)});\n` +
        'writeProtocolLine(JSON.stringify({ ready: true }));\n',
    );

    const proc = spawn(process.execPath, [bootPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', resolve);
      });
      expect(code).toBe(0);
      expect(stdout).toBe('{"ready":true}\n');
      expect(stderr).toBe(`${DIAGNOSTIC_PREFIX} info import noise\n`);
    } finally {
      await killAndWait(proc);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
