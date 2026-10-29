import { describe, expect, it } from 'vitest';
import { isRuntimeSmokeSuccessful } from './runtime-smoke-result.cjs';

describe('isRuntimeSmokeSuccessful', () => {
  it('requires an explicit ready result and a zero exit', () => {
    expect(
      isRuntimeSmokeSuccessful({
        status: 0,
        stdout: '',
        stderr: '[flint] runtime smoke: ready',
      }),
    ).toBe(true);
  });

  it('rejects a timeout even when the executable exits zero', () => {
    expect(
      isRuntimeSmokeSuccessful({
        status: 0,
        stdout: '',
        stderr: '[flint] runtime smoke: timed out waiting for ready',
      }),
    ).toBe(false);
  });

  it('rejects a ready message when the executable exits nonzero', () => {
    expect(
      isRuntimeSmokeSuccessful({
        status: 1,
        stdout: '',
        stderr: '[flint] runtime smoke: ready',
      }),
    ).toBe(false);
  });
});
