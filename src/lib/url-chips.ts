/**
 * URL detection and validation for the chat input's "fetch page" chips.
 *
 * Kept pure and dependency-free so it can be unit tested and shared without pulling in
 * component state.
 */
import { isPotentiallyPublicHostname } from '../../sidecar/web-address-policy.js';

/**
 * Whether a detected string is something the sidecar can actually fetch.
 *
 * A bare regex match happily produces values the fetcher will reject (`javascript:`, `file:`,
 * a trailing bracket, an empty host). Validating before a chip is rendered keeps the UI from
 * offering a fetch that can only fail.
 */
export function isFetchableUrl(value: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== '443') return false;
  // Same local-name and IP-literal rules the isolated helper enforces, so the composer never
  // offers a Fetch it would always refuse. DNS-resolved names are still checked by the helper.
  return isPotentiallyPublicHostname(parsed.hostname);
}

const URL_PATTERN = /https:\/\/[^\s"'<>)]+/g;

/**
 * Extract fetchable URLs from chat input, in first-seen order, excluding ones already queued.
 *
 * A trailing `.` `,` `;` or `:` is stripped because a URL at the end of a sentence otherwise
 * carries the punctuation into the request. `!` and `?` are deliberately left alone — they are
 * legitimate at the end of real URLs (`.../wiki/Hello!`) and stripping them would silently
 * fetch a different page.
 */
export function detectFetchableUrls(text: string, alreadyQueued: Iterable<string> = []): string[] {
  const queued = new Set(alreadyQueued);
  const matches = String(text ?? '').match(URL_PATTERN) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const match of matches) {
    const candidate = match.replace(/[.,;:]+$/, '');
    if (!isFetchableUrl(candidate)) continue;
    if (seen.has(candidate) || queued.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}
