import { format } from 'util';

function writeChunk(stream, chunk, encoding, callback) {
  if (typeof encoding === 'function') {
    return stream.write(chunk, encoding);
  }
  return stream.write(chunk, encoding, callback);
}

export function protectProtocolStdout({
  stdout = process.stdout,
  stderr = process.stderr,
  consoleObject = console,
} = {}) {
  const protocolWrite = stdout.write.bind(stdout);
  const diagnosticWrite = stderr.write.bind(stderr);

  stdout.write = function redirectedStdoutWrite(chunk, encoding, callback) {
    return writeChunk({ write: diagnosticWrite }, chunk, encoding, callback);
  };

  const writeDiagnosticLine = (...args) => {
    diagnosticWrite(`${format(...args)}\n`);
  };

  consoleObject.log = writeDiagnosticLine;
  consoleObject.info = writeDiagnosticLine;
  consoleObject.debug = writeDiagnosticLine;

  return function writeProtocolLine(line, callback) {
    return protocolWrite(`${line}\n`, callback);
  };
}
