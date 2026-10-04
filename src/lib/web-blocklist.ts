/**
 * Hosts Flint will not contact, even when a search or domain grant would allow them.
 *
 * `policy` is empty until an IT-deployed list exists. The argument is the seam for that file.
 */
import { canonicalHostname, isLocalHostname } from '../../sidecar/web-address-policy.js';

export const BUILT_IN_WEB_BLOCKLIST = [
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.internal',
] as const;

export function mergeBlocklists(
  builtIn: readonly string[] = BUILT_IN_WEB_BLOCKLIST,
  user: readonly string[] = [],
  policy: readonly string[] = [],
): string[] {
  const hosts = new Set<string>();
  for (const entry of [...builtIn, ...policy, ...user]) {
    const host = canonicalBlockHost(entry);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/** A hostname entry, or null when the line is not a host. No paths, ports, or wildcards. */
export function canonicalBlockHost(entry: unknown): string | null {
  const raw = String(entry ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!raw || raw.includes('/') || raw.includes(':') || raw.includes('*') || raw.includes(' ')) return null;
  if (!/^[a-z0-9.-]+$/.test(raw)) return null;
  return canonicalHostname(raw);
}

export function parseBlocklistText(text: string): { hosts: string[]; rejected: string[] } {
  const hosts: string[] = [];
  const rejected: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const host = canonicalBlockHost(trimmed);
    if (!host) rejected.push(trimmed);
    else if (!hosts.includes(host)) hosts.push(host);
  }
  return { hosts, rejected };
}

/**
 * `example.com` blocks that host and `sub.example.com`. It does not block `notexample.com`.
 * Local names are blocked even when the user list is empty.
 */
export function hostBlocked(hostname: string, blocklist: readonly string[]): boolean {
  const host = canonicalHostname(hostname).replace(/^\[|\]$/g, '');
  if (!host || isLocalHostname(host)) return true;
  return blocklist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}
