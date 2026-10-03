import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBuildEnv,
  createTauriBuildArgs,
  createTauriConfig,
  isConfigOverrideArg,
  main,
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

  it('treats attached -c values as config overrides and leaves runner args alone', () => {
    expect(isConfigOverrideArg('-cother.json')).toBe(true);
    expect(isConfigOverrideArg('-c=other.json')).toBe(true);
    expect(isConfigOverrideArg('--config=other.json')).toBe(true);
    expect(isConfigOverrideArg('--ci')).toBe(false);
    expect(isConfigOverrideArg('--target')).toBe(false);
  });
});

describe('local versioned build command', () => {
  function run(argv, overrides = {}) {
    const calls = { removed: [], written: [], spawned: null, errors: [], prefix: null };
    const exitCode = main(argv, {
      mkdtempSync: (prefix) => {
        calls.prefix = prefix;
        return path.join('C:\\temp', 'flint-local-build-abc');
      },
      writeFileSync: (file, data) => {
        calls.written.push({ file, data });
      },
      rmSync: (dir, options) => {
        calls.removed.push({ dir, options });
      },
      spawnSync: (command, args, options) => {
        calls.spawned = { command, args, options };
        return overrides.spawnResult ?? { status: 0 };
      },
      resolveTauriCli: () => 'tauri.js',
      cwd: 'F:\\repo',
      execPath: 'node',
      env: { PATH: 'path' },
      tmpdir: 'C:\\temp',
      logError: (line) => {
        calls.errors.push(line);
      },
      ...overrides.deps,
    });
    return { exitCode, calls };
  }

  it('rejects an invalid version before creating a temp config or starting Tauri', () => {
    const { exitCode, calls } = run(['1.2']);
    expect(exitCode).toBe(2);
    expect(calls.errors[0]).toMatch(/Usage:/);
    expect(calls.prefix).toBeNull();
    expect(calls.spawned).toBeNull();
    expect(calls.removed).toEqual([]);
  });

  it.each([
    ['--config', 'other.json'],
    ['-c', 'other.json'],
    ['--config=other.json'],
    ['-cother.json'],
    ['-c=other.json'],
  ])('rejects a config override (%s) so it cannot replace the temporary version', (...args) => {
    const { exitCode, calls } = run(['0.10.0', ...args]);
    expect(exitCode).toBe(2);
    expect(calls.errors).toEqual([
      'Do not pass --config or -c; this command supplies a temporary version override.',
    ]);
    expect(calls.spawned).toBeNull();
    expect(calls.removed).toEqual([]);
  });

  it('forwards runner arguments after -- and still removes the temp directory', () => {
    const { exitCode, calls } = run(['0.10.0', '--target', 'x86_64-pc-windows-msvc', '--', '-cother.json']);
    const configPath = path.join('C:\\temp', 'flint-local-build-abc', 'tauri-version.json');
    expect(exitCode).toBe(0);
    expect(calls.prefix).toBe(path.join('C:\\temp', 'flint-local-build-'));
    expect(JSON.parse(calls.written[0].data)).toEqual({ version: '0.10.0' });
    expect(calls.written[0].file).toBe(configPath);
    expect(calls.spawned).toEqual({
      command: 'node',
      args: [
        'tauri.js',
        'build',
        '--no-sign',
        '--config',
        configPath,
        '--target',
        'x86_64-pc-windows-msvc',
        '--',
        '-cother.json',
      ],
      options: {
        cwd: 'F:\\repo',
        stdio: 'inherit',
        env: { PATH: 'path', VITE_FLINT_BUILD_VERSION: '0.10.0' },
      },
    });
    expect(calls.removed).toEqual([{
      dir: path.join('C:\\temp', 'flint-local-build-abc'),
      options: { recursive: true, force: true },
    }]);
  });

  it('returns the child status and still removes the temp directory', () => {
    const { exitCode, calls } = run(['0.10.0'], { spawnResult: { status: 3 } });
    expect(exitCode).toBe(3);
    expect(calls.removed).toHaveLength(1);
  });

  it('returns 1 when the child reports no status and still removes the temp directory', () => {
    const { exitCode, calls } = run(['0.10.0'], { spawnResult: { status: null } });
    expect(exitCode).toBe(1);
    expect(calls.removed).toHaveLength(1);
  });

  it('returns 1 when Tauri cannot be started and still removes the temp directory', () => {
    const { exitCode, calls } = run(['0.10.0'], {
      spawnResult: { error: new Error('spawn ENOENT') },
    });
    expect(exitCode).toBe(1);
    expect(calls.errors).toEqual(['Local Tauri build failed: spawn ENOENT']);
    expect(calls.removed).toHaveLength(1);
  });

  it('removes the temp directory when writing the override fails', () => {
    const { exitCode, calls } = run(['0.10.0'], {
      deps: {
        writeFileSync: () => {
          throw new Error('disk full');
        },
      },
    });
    expect(exitCode).toBe(1);
    expect(calls.errors).toEqual(['Local Tauri build failed: disk full']);
    expect(calls.spawned).toBeNull();
    expect(calls.removed).toHaveLength(1);
  });
});
