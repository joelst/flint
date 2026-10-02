/**
 * Who may send a search, and which sites from those results may be opened.
 *
 * "Once" covers the request in front of the user and is not stored.
 * "Session" lasts until the page is reloaded. "Forever" is the only choice written to storage.
 * "All URLs" allows every later public URL in the conversation that approved it,
 * until the page reloads. It is not stored and does not apply to other conversations.
 * Search-result URLs are remembered only for the conversation that produced them,
 * and only until the page reloads.
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
  allUrlsByConversation: ReadonlySet<string>;
  resultUrlsByConversation: ReadonlyMap<string, ReadonlySet<string>>;
}

export function emptyStoredWebConsent(): StoredWebConsent {
  return { searchForever: false, domainsForever: [] };
}

const NO_RESULT_URLS: ReadonlySet<string> = new Set();

export function emptySessionWebConsent(): SessionWebConsent {
  return {
    search: false,
    domains: new Set(),
    allUrlsByConversation: new Set(),
    resultUrlsByConversation: new Map(),
  };
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

export function allUrlsGranted(session: SessionWebConsent, conversationId: string): boolean {
  return conversationId.length > 0 && session.allUrlsByConversation.has(conversationId);
}

export interface AllUrlsGrantTarget {
  id: string;
  label: string;
  /** The grant is for a conversation other than the one on screen. */
  background: boolean;
}

function collapseConsentLabel(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The conversation an Allow all URLs choice would cover.
 * An empty id cannot be granted, so the prompt must not offer that choice.
 * A background chat with the same title as the open one keeps its id in the label.
 */
export function allUrlsGrantTarget(
  conversationId: string,
  title: string | null | undefined,
  visibleConversationId?: string | null,
  visibleTitle?: string | null,
): AllUrlsGrantTarget | null {
  const id = collapseConsentLabel(conversationId);
  if (!id) return null;
  const named = collapseConsentLabel(title);
  const visibleId = collapseConsentLabel(visibleConversationId);
  const background = visibleId !== id;
  const sameTitle = named !== '' && named === collapseConsentLabel(visibleTitle);
  const label = named
    ? (background && sameTitle ? `${named} (${id})` : named)
    : id;
  return { id, label, background };
}

export function domainGranted(
  stored: StoredWebConsent,
  session: SessionWebConsent,
  host: string,
  conversationId = '',
): boolean {
  const name = host.toLowerCase();
  return allUrlsGranted(session, conversationId)
    || stored.domainsForever.includes(name)
    || session.domains.has(name);
}

export type ConsentQueuePrompt =
  | { kind: 'search' }
  | { kind: 'domain'; host: string; conversationId: string };

/** Leading queue entries a session, forever, or conversation all-URL grant already covers. */
export function splitCoveredConsentPrompts<T extends ConsentQueuePrompt>(
  stored: StoredWebConsent,
  session: SessionWebConsent,
  queue: readonly T[],
): { covered: T[]; remaining: T[] } {
  let index = 0;
  while (index < queue.length && consentPromptCovered(stored, session, queue[index])) index += 1;
  return { covered: queue.slice(0, index), remaining: queue.slice(index) };
}

function consentPromptCovered(
  stored: StoredWebConsent,
  session: SessionWebConsent,
  prompt: ConsentQueuePrompt,
): boolean {
  if (prompt.kind === 'search') return searchGranted(stored, session);
  return domainGranted(stored, session, prompt.host, prompt.conversationId);
}

export function grantDomain(
  stored: StoredWebConsent,
  session: SessionWebConsent,
  host: string,
  choice: DomainChoice,
  conversationId = '',
): { stored: StoredWebConsent; session: SessionWebConsent } {
  const name = host.toLowerCase();
  if (choice === 'all-urls') {
    if (!conversationId) return { stored, session };
    const allUrlsByConversation = new Set(session.allUrlsByConversation);
    allUrlsByConversation.add(conversationId);
    return { stored, session: { ...session, allUrlsByConversation } };
  }
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
  conversationId: string,
  urls: Iterable<string>,
): SessionWebConsent {
  if (!conversationId) return session;
  const resultUrlsByConversation = new Map(session.resultUrlsByConversation);
  const next = new Set(resultUrlsByConversation.get(conversationId) ?? []);
  for (const url of urls) next.add(url);
  resultUrlsByConversation.set(conversationId, next);
  return { ...session, resultUrlsByConversation };
}

export function resultUrlsForConversation(
  session: SessionWebConsent,
  conversationId: string,
): ReadonlySet<string> {
  return session.resultUrlsByConversation.get(conversationId) ?? NO_RESULT_URLS;
}

export function loadStoredWebConsent(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): StoredWebConsent {
  if (!storage) return emptyStoredWebConsent();
  try {
    return readStoredWebConsent(storage.getItem(WEB_CONSENT_STORAGE_KEY));
  } catch {
    return emptyStoredWebConsent();
  }
}

export function saveStoredWebConsent(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  stored: StoredWebConsent,
): void {
  if (!storage) return;
  try {
    storage.setItem(WEB_CONSENT_STORAGE_KEY, writeStoredWebConsent(stored));
  } catch {
    // A locked-down webview throws SecurityError. The in-memory grant still applies.
  }
}
