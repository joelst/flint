import { describe, expect, it } from 'vitest';
import { foundrySdkAboutLine } from './foundry-about';

describe('foundrySdkAboutLine', () => {
  it('stays on Checking until the sidecar reports', () => {
    expect(foundrySdkAboutLine(null)).toEqual({ label: 'Checking…', ok: null });
  });

  it('says Unknown when the report has no SDK version', () => {
    expect(foundrySdkAboutLine({
      sdkVersion: '  ',
      coreVersion: null,
      sdkPin: '2.1.0',
      corePin: '2.1.0',
    })).toEqual({ label: 'Unknown', ok: null });
  });

  it('shows a matching SDK version as ok', () => {
    expect(foundrySdkAboutLine({
      sdkVersion: '2.1.0',
      coreVersion: '2.1.0',
      sdkPin: '2.1.0',
      corePin: '2.1.0',
    })).toEqual({ label: '2.1.0', ok: true });
  });

  it('keeps a core version that differs from the SDK when both match their pins', () => {
    expect(foundrySdkAboutLine({
      sdkVersion: '2.1.0',
      coreVersion: '2.4.0',
      sdkPin: '2.1.0',
      corePin: '2.4.0',
    })).toEqual({ label: '2.1.0 · core 2.4.0', ok: true });
  });

  it('marks an SDK mismatch', () => {
    expect(foundrySdkAboutLine({
      sdkVersion: '2.0.1',
      coreVersion: '2.0.1',
      sdkPin: '2.1.0',
      corePin: '2.1.0',
    })).toEqual({ label: '2.0.1 (tested on 2.1.0)', ok: false });
  });

  it('marks a core mismatch even when the SDK matches', () => {
    expect(foundrySdkAboutLine({
      sdkVersion: '2.1.0',
      coreVersion: '9.9.9',
      sdkPin: '2.1.0',
      corePin: '2.1.0',
    })).toEqual({ label: '2.1.0 · core 9.9.9 (tested on 2.1.0)', ok: false });
  });

  it.each(['coreVersion', 'sdkPin', 'corePin'] as const)(
    'does not confirm compatibility when %s is missing',
    (field) => {
      for (const missing of [null, '  ']) {
        expect(foundrySdkAboutLine({
          sdkVersion: '2.4.1',
          coreVersion: '2.4.1',
          sdkPin: '2.4.1',
          corePin: '2.4.1',
          [field]: missing,
        })).toEqual({ label: '2.4.1 (compatibility unverified)', ok: null });
      }
    },
  );

  it('keeps a known mismatch even when another version is unknown', () => {
    expect(foundrySdkAboutLine({
      sdkVersion: '2.0.1',
      coreVersion: null,
      sdkPin: '2.1.0',
      corePin: null,
    })).toEqual({ label: '2.0.1 (tested on 2.1.0)', ok: false });
  });

  it('names the expected core pin when only the core mismatches', () => {
    expect(foundrySdkAboutLine({
      sdkVersion: '2.1.0',
      coreVersion: '9.9.9',
      sdkPin: '2.1.0',
      corePin: '2.4.0',
    })).toEqual({ label: '2.1.0 · core 9.9.9 (tested on 2.4.0)', ok: false });
  });
});
