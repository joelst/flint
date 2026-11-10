import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFoundryManager, foundryManagerCreateConfig } from './foundry-manager-config.js';

const base = {
  appName: 'flint',
  logLevel: 'info',
  libraryPath: 'C:\\sdk\\prebuilds\\win32-x64',
};

describe('foundryManagerCreateConfig', () => {
  it('omits useSharedHost unless the caller opts in', () => {
    expect(foundryManagerCreateConfig(base)).toEqual(base);
    expect(foundryManagerCreateConfig({ ...base, useSharedHost: false })).toEqual(base);
    expect(foundryManagerCreateConfig({ ...base, useSharedHost: true })).toEqual({
      ...base,
      useSharedHost: true,
    });
  });

  it('refuses a shared host combined with serviceEndpoint', () => {
    expect(() => foundryManagerCreateConfig({
      ...base,
      useSharedHost: true,
      serviceEndpoint: 'http://127.0.0.1:9',
    })).toThrow(/Shared host cannot be combined with serviceEndpoint/);
  });
});

describe('createFoundryManager', () => {
  it('does not retry an in-process manager when the shared host fails', () => {
    const create = vi.fn(() => {
      throw new Error('host refused');
    });
    expect(() => createFoundryManager({ create }, { ...base, useSharedHost: true })).toThrow(
      /Shared host did not start, and Flint will not fall back to an in-process manager\. host refused/,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('leaves an in-process failure unchanged', () => {
    const failure = new Error('already initialized');
    const create = vi.fn(() => {
      throw failure;
    });
    expect(() => createFoundryManager({ create }, base)).toThrow(failure);
  });

  it('is the init path in the sidecar', () => {
    const source = readFileSync(join(process.cwd(), 'sidecar', 'foundry-sidecar-main.js'), 'utf8');
    expect(source).toContain('foundryManagerCreateConfig(');
    expect(source).toContain('createFoundryManager(');
  });
});
