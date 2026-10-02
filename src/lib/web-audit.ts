import { isPotentiallyPublicHostname } from '../../sidecar/web-address-policy.js';

/**
 * The app-controlled record of what a web tool round sent off the device.
 *
 * It is stored beside the assistant message rather than inside its Markdown: model output is
 * untrusted, and an unclosed comment, fence, or block in that text would otherwise swallow or
 * restyle an audit parsed from the same string.
 */
export interface WebAuditSource {
  title: string;
  url: string;
  truncated?: boolean;
}

export interface WebAudit {
  sources: WebAuditSource[];
  errors: string[];
}

export function isAuditableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    // Mirror the helper's network rule so a hand-edited archive cannot show other URL shapes
    // or a trusted-looking link to a local or private destination the helper always refuses.
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && isPotentiallyPublicHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/** Deduplicate by URL (keeping any truncation) without mutating the caller's sources. */
export function buildWebAudit(
  sources: readonly WebAuditSource[],
  errors: readonly string[],
): WebAudit | undefined {
  const unique: WebAuditSource[] = [];
  const indexes = new Map<string, number>();
  for (const source of sources) {
    if (!isAuditableUrl(source?.url)) continue;
    const existing = indexes.get(source.url);
    if (existing !== undefined) {
      if (source.truncated) unique[existing].truncated = true;
      continue;
    }
    indexes.set(source.url, unique.length);
    const entry: WebAuditSource = { title: String(source.title || source.url), url: source.url };
    if (source.truncated) entry.truncated = true;
    unique.push(entry);
  }
  const issues = errors.filter((error) => typeof error === 'string' && error.length > 0);
  if (unique.length === 0 && issues.length === 0) return undefined;
  return { sources: unique, errors: [...issues] };
}

/**
 * Validate a stored audit. Returns `undefined` for anything this schema would not have written,
 * so a hand-edited archive cannot smuggle a non-https link into the app-controlled section.
 * A valid audit is returned as stored, so fields a newer build added survive a save.
 */
export function normalizeWebAudit(raw: unknown): WebAudit | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { sources, errors } = raw as Record<string, unknown>;
  if (!Array.isArray(sources) || !Array.isArray(errors)) return undefined;
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
    const { title, url, truncated } = source as Record<string, unknown>;
    if (typeof title !== 'string' || !isAuditableUrl(url)) return undefined;
    if (truncated !== undefined && typeof truncated !== 'boolean') return undefined;
  }
  if (!errors.every((error) => typeof error === 'string')) return undefined;
  if (sources.length === 0 && errors.length === 0) return undefined;
  return raw as WebAudit;
}

function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
}

export function webAuditSourceLabel(source: WebAuditSource): string {
  return `${singleLine(source.title || source.url) || source.url}${source.truncated ? ' (truncated)' : ''}`;
}

export function webAuditErrorLabel(error: string): string {
  return singleLine(error);
}

/** Plain-text form for clipboard copy. */
export function messageClipboardWithWebAudit(text: string, audit: WebAudit | undefined): string {
  const auditText = webAuditPlainText(audit);
  if (!auditText) return text;
  return text.trim() ? `${text.trimEnd()}\n\n${auditText}` : auditText;
}

export function webAuditPlainText(audit: WebAudit | undefined): string {
  if (!audit) return '';
  const sections: string[] = [];
  if (audit.sources.length > 0) {
    sections.push(
      `Sources consulted:\n${audit.sources.map((s) => `- ${webAuditSourceLabel(s)}: ${s.url}`).join('\n')}`,
    );
  }
  if (audit.errors.length > 0) {
    sections.push(`Web tool issues:\n${audit.errors.map((e) => `- ${webAuditErrorLabel(e)}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
