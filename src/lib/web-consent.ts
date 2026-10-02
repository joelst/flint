/**
 * Who may send a search, and which sites from those results may be opened.
 *
 * "Once" covers the request in front of the user and is not stored.
 * "Session" lasts until the page is reloaded. "Forever" is the only choice written to storage.
 * "All URLs" allows every later public URL for this session, not after a restart.
 */

export const WEB_CONSENT_STORAGE_KEY = 'flint-web-consent';

export type SearchChoice = 'once' | 'session' | 'forever';
export type DomainChoice = 'once' | 'session' | 'forever' | 'all-urls';

export interface StoredWebConsent {
  searchForever: boolean;
  domainsForever: string[];
}

export interface SessionWebConsent {
  search: boolean;
  domains: Set<string>;
  allUrls: boolean;
  resultUrls: Set<string>;
}

export function emptyStoredWebConsent(): StoredWebConsent {
  return { searchForever: false, domainsForever: [] };
}

export function emptySessionWebConsent(): SessionWebConsent {
  return { search: false, domains: new Set(), allUrls: false, resultUrls: new Set() };
}

export function hostnameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export function readStoredWebConsent(raw: string | null): StoredWebConsent {
  if (!raw) return emptyStoredWebConsent();
  try {
    const parsed = JSON.parse(raw) as { searchForever?: unknown; domainsForever?: unknown };
    const domains = Array.isArray(parsed.domainsForever)
      ? parsed.domainsForever.filter((host): host is string => typeof host === 'string' && host.length > 0)
      : [];
    return {
      searchForever: parsed.searchForever === true,
      domainsForever: [...new Set(domains.map((host) => host.toLowerCase()))],
    };
  } catch {
    return emptyStoredWebConsent();
  }
}

export function writeStoredWebConsent(stored: StoredWebConsent): string {
  return JSON.stringify({
    searchForever: stored.searchForever,
    domainsForever: [...stored.domainsForever].sort(),
  });
}

export function searchGranted(stored: StoredWebConsent, session: SessionWebConsent): boolean {
  return stored.searchForever || session.search;
}

export function grantSearch(
  stored: StoredWebConsent,
  session: SessionWebConsent,
  choice: SearchChoice,
): { stored: StoredWebConsent; session: SessionWebConsent } {
  if (choice === 'forever') return { stored: { ...stored, searchForever: true }, session };
  if (choice === 'session') return { stored, session: { ...session, search: true } };
  return { stored, session };
}

export function domainGranted(
  stored: StoredWebConsent,
  session: SessionWebConsent,
  host: string,
): boolean {
  const name = host.toLowerCase();
  return session.allUrls || stored.domainsForever.includes(name) || session.domains.has(name);
}

export function grantDomain(
  stored: StoredWebConsent,
  session: SessionWebConsent,
  host: string,
  choice: DomainChoice,
): { stored: StoredWebConsent; session: SessionWebConsent } {
  const name = host.toLowerCase();
  if (choice === 'all-urls') return { stored, session: { ...session, allUrls: true } };
  if (choice === 'forever') {
    return {
      stored: {
        ...stored,
        domainsForever: [...new Set([...stored.domainsForever, name])],
      },
      session,
    };
  }
  if (choice === 'session') {
    const domains = new Set(session.domains);
    domains.add(name);
    return { stored, session: { ...session, domains } };
  }
  return { stored, session };
}

export function rememberResultUrls(
  session: SessionWebConsent,
  urls: Iterable<string>,
): SessionWebConsent {
  const resultUrls = new Set(session.resultUrls);
  for (const url of urls) resultUrls.add(url);
  return { ...session, resultUrls };
}
