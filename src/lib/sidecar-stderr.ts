/**
 * Sidecar diagnostics redirected off stdout are tagged so the SDK can keep
 * unprefixed native stderr as errors. Keep the prefix in sync with
 * sidecar/protocol-stdout.js (`DIAGNOSTIC_PREFIX`).
 *
 * Foundry 2.0 also writes its own log lines straight to stderr as `[info]` /
 * `[error]` with no Flint tag. Those are not failures; the bracket is the level.
 */
export const SIDECAR_DIAGNOSTIC_PREFIX = 'FLINT_DIAG';

export type SidecarStderrLevel = 'debug' | 'info' | 'warn' | 'error';

const SDK_LEVEL_PREFIX = /^\[(trace|debug|info|warn|warning|error|fatal)\]\s+/i;

function isSidecarStderrLevel(value: string): value is SidecarStderrLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function levelFromSdkBracket(raw: string): SidecarStderrLevel {
  const level = raw.toLowerCase();
  if (level === 'warning') return 'warn';
  if (level === 'fatal') return 'error';
  if (level === 'trace') return 'debug';
  return level as SidecarStderrLevel;
}

export function classifySidecarStderrLine(line: string): {
  level: SidecarStderrLevel;
  message: string;
} {
  const trimmed = line.trim();
  if (!trimmed) return { level: 'error', message: '' };

  const sdkLevel = trimmed.match(SDK_LEVEL_PREFIX);
  if (sdkLevel) {
    const message = trimmed.slice(sdkLevel[0].length);
    if (message) return { level: levelFromSdkBracket(sdkLevel[1]), message };
  }

  const space = trimmed.indexOf(' ');
  if (space === -1) return { level: 'error', message: trimmed };
  const prefix = trimmed.slice(0, space);
  const rest = trimmed.slice(space + 1);
  const levelSpace = rest.indexOf(' ');
  if (prefix !== SIDECAR_DIAGNOSTIC_PREFIX || levelSpace === -1) {
    return { level: 'error', message: trimmed };
  }
  const level = rest.slice(0, levelSpace);
  const message = rest.slice(levelSpace + 1);
  if (!isSidecarStderrLevel(level) || !message) {
    return { level: 'error', message: trimmed };
  }
  return { level, message };
}
