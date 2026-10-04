import { isPotentiallyPublicHostname } from '../../sidecar/web-address-policy.js';
import { sanitizeWebLabel } from './web-envelope';

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
  budgetShortened?: boolean;
}

export interface WebAudit {
  sources: WebAuditSource[];
  errors: string[];
  queries?: string[];
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
  queries: readonly string[] = [],
): WebAudit | undefined {
  const unique: WebAuditSource[] = [];
  const indexes = new Map<string, number>();
  for (const source of sources) {
    if (!isAuditableUrl(source?.url)) continue;
    const existing = indexes.get(source.url);
    if (existing !== undefined) {
      if (source.truncated) unique[existing].truncated = true;
      if (source.budgetShortened) unique[existing].budgetShortened = true;
      continue;
    }
    indexes.set(source.url, unique.length);
    const entry: WebAuditSource = { title: String(source.title || source.url), url: source.url };
    if (source.truncated) entry.truncated = true;
    if (source.budgetShortened) entry.budgetShortened = true;
    unique.push(entry);
  }
  const issues = errors.filter((error) => typeof error === 'string' && error.length > 0);
  const searched = queries
    .filter((query) => typeof query === 'string' && query.trim().length > 0)
    .map((query) => singleLine(query).slice(0, 200))
    .filter((query) => query.length > 0);
  if (unique.length === 0 && issues.length === 0 && searched.length === 0) return undefined;
  return {
    sources: unique,
    errors: [...issues],
    ...(searched.length > 0 ? { queries: searched } : {}),
  };
}

/**
 * Validate a stored audit. Returns `undefined` for anything this schema would not have written,
 * so a hand-edited archive cannot smuggle a non-https link into the app-controlled section.
 * A valid audit is returned as stored, so fields a newer build added survive a save.
 */
export function normalizeWebAudit(raw: unknown): WebAudit | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const { sources, errors, queries } = record;
  if (!Array.isArray(sources) || !Array.isArray(errors)) return undefined;
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
    const { title, url, truncated, budgetShortened } = source as Record<string, unknown>;
    if (typeof title !== 'string' || !isAuditableUrl(url)) return undefined;
    if (truncated !== undefined && typeof truncated !== 'boolean') return undefined;
    if (budgetShortened !== undefined && typeof budgetShortened !== 'boolean') return undefined;
  }
  if (!errors.every((error) => typeof error === 'string')) return undefined;
  if (queries !== undefined) {
    if (!Array.isArray(queries) || queries.some((query) => typeof query !== 'string')) return undefined;
  }
  if (sources.length === 0 && errors.length === 0 && !(Array.isArray(queries) && queries.length > 0)) {
    return undefined;
  }
  return raw as WebAudit;
}

function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
}

/** Page text that can be shown to the model. Whitespace alone is not readable. */
export function chipTextIsReadable(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0;
}

export interface UrlChipRetrieval {
  url: string;
  status: string;
  finalUrl?: string;
  title?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
}

/**
 * Finished URL-chip outcomes for the answer's audit.
 *
 * A page with readable text is a source. A finished fetch that failed, or that returned no
 * readable text, is a tool issue: send clears the chips, so this is the only remaining record.
 * A dismissed chip was never fetched. A chip still loading is not part of this send.
 */
export function urlChipRetrievalAudit(chips: readonly UrlChipRetrieval[]): {
  sources: WebAuditSource[];
  errors: string[];
} {
  const sources: WebAuditSource[] = [];
  const errors: string[] = [];
  for (const chip of chips) {
    if (!chip || typeof chip.url !== 'string' || !chip.url) continue;
    if (chip.status === 'done' && chipTextIsReadable(chip.text)) {
      const source: WebAuditSource = {
        title: chip.title || chip.finalUrl || chip.url,
        url: chip.finalUrl || chip.url,
      };
      if (chip.truncated) source.truncated = true;
      sources.push(source);
      continue;
    }
    if (chip.status === 'done') {
      const url = singleLine(chip.finalUrl || chip.url) || chip.url;
      errors.push(`web_fetch: ${url}: The page contained no readable text`);
      continue;
    }
    if (chip.status === 'error' && !String(chip.error ?? '').includes('dismissed')) {
      const url = singleLine(chip.url) || chip.url;
      const detail = singleLine(chip.error || 'The page could not be fetched').slice(0, 500)
        || 'The page could not be fetched';
      errors.push(`web_fetch: ${url}: ${detail}`);
    }
  }
  return { sources, errors };
}

/**
 * Flint-written index for a later send. Titles and URLs only: no page body and no tool errors.
 * This is metadata. It does not count as web text for a later search confirmation.
 */
export function webSourceIndex(messages: readonly { role?: unknown; webAudit?: unknown }[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue;
    const audit = normalizeWebAudit(message.webAudit);
    if (!audit) continue;
    for (const source of audit.sources) {
      const flags = [
        source.truncated ? 'truncated' : '',
        source.budgetShortened ? 'shortened to fit context' : '',
      ].filter(Boolean).join(', ');
      const title = sanitizeWebLabel(source.title || source.url);
      const url = sanitizeWebLabel(source.url, 2_048);
      lines.push(`- ${title} ${url}${flags ? ` (${flags})` : ''}`);
    }
  }
  if (lines.length === 0) return '';
  return [
    'Earlier public pages in this conversation are not included below.',
    'The body is not in this request. Asking to fetch one again runs consent unless that host is already granted.',
    ...lines.slice(0, 24),
  ].join('\n');
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
  if (audit.queries && audit.queries.length > 0) {
    sections.push(`Searched for:\n${audit.queries.map((query) => `- ${singleLine(query)}`).join('\n')}`);
  }
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
