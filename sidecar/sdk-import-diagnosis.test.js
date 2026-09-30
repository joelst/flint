import { describe, expect, it } from 'vitest';
import { isPackageAbsentError } from './sdk-import-diagnosis.js';

/** Shapes Node actually produces, so the classification is checked against real messages. */
function esmPackageMissing (specifier) {
  const err = new Error(
    `Cannot find package '${specifier}' imported from `
    + 'C:\\Users\\joels\\AppData\\Local\\Flint\\sidecar\\foundry-sidecar-main.js',
  );
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

describe('isPackageAbsentError', () => {
  it('recognizes the packaged layout, where bare resolution finds no such package', () => {
    expect(isPackageAbsentError(esmPackageMissing('foundry-local-sdk'), 'foundry-local-sdk')).toBe(true);
  });

  it('recognizes the CommonJS wording', () => {
    const err = new Error("Cannot find module 'foundry-local-sdk'");
    err.code = 'MODULE_NOT_FOUND';
    expect(isPackageAbsentError(err, 'foundry-local-sdk')).toBe(true);
  });

  // The reason the code alone is not enough: a resolvable SDK with a missing internal file
  // raises the same code. Treating that as expected would hide a broken install behind an
  // info line that every launch prints anyway.
  it('does not excuse a resolvable package whose own import is missing', () => {
    const err = new Error(
      "Cannot find module 'C:\\Flint\\sidecar\\foundry-local-sdk\\dist\\runtime.js' "
      + "imported from C:\\Flint\\sidecar\\foundry-local-sdk\\dist\\index.js",
    );
    err.code = 'ERR_MODULE_NOT_FOUND';
    expect(isPackageAbsentError(err, 'foundry-local-sdk')).toBe(false);
  });

  it('does not excuse a different package being absent', () => {
    expect(isPackageAbsentError(esmPackageMissing('onnxruntime-node'), 'foundry-local-sdk')).toBe(false);
  });

  // A prefix match would accept the WinML package as the plain one and vice versa.
  it('matches the specifier exactly, not by prefix', () => {
    expect(isPackageAbsentError(esmPackageMissing('foundry-local-sdk-winml'), 'foundry-local-sdk')).toBe(false);
    expect(isPackageAbsentError(esmPackageMissing('foundry-local-sdk'), 'foundry-local-sdk-winml')).toBe(false);
  });

  it('does not excuse an unrelated failure that carries no not-found code', () => {
    const err = new SyntaxError("Unexpected token — Cannot find package 'foundry-local-sdk'");
    expect(isPackageAbsentError(err, 'foundry-local-sdk')).toBe(false);
  });

  it('does not excuse a not-found code whose message names nothing', () => {
    const err = new Error('Resolution failed.');
    err.code = 'ERR_MODULE_NOT_FOUND';
    expect(isPackageAbsentError(err, 'foundry-local-sdk')).toBe(false);
  });

  it('tolerates a thrown non-error', () => {
    expect(isPackageAbsentError(null, 'foundry-local-sdk')).toBe(false);
    expect(isPackageAbsentError(undefined, 'foundry-local-sdk')).toBe(false);
    expect(isPackageAbsentError("Cannot find package 'foundry-local-sdk'", 'foundry-local-sdk')).toBe(false);
    expect(isPackageAbsentError({ code: 'ERR_MODULE_NOT_FOUND' }, 'foundry-local-sdk')).toBe(false);
    expect(isPackageAbsentError({ code: 42, message: "Cannot find package 'foundry-local-sdk'" }, 'x')).toBe(false);
  });
});
