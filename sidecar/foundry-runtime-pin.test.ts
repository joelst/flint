import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PINNED_FOUNDRY_CORE_VERSION,
  PINNED_FOUNDRY_SDK_VERSION,
  foundryRuntimePinWarning,
} from './foundry-runtime-pin.js';

describe('foundryRuntimePinWarning', () => {
  it('is silent when versions match the pin', () => {
    expect(foundryRuntimePinWarning({
      sdkVersion: PINNED_FOUNDRY_SDK_VERSION,
      coreVersion: PINNED_FOUNDRY_CORE_VERSION,
    })).toBeNull();
  });

  it('is silent when versions are unknown', () => {
    expect(foundryRuntimePinWarning({})).toBeNull();
    expect(foundryRuntimePinWarning({ sdkVersion: null, coreVersion: null })).toBeNull();
  });

  it('warns on an SDK mismatch without failing', () => {
    const warning = foundryRuntimePinWarning({
      sdkVersion: '2.0.0',
      coreVersion: PINNED_FOUNDRY_CORE_VERSION,
    });
    expect(warning).toContain('SDK 2.0.0');
    expect(warning).toContain(PINNED_FOUNDRY_SDK_VERSION);
    expect(warning).toContain('will continue');
  });

  it('warns on a native core mismatch', () => {
    const warning = foundryRuntimePinWarning({
      sdkVersion: PINNED_FOUNDRY_SDK_VERSION,
      coreVersion: '9.9.9',
    });
    expect(warning).toContain('native core 9.9.9');
  });
});

describe('package pin', () => {
  it('matches package.json foundry-local-sdk', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.dependencies['foundry-local-sdk']).toBe(PINNED_FOUNDRY_SDK_VERSION);
  });
});
