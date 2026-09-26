import { describe, expect, it } from 'vitest';
import { classifySidecarStderrLine } from './sidecar-stderr';

describe('classifySidecarStderrLine', () => {
  it('keeps unprefixed native stderr as an error', () => {
    expect(classifySidecarStderrLine('  onnxruntime boom  ')).toEqual({
      level: 'error',
      message: 'onnxruntime boom',
    });
  });

  it('reads a tagged diagnostic at the declared level', () => {
    expect(classifySidecarStderrLine('FLINT_DIAG info dependency log message')).toEqual({
      level: 'info',
      message: 'dependency log message',
    });
    expect(classifySidecarStderrLine('FLINT_DIAG debug trace details')).toEqual({
      level: 'debug',
      message: 'trace details',
    });
    expect(classifySidecarStderrLine('FLINT_DIAG warn almost full')).toEqual({
      level: 'warn',
      message: 'almost full',
    });
  });

  it('reads Foundry bracket levels instead of treating every stderr line as an error', () => {
    expect(classifySidecarStderrLine('[info] Runtime versions: onnxruntime=1.28.0')).toEqual({
      level: 'info',
      message: 'Runtime versions: onnxruntime=1.28.0',
    });
    expect(classifySidecarStderrLine('[info] [Telemetry] 1DS initialized')).toEqual({
      level: 'info',
      message: '[Telemetry] 1DS initialized',
    });
    expect(classifySidecarStderrLine('[warning] cache almost full')).toEqual({
      level: 'warn',
      message: 'cache almost full',
    });
    expect(classifySidecarStderrLine('[error] Failed to commit download state file: Access is denied.')).toEqual({
      level: 'error',
      message: 'Failed to commit download state file: Access is denied.',
    });
  });

  it('treats a malformed diagnostic tag as an error', () => {
    expect(classifySidecarStderrLine('FLINT_DIAG')).toEqual({
      level: 'error',
      message: 'FLINT_DIAG',
    });
    expect(classifySidecarStderrLine('FLINT_DIAG info')).toEqual({
      level: 'error',
      message: 'FLINT_DIAG info',
    });
    expect(classifySidecarStderrLine('FLINT_DIAG verbose too chatty')).toEqual({
      level: 'error',
      message: 'FLINT_DIAG verbose too chatty',
    });
  });
});
