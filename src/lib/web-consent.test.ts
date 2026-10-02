import { describe, expect, it } from 'vitest';
import {
  domainGranted,
  emptySessionWebConsent,
  emptyStoredWebConsent,
  grantDomain,
  grantSearch,
  hostnameOf,
  readStoredWebConsent,
  rememberResultUrls,
  searchGranted,
  writeStoredWebConsent,
} from './web-consent';

describe('web consent', () => {
  it('asks for search until the user allows the session or forever', () => {
    const stored = emptyStoredWebConsent();
    const session = emptySessionWebConsent();
    expect(searchGranted(stored, session)).toBe(false);
    const once = grantSearch(stored, session, 'once');
    expect(searchGranted(once.stored, once.session)).toBe(false);
    const forSession = grantSearch(stored, session, 'session');
    expect(searchGranted(forSession.stored, forSession.session)).toBe(true);
    expect(forSession.stored.searchForever).toBe(false);
    const forever = grantSearch(stored, session, 'forever');
    expect(searchGranted(forever.stored, emptySessionWebConsent())).toBe(true);
  });

  it('remembers a result domain for once, the session, forever, or every URL', () => {
    const stored = emptyStoredWebConsent();
    const session = emptySessionWebConsent();
    expect(domainGranted(stored, session, 'example.com')).toBe(false);
    const once = grantDomain(stored, session, 'Example.com', 'once');
    expect(domainGranted(once.stored, once.session, 'example.com')).toBe(false);
    const forSession = grantDomain(stored, session, 'Example.com', 'session');
    expect(domainGranted(forSession.stored, forSession.session, 'example.com')).toBe(true);
    expect(domainGranted(forSession.stored, emptySessionWebConsent(), 'example.com')).toBe(false);
    const forever = grantDomain(stored, session, 'Example.com', 'forever');
    expect(domainGranted(forever.stored, emptySessionWebConsent(), 'example.com')).toBe(true);
    const all = grantDomain(stored, session, 'example.com', 'all-urls');
    expect(all.session.allUrls).toBe(true);
    expect(domainGranted(all.stored, all.session, 'other.example')).toBe(true);
    expect(domainGranted(all.stored, emptySessionWebConsent(), 'other.example')).toBe(false);
  });

  it('keeps search-result URLs for this session only', () => {
    const session = rememberResultUrls(emptySessionWebConsent(), ['https://example.com/a']);
    expect([...session.resultUrls]).toEqual(['https://example.com/a']);
    expect(emptySessionWebConsent().resultUrls.size).toBe(0);
  });

  it('round-trips forever approvals and drops malformed storage', () => {
    const saved = writeStoredWebConsent({
      searchForever: true,
      domainsForever: ['b.example', 'a.example'],
    });
    expect(readStoredWebConsent(saved)).toEqual({
      searchForever: true,
      domainsForever: ['a.example', 'b.example'],
    });
    expect(readStoredWebConsent('not json')).toEqual(emptyStoredWebConsent());
    expect(readStoredWebConsent(null)).toEqual(emptyStoredWebConsent());
  });

  it('reads the site name from a public https URL', () => {
    expect(hostnameOf('https://Example.com/path')).toBe('example.com');
    expect(hostnameOf('https://user:pass@example.com/')).toBeNull();
    expect(hostnameOf('http://example.com/')).toBeNull();
  });
});
