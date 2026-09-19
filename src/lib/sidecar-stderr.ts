/**
 * Sidecar diagnostics redirected off stdout are tagged so the SDK can keep
 * unprefixed native stderr as errors. Keep the prefix in sync with
 * sidecar/protocol-stdout.js (`DIAGNOSTIC_PREFIX`).
 */
export const SIDECAR_DIAGNOSTIC_PREFIX = 'FLINT_DIAG';

export type SidecarStderrLevel = 'debug' | 'info' | 'warn' | 'error';

function isSidecarStderrLevel(value: string): value is SidecarStderrLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

export function classifySidecarStderrLine(line: string): {
  level: SidecarStderrLevel;
  message: string;
} {
  const trimmed = line.trim();
  if (!trimmed) return { level: 'error', message: '' };
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
