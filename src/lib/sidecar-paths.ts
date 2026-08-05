/**
 * Pure path helpers for resolving the Foundry sidecar + NODE_PATH in Tauri
 * production vs dev layouts. Kept free of Tauri imports so unit tests can
 * cover Windows vs POSIX packaging without spawning a real app.
 *
 * Production layout (flattened tauri resources):
 *   $RESOURCE/sidecar/foundry-sidecar.js
 *   $RESOURCE/foundry-local-sdk/...
 */

/** Flattened resource key (map-form tauri resources: `$RESOURCE/sidecar/...`). */
export const SIDECAR_RESOURCE_KEY = 'sidecar/foundry-sidecar.js';

/** Ordered resource keys to try when resolving the sidecar script. */
export const SIDECAR_RESOURCE_CANDIDATES = [SIDECAR_RESOURCE_KEY] as const;

/** True for absolute filesystem paths (Windows drive/UNC or POSIX root). */
export function isAbsoluteFsPath(p: string): boolean {
  if (!p) return false;
  return (
    p.startsWith('/') ||
    p.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(p) ||
    p.startsWith('\\\\')
  );
}

export function joinResourcePath(basePath: string, relativePath: string): string {
  const separator = basePath.includes('\\') ? '\\' : '/';
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(/\//g, separator)}`;
}

/** NODE_PATH entry separator: `;` on Windows, `:` on macOS/Linux. Infer from a native path sample. */
export function nodePathDelimiter(samplePath: string): string {
  const s = samplePath || '';
  const isWindows = s.includes('\\') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\');
  return isWindows ? ';' : ':';
}

/**
 * If resolveResource points into `src-tauri/target/`, treat as dev and return the repo root.
 */
export function getTauriDevRepoRoot(resolvedResourcePath: string): string | null {
  const normalized = resolvedResourcePath.replace(/\\/g, '/');
  const marker = '/src-tauri/target/';
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const repoRoot = normalized.slice(0, markerIndex);
  return resolvedResourcePath.includes('\\') ? repoRoot.replace(/\//g, '\\') : repoRoot;
}

/**
 * Paths that may contain a packaged foundry-local-sdk next to the sidecar.
 * Flattened prod: $RESOURCE/foundry-local-sdk
 * Dev:            <repo>/node_modules/foundry-local-sdk (via NODE_PATH / cwd)
 *
 * Relative script paths are resolved against resourceRoot when possible; parent
 * derivation only runs on absolute paths (avoids `/foundry-local-sdk` junk).
 */
export function candidateSdkRoots(resourceRoot: string, scriptPath: string): string[] {
  const roots: string[] = [];
  const push = (p: string) => {
    if (p && !roots.includes(p)) roots.push(p);
  };

  let absoluteScript = scriptPath;
  if (!isAbsoluteFsPath(scriptPath) && resourceRoot && isAbsoluteFsPath(resourceRoot)) {
    absoluteScript = joinResourcePath(resourceRoot, scriptPath);
  }

  if (isAbsoluteFsPath(absoluteScript)) {
    const scriptDir = absoluteScript.replace(/[\\/][^\\/]+$/, '');
    const parentOfScript = scriptDir.replace(/[\\/][^\\/]+$/, '');
    if (parentOfScript && parentOfScript !== scriptDir && isAbsoluteFsPath(parentOfScript)) {
      push(joinResourcePath(parentOfScript, 'foundry-local-sdk'));
      push(joinResourcePath(parentOfScript, 'node_modules/foundry-local-sdk'));
    }
  }

  if (resourceRoot) {
    push(joinResourcePath(resourceRoot, 'foundry-local-sdk'));
    push(joinResourcePath(resourceRoot, 'node_modules/foundry-local-sdk'));
  }
  return roots;
}

/**
 * Directories that should appear on NODE_PATH (parents of foundry-local-sdk packages).
 */
export function buildNodePathEntries(resourceRoot: string, scriptPath: string): string[] {
  const entries: string[] = [];
  for (const sdkRoot of candidateSdkRoots(resourceRoot, scriptPath)) {
    const parent = sdkRoot.replace(/[\\/][^\\/]+$/, '');
    if (parent && !entries.includes(parent)) entries.push(parent);
  }
  if (resourceRoot && !entries.includes(resourceRoot)) {
    entries.push(resourceRoot);
  }
  return entries;
}

/** Join NODE_PATH entries with the delimiter implied by the path style. */
export function formatNodePath(entries: string[], samplePath?: string): string {
  if (!entries.length) return '';
  const delim = nodePathDelimiter(samplePath || entries[0] || '');
  return entries.join(delim);
}

export type ResolvedSidecarCandidate = {
  /** Resource key passed to resolveResource (e.g. sidecar/...). */
  key: string;
  /** Absolute path returned by resolveResource (may not exist). */
  resolvedPath: string;
  /** Result of exists() or equivalent. */
  exists: boolean;
};

export type SidecarSpawnPaths = {
  script: string;
  baseDir: string | undefined;
  isDev: boolean;
  nodePath: string;
  nodePathEntries: string[];
};

/**
 * Pure selection of sidecar script + cwd/NODE_PATH given already-resolved candidates.
 * Mirrors startSidecar() layout logic without Tauri APIs.
 */
export function selectSidecarSpawnPaths(opts: {
  candidates: ResolvedSidecarCandidate[];
  resourceDir?: string | null;
}): SidecarSpawnPaths {
  let script = SIDECAR_RESOURCE_KEY;
  let isDev = false;
  let baseDir: string | undefined;
  let resolvedOk = false;

  for (const c of opts.candidates) {
    const devRepoRoot = getTauriDevRepoRoot(c.resolvedPath);
    if (devRepoRoot) {
      script = joinResourcePath(devRepoRoot, SIDECAR_RESOURCE_KEY);
      baseDir = devRepoRoot;
      isDev = true;
      resolvedOk = true;
      break;
    }
    if (!c.exists) continue;
    script = c.resolvedPath;
    resolvedOk = true;
    break;
  }

  if (!resolvedOk) {
    script = SIDECAR_RESOURCE_KEY;
    isDev = true;
  }

  if (!baseDir && opts.resourceDir) {
    baseDir = opts.resourceDir;
  }

  if (isDev && baseDir && script === SIDECAR_RESOURCE_KEY) {
    const probe = joinResourcePath(baseDir, SIDECAR_RESOURCE_KEY);
    const devRepoRoot = getTauriDevRepoRoot(probe);
    if (devRepoRoot) {
      script = joinResourcePath(devRepoRoot, SIDECAR_RESOURCE_KEY);
      baseDir = devRepoRoot;
    }
  }

  const nodePathEntries = baseDir ? buildNodePathEntries(baseDir, script) : [];
  const nodePath = formatNodePath(nodePathEntries, baseDir || script);

  return { script, baseDir, isDev, nodePath, nodePathEntries };
}
