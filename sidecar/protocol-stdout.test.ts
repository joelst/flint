// @vitest-environment node
import { Writable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { protectProtocolStdout } from './protocol-stdout.js';

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
  it('keeps protocol frames on stdout and redirects accidental stdout writes to stderr', () => {
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
    writeProtocolLine(JSON.stringify({ ready: true }));

    expect(stdout.output()).toBe('{"ready":true}\n');
    expect(stderr.output()).toBe('accidental stdout\ndependency log message\n');
  });
});
