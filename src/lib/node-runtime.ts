/**
 * Node.js preflight for the Foundry JS sidecar.
 *
 * Spike A: prefer bundled Node (Tauri externalBin `binaries/node`); fall back
 * to PATH `node` for dev. See docs/DEVELOPMENT.md and scripts/ensure-bundled-node.cjs.
 */

import type { NodeRuntimeMode } from './sidecar-paths';

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
  | { ok: true; version: NodeVersion; mode?: NodeRuntimeMode }
  | {
      ok: false;
      code: NodePreflightCode;
      message: string;
      found?: NodeVersion;
      mode?: NodeRuntimeMode;
    };

export type NodeMissingContext = {
  /**
   * Which modes were attempted (drives message copy).
   * Prefer this over `bundledOnly` when both are available.
   */
  tried?: NodeRuntimeMode[];
  /**
   * True when only the bundled runtime was required/attempted.
   * Still honored when `tried` is omitted (legacy callers).
   */
  bundledOnly?: boolean;
};

/** Normalize which Node modes to describe in missing-runtime guidance. */
export function resolveMissingModes(ctx: NodeMissingContext = {}): {
  triedBundled: boolean;
  triedPath: boolean;
} {
  if (ctx.tried && ctx.tried.length > 0) {
    return {
      triedBundled: ctx.tried.includes('bundled'),
      triedPath: ctx.tried.includes('path'),
    };
  }
  if (ctx.bundledOnly) {
    return { triedBundled: true, triedPath: false };
  }
  // Default (no context): assume auto probe order — bundled then PATH.
  return { triedBundled: true, triedPath: true };
}

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
  ctx: NodeMissingContext = {},
): string {
  const minLabel = formatNodeVersion(min);
  const { triedBundled, triedPath } = resolveMissingModes(ctx);

  // Only bundled was attempted (preference=bundled, or bundled-only probe).
  if (triedBundled && !triedPath) {
    return [
      `Flint could not start its bundled Node.js ${minLabel}+ runtime for the Foundry sidecar.`,
      'The packaged Node binary is missing or failed to launch.',
      '',
      'Try reinstalling Flint from the latest release.',
      'Developers: run `npm run ensure:node` then rebuild (see docs/DEVELOPMENT.md).',
    ].join('\n');
  }

  // Only PATH was attempted (preference=path, or PATH-only probe).
  if (triedPath && !triedBundled) {
    return [
      `Flint needs Node.js ${minLabel}+ on your PATH to run the local Foundry sidecar.`,
      'Node.js was not found (or is not on PATH).',
      '',
      'Install the LTS build from https://nodejs.org then quit and reopen Flint.',
      'Windows (optional): winget install OpenJS.NodeJS.LTS',
      'macOS (optional): brew install node',
      '',
      'Tip: release builds prefer a bundled Node binary; use PATH only when that is unavailable',
      'or when FLINT/VITE node runtime preference is set to `path`.',
    ].join('\n');
  }

  // Auto / both attempted: bundled failed, then PATH failed.
  return [
    `Flint needs Node.js ${minLabel}+ to run the local Foundry sidecar.`,
    'Bundled runtime was not available, and Node.js was not found on PATH.',
    '',
    'Install the LTS build from https://nodejs.org then quit and reopen Flint.',
    'Windows (optional): winget install OpenJS.NodeJS.LTS',
    'macOS (optional): brew install node',
    '',
    'Release builds ship a bundled Node binary; PATH Node remains a dev fallback.',
    'Developers: `npm run ensure:node` stages the binary under src-tauri/binaries/.',
  ].join('\n');
}

export function buildNodeTooOldMessage(
  found: NodeVersion,
  min: { major: number; minor: number; patch: number } = MIN_NODE_VERSION,
): string {
  const minLabel = formatNodeVersion(min);
  return [
    `Flint needs Node.js ${minLabel}+ to run the local Foundry sidecar.`,
    `Found ${found.raw}, which is too old.`,
    '',
    'Upgrade from https://nodejs.org (LTS recommended), then quit and reopen Flint.',
    'Windows (optional): winget install OpenJS.NodeJS.LTS',
    'macOS (optional): brew install node',
    '',
    'Or rebuild with `npm run ensure:node` so the app uses the bundled Node 22 runtime.',
  ].join('\n');
}

export function buildNodeProbeFailedMessage(detail?: string): string {
  const extra = detail ? `\nDetails: ${detail}` : '';
  return [
    'Could not verify the Node.js installation required for the Foundry sidecar.',
    `Need Node.js ${MIN_NODE_VERSION.major}+ (bundled runtime or on PATH).`,
    'Download: https://nodejs.org — or reinstall Flint / run `npm run ensure:node`.',
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Higher = more actionable for the user when multiple modes fail. */
const PREFLIGHT_FAILURE_RANK: Record<NodePreflightCode, number> = {
  NODE_TOO_OLD: 3,
  NODE_PROBE_FAILED: 2,
  NODE_MISSING: 1,
};

export type NodePreflightFailure = Extract<NodePreflightResult, { ok: false }>;

/**
 * Choose the best failure when every Node runtime mode failed.
 * Prefers TOO_OLD / PROBE_FAILED over a synthetic MISSING; on ties, prefers
 * later probe order (e.g. PATH after bundled) so the user-facing runtime wins.
 * NODE_MISSING results are rewritten with the full `tried` set for accurate copy.
 */
export function pickBestNodePreflightFailure(
  failures: NodePreflightFailure[],
  triedModes: NodeRuntimeMode[],
): NodePreflightFailure {
  if (!failures.length) {
    return {
      ok: false,
      code: 'NODE_MISSING',
      message: buildNodeMissingMessage(undefined, { tried: triedModes }),
    };
  }

  let best = failures[0];
  for (let i = 1; i < failures.length; i++) {
    const candidate = failures[i];
    const rankC = PREFLIGHT_FAILURE_RANK[candidate.code];
    const rankB = PREFLIGHT_FAILURE_RANK[best.code];
    if (rankC > rankB || rankC === rankB) {
      // Higher rank wins; equal rank → later mode (PATH after bundled in auto).
      best = candidate;
    }
  }

  if (best.code === 'NODE_MISSING') {
    return {
      ok: false,
      code: 'NODE_MISSING',
      message: buildNodeMissingMessage(undefined, {
        tried: triedModes.length ? triedModes : best.mode ? [best.mode] : undefined,
        bundledOnly: triedModes.length === 1 && triedModes[0] === 'bundled',
      }),
      mode: best.mode,
      found: best.found,
    };
  }

  return best;
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
  missingContext?: NodeMissingContext;
  mode?: NodeRuntimeMode;
}): NodePreflightResult {
  const min = options.min ?? MIN_NODE_VERSION;
  const err = options.probeError ? String(options.probeError) : '';
  const stdout = options.stdout != null ? String(options.stdout) : '';
  const missingCtx = options.missingContext ?? {};
  const mode = options.mode;

  if (err) {
    const lower = err.toLowerCase();
    const missing =
      lower.includes('enoent') ||
      lower.includes('not found') ||
      lower.includes('cannot find') ||
      lower.includes('is not recognized') ||
      lower.includes('no such file') ||
      lower.includes('program not found') ||
      lower.includes('sidecar not allowed') ||
      lower.includes('unknown program') ||
      lower.includes('failed to find sidecar') ||
      lower.includes('sidecar binary');
    if (missing) {
      return {
        ok: false,
        code: 'NODE_MISSING',
        message: buildNodeMissingMessage(min, missingCtx),
        mode,
      };
    }
    // Some shells still return empty stdout with a generic failure when node is missing.
    if (!stdout.trim()) {
      return {
        ok: false,
        code: 'NODE_PROBE_FAILED',
        message: buildNodeProbeFailedMessage(err),
        mode,
      };
    }
  }

  const version = parseNodeVersion(stdout);
  if (!version) {
    if (!stdout.trim() && !err) {
      return {
        ok: false,
        code: 'NODE_MISSING',
        message: buildNodeMissingMessage(min, missingCtx),
        mode,
      };
    }
    return {
      ok: false,
      code: 'NODE_PROBE_FAILED',
      message: buildNodeProbeFailedMessage(
        err || (stdout ? `unrecognized version output: ${stdout.trim()}` : 'empty output'),
      ),
      mode,
    };
  }

  if (!isNodeVersionAtLeast(version, min)) {
    return {
      ok: false,
      code: 'NODE_TOO_OLD',
      message: buildNodeTooOldMessage(version, min),
      found: version,
      mode,
    };
  }

  return { ok: true, version, mode };
}
