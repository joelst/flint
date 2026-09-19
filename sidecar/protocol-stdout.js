import { format } from 'util';

export const DIAGNOSTIC_PREFIX = 'FLINT_DIAG';

function chunkToText(chunk, encoding) {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString(typeof encoding === 'string' ? encoding : 'utf8');
  }
  return String(chunk);
}

function prefixDiagnosticText(level, text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return '';
  return lines.map((line) => `${DIAGNOSTIC_PREFIX} ${level} ${line}\n`).join('');
}

let installedProtocolWrite = null;

export function writeProtocolLine(line, callback) {
  if (!installedProtocolWrite) {
    throw new Error('protectProtocolStdout() must run before writing protocol frames');
  }
  return installedProtocolWrite(`${line}\n`, callback);
}

export function protectProtocolStdout({
  stdout = process.stdout,
  stderr = process.stderr,
  consoleObject = console,
} = {}) {
  const protocolWrite = stdout.write.bind(stdout);
  const diagnosticWrite = stderr.write.bind(stderr);

  stdout.write = function redirectedStdoutWrite(chunk, encoding, callback) {
    const text = chunkToText(chunk, encoding);
    const prefixed = prefixDiagnosticText('info', text);
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (!prefixed) {
      if (typeof cb === 'function') cb();
      return true;
    }
    return diagnosticWrite(prefixed, cb);
  };

  const writeDiagnosticLine = (level, ...args) => {
    diagnosticWrite(prefixDiagnosticText(level, format(...args)));
  };

  consoleObject.log = (...args) => writeDiagnosticLine('info', ...args);
  consoleObject.info = (...args) => writeDiagnosticLine('info', ...args);
  consoleObject.debug = (...args) => writeDiagnosticLine('debug', ...args);

  if (stdout === process.stdout) {
    installedProtocolWrite = protocolWrite;
  }

  return function writeProtectedProtocolLine(line, callback) {
    return protocolWrite(`${line}\n`, callback);
  };
}
