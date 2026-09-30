import { describe, expect, it } from 'vitest';
import {
  createBuildEnv,
  createTauriBuildArgs,
  createTauriConfig,
} from './build-local-version.cjs';

describe('local versioned build arguments', () => {
  it('uses an ephemeral config override and keeps local builds unsigned', () => {
    expect(JSON.parse(createTauriConfig('0.10.0'))).toEqual({ version: '0.10.0' });
    expect(createTauriBuildArgs('C:\\temp\\tauri-version.json')).toEqual([
      'build',
      '--no-sign',
      '--config',
      'C:\\temp\\tauri-version.json',
    ]);
  });

  it('forwards additional Tauri build options', () => {
    expect(createTauriBuildArgs('config.json', ['--target', 'x86_64-pc-windows-msvc']))
      .toEqual([
        'build',
        '--no-sign',
        '--config',
        'config.json',
        '--target',
        'x86_64-pc-windows-msvc',
      ]);
  });

  it('passes the same version to the frontend without changing other environment values', () => {
    expect(createBuildEnv('0.10.0', { PATH: 'path', VITE_FLINT_BUILD_VERSION: '0.9.1' }))
      .toEqual({ PATH: 'path', VITE_FLINT_BUILD_VERSION: '0.10.0' });
  });
});
