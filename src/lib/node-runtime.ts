/**
 * Node.js preflight for the Foundry JS sidecar.
 * End-user installers still spawn `node` on PATH (see docs/BACKLOG.md).
 */

/** Oldest Node line still receiving security updates (Maintenance LTS as of mid-2026). */
export const MIN_NODE_VERSION = { major: 22, minor: 0, patch: 0 } as const;

export type NodeVersion = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

export type NodePreflightCode =
  | 'NODE_MISSING'
  | 'NODE_TOO_OLD'
  | 'NODE_PROBE_FAILED';

export type NodePreflightResult =
  | { ok: true; version: NodeVersion }
  | { ok: false; code: NodePreflightCode; message: string; found?: NodeVersion };

/** Parse `node -v` / `node --version` output (e.g. "v18.19.0", "18.19.0\n"). */
export function parseNodeVersion(output: string): NodeVersion | null {
  const text = String(output || '').trim();
  // Match first semver-like triple; allow leading v and trailing build metadata.
  const m = text.match(/v?(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    raw: `v${m[1]}.${m[2]}.${m[3]}`,
  };
}

export function formatNodeVersion(v: {
  major: number;
  minor: number;
  patch: number;
}): string {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

export function isNodeVersionAtLeast(
  found: { major: number; minor: number; patch: number },
  min: { major: number; minor: number; patch: number } = MIN_NODE_VERSION,
): boolean {
  if (found.major !== min.major) return found.major > min.major;
  if (found.minor !== min.minor) return found.minor > min.minor;
  return found.patch >= min.patch;
}

export function buildNodeMissingMessage(
  min: { major: number; minor: number; patch: number } = MIN_NODE_VERSION,
): string {
  const minLabel = formatNodeVersion(min);
  return [
    `Flint needs Node.js ${minLabel}+ on your PATH to run the local Foundry sidecar.`,
    'Node.js was not found (or is not on PATH).',
    '',
    'Install the LTS build from https://nodejs.org then quit and reopen Flint.',
    'Windows (optional): winget install OpenJS.NodeJS.LTS',
    'macOS (optional): brew install node',
    '',
    'Foundry Local runtime is already bundled with Flint; only Node is an external dependency for now.',
  ].join('\n');
}

export function buildNodeTooOldMessage(
  found: NodeVersion,
  min: { major: number; minor: number; patch: number } = MIN_NODE_VERSION,
): string {
  const minLabel = formatNodeVersion(min);
  return [
    `Flint needs Node.js ${minLabel}+ on your PATH to run the local Foundry sidecar.`,
    `Found ${found.raw}, which is too old.`,
    '',
    'Upgrade from https://nodejs.org (LTS recommended), then quit and reopen Flint.',
    'Windows (optional): winget install OpenJS.NodeJS.LTS',
    'macOS (optional): brew install node',
    '',
    'Foundry Local runtime is already bundled with Flint; only Node is an external dependency for now.',
  ].join('\n');
}

export function buildNodeProbeFailedMessage(detail?: string): string {
  const extra = detail ? `\nDetails: ${detail}` : '';
  return [
    'Could not verify the Node.js installation required for the Foundry sidecar.',
    'Ensure Node.js 22+ is installed and on your PATH, then quit and reopen Flint.',
    'Download: https://nodejs.org',
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Evaluate raw probe outcome into a structured preflight result.
 * `probeError` is set when the shell command failed to run.
 * `stdout` is the successful command output when present.
 */
export function evaluateNodeProbe(options: {
  stdout?: string | null;
  probeError?: string | null;
  min?: { major: number; minor: number; patch: number };
}): NodePreflightResult {
  const min = options.min ?? MIN_NODE_VERSION;
  const err = options.probeError ? String(options.probeError) : '';
  const stdout = options.stdout != null ? String(options.stdout) : '';

  if (err) {
    const lower = err.toLowerCase();
    const missing =
      lower.includes('enoent') ||
      lower.includes('not found') ||
      lower.includes('cannot find') ||
      lower.includes('is not recognized') ||
      lower.includes('no such file') ||
      lower.includes('program not found');
    if (missing) {
      return { ok: false, code: 'NODE_MISSING', message: buildNodeMissingMessage(min) };
    }
    // Some shells still return empty stdout with a generic failure when node is missing.
    if (!stdout.trim()) {
      return {
        ok: false,
        code: 'NODE_PROBE_FAILED',
        message: buildNodeProbeFailedMessage(err),
      };
    }
  }

  const version = parseNodeVersion(stdout);
  if (!version) {
    if (!stdout.trim() && !err) {
      return { ok: false, code: 'NODE_MISSING', message: buildNodeMissingMessage(min) };
    }
    return {
      ok: false,
      code: 'NODE_PROBE_FAILED',
      message: buildNodeProbeFailedMessage(
        err || (stdout ? `unrecognized version output: ${stdout.trim()}` : 'empty output'),
      ),
    };
  }

  if (!isNodeVersionAtLeast(version, min)) {
    return {
      ok: false,
      code: 'NODE_TOO_OLD',
      message: buildNodeTooOldMessage(version, min),
      found: version,
    };
  }

  return { ok: true, version };
}
