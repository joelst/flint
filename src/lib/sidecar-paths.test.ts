import { describe, it, expect } from 'vitest';
import {
  isAbsoluteFsPath,
  joinResourcePath,
  nodePathDelimiter,
  getTauriDevRepoRoot,
  candidateSdkRoots,
  buildNodePathEntries,
  formatNodePath,
  selectSidecarSpawnPaths,
  SIDECAR_RESOURCE_KEY,
  SIDECAR_RESOURCE_CANDIDATES,
} from './sidecar-paths';

describe('isAbsoluteFsPath', () => {
  it('detects Windows drive and UNC', () => {
    expect(isAbsoluteFsPath('C:\\Users\\app\\Flint')).toBe(true);
    expect(isAbsoluteFsPath('C:/Users/app/Flint')).toBe(true);
    expect(isAbsoluteFsPath('\\\\server\\share')).toBe(true);
  });

  it('detects POSIX absolute', () => {
    expect(isAbsoluteFsPath('/Applications/Flint.app/Contents/Resources')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isAbsoluteFsPath('sidecar/foundry-sidecar.js')).toBe(false);
    expect(isAbsoluteFsPath('../sidecar/foundry-sidecar.js')).toBe(false);
    expect(isAbsoluteFsPath('')).toBe(false);
  });
});

describe('joinResourcePath', () => {
  it('uses backslash when base is Windows-style', () => {
    expect(joinResourcePath('C:\\Flint', 'sidecar/foundry-sidecar.js')).toBe(
      'C:\\Flint\\sidecar\\foundry-sidecar.js',
    );
  });

  it('uses forward slash when base is POSIX', () => {
    expect(joinResourcePath('/opt/Flint', 'sidecar/foundry-sidecar.js')).toBe(
      '/opt/Flint/sidecar/foundry-sidecar.js',
    );
  });

  it('strips trailing separators on base', () => {
    expect(joinResourcePath('C:\\Flint\\', 'foundry-local-sdk')).toBe('C:\\Flint\\foundry-local-sdk');
    expect(joinResourcePath('/opt/Flint/', 'foundry-local-sdk')).toBe('/opt/Flint/foundry-local-sdk');
  });
});

describe('nodePathDelimiter / formatNodePath', () => {
  it('uses ; for Windows paths and : for POSIX', () => {
    expect(nodePathDelimiter('C:\\Flint')).toBe(';');
    expect(nodePathDelimiter('/opt/Flint')).toBe(':');
  });

  it('joins NODE_PATH with the OS-appropriate delimiter', () => {
    expect(formatNodePath(['C:\\Flint', 'C:\\Flint\\extra'], 'C:\\Flint')).toBe(
      'C:\\Flint;C:\\Flint\\extra',
    );
    expect(formatNodePath(['/opt/Flint', '/opt/Flint/extra'], '/opt/Flint')).toBe(
      '/opt/Flint:/opt/Flint/extra',
    );
  });
});

describe('getTauriDevRepoRoot', () => {
  it('extracts repo root from staged Windows target paths', () => {
    expect(
      getTauriDevRepoRoot(
        'F:\\git\\flint\\src-tauri\\target\\release\\sidecar\\foundry-sidecar.js',
      ),
    ).toBe('F:\\git\\flint');
  });

  it('extracts repo root from POSIX target paths', () => {
    expect(
      getTauriDevRepoRoot('/home/dev/flint/src-tauri/target/debug/sidecar/foundry-sidecar.js'),
    ).toBe('/home/dev/flint');
  });

  it('returns null for installed app paths', () => {
    expect(
      getTauriDevRepoRoot('C:\\Users\\joels\\AppData\\Local\\Flint\\sidecar\\foundry-sidecar.js'),
    ).toBeNull();
    expect(getTauriDevRepoRoot('/Applications/Flint.app/Contents/Resources/sidecar/x.js')).toBeNull();
  });
});

describe('candidateSdkRoots', () => {
  it('Windows flattened install: parent of absolute sidecar + resource layouts', () => {
    const root = 'C:\\Users\\me\\AppData\\Local\\Flint';
    const script = `${root}\\sidecar\\foundry-sidecar.js`;
    const roots = candidateSdkRoots(root, script);
    expect(roots).toContain(`${root}\\foundry-local-sdk`);
    expect(roots).toContain(`${root}\\node_modules\\foundry-local-sdk`);
    expect(roots.some((r) => r === '\\foundry-local-sdk' || r === '/foundry-local-sdk')).toBe(false);
    expect(roots.some((r) => r.includes('_up_'))).toBe(false);
  });

  it('POSIX flattened: uses forward slashes', () => {
    const root = '/Applications/Flint.app/Contents/Resources';
    const script = `${root}/sidecar/foundry-sidecar.js`;
    const roots = candidateSdkRoots(root, script);
    expect(roots).toContain(`${root}/foundry-local-sdk`);
    expect(roots).toContain(`${root}/node_modules/foundry-local-sdk`);
  });

  it('relative script alone does not create absolute /foundry-local-sdk', () => {
    const roots = candidateSdkRoots('', 'sidecar/foundry-sidecar.js');
    expect(roots).toEqual([]);
    expect(roots.some((r) => r === '/foundry-local-sdk')).toBe(false);
  });

  it('relative script is resolved against absolute resource root', () => {
    const root = 'C:\\Flint';
    const roots = candidateSdkRoots(root, 'sidecar/foundry-sidecar.js');
    expect(roots[0]).toBe(`${root}\\foundry-local-sdk`);
    expect(roots).toContain(`${root}\\node_modules\\foundry-local-sdk`);
  });
});

describe('buildNodePathEntries', () => {
  it('lists parents of SDK packages (where Node looks for foundry-local-sdk)', () => {
    const root = 'C:\\Flint';
    const script = `${root}\\sidecar\\foundry-sidecar.js`;
    const entries = buildNodePathEntries(root, script);
    expect(entries).toContain(root);
  });

  it('POSIX NODE_PATH parents use : when formatted', () => {
    const root = '/opt/Flint';
    const script = `${root}/sidecar/foundry-sidecar.js`;
    const entries = buildNodePathEntries(root, script);
    const formatted = formatNodePath(entries, root);
    expect(formatted.includes(':')).toBe(true);
    expect(formatted.includes(';')).toBe(false);
    expect(formatted.split(':')).toEqual(entries);
  });
});

describe('selectSidecarSpawnPaths', () => {
  it('uses flattened candidate when it exists (Windows install)', () => {
    const resourceDir = 'C:\\Users\\me\\AppData\\Local\\Flint';
    const result = selectSidecarSpawnPaths({
      resourceDir,
      candidates: [
        {
          key: SIDECAR_RESOURCE_KEY,
          resolvedPath: `${resourceDir}\\sidecar\\foundry-sidecar.js`,
          exists: true,
        },
      ],
    });
    expect(result.isDev).toBe(false);
    expect(result.script).toBe(`${resourceDir}\\sidecar\\foundry-sidecar.js`);
    expect(result.baseDir).toBe(resourceDir);
    expect(result.nodePath.split(';')).toContain(resourceDir);
  });

  it('POSIX flattened install', () => {
    const resourceDir = '/Applications/Flint.app/Contents/Resources';
    const result = selectSidecarSpawnPaths({
      resourceDir,
      candidates: [
        {
          key: SIDECAR_RESOURCE_KEY,
          resolvedPath: `${resourceDir}/sidecar/foundry-sidecar.js`,
          exists: true,
        },
      ],
    });
    expect(result.script).toBe(`${resourceDir}/sidecar/foundry-sidecar.js`);
    expect(result.nodePath.includes(':') || result.nodePath === resourceDir).toBe(true);
    expect(result.nodePath.includes(';')).toBe(false);
  });

  it('dev: target-dir resolution rewrites to repo sidecar', () => {
    const result = selectSidecarSpawnPaths({
      resourceDir: 'F:\\git\\flint\\src-tauri\\target\\release',
      candidates: [
        {
          key: SIDECAR_RESOURCE_KEY,
          resolvedPath:
            'F:\\git\\flint\\src-tauri\\target\\release\\sidecar\\foundry-sidecar.js',
          exists: true,
        },
      ],
    });
    expect(result.isDev).toBe(true);
    expect(result.baseDir).toBe('F:\\git\\flint');
    expect(result.script).toBe('F:\\git\\flint\\sidecar\\foundry-sidecar.js');
  });

  it('falls back to relative script when no candidates exist', () => {
    const result = selectSidecarSpawnPaths({
      resourceDir: 'C:\\Flint',
      candidates: [
        {
          key: SIDECAR_RESOURCE_KEY,
          resolvedPath: 'C:\\Flint\\sidecar\\foundry-sidecar.js',
          exists: false,
        },
      ],
    });
    expect(result.isDev).toBe(true);
    expect(result.script).toBe(SIDECAR_RESOURCE_KEY);
    expect(result.nodePathEntries.length).toBeGreaterThan(0);
  });

  it('exposes a single flattened resource key', () => {
    expect(SIDECAR_RESOURCE_CANDIDATES).toEqual([SIDECAR_RESOURCE_KEY]);
  });
});
