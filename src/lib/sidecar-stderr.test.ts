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
