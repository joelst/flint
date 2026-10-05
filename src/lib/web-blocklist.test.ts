import { describe, expect, it } from 'vitest';
import { canonicalBlockHost, hostBlocked, mergeBlocklists, parseBlocklistText } from './web-blocklist';

describe('web blocklist', () => {
  it('blocks a listed host and its subdomains, not a name that merely ends the same way', () => {
    const list = mergeBlocklists(undefined, ['example.com'], []);
    expect(hostBlocked('example.com', list)).toBe(true);
    expect(hostBlocked('sub.example.com', list)).toBe(true);
    expect(hostBlocked('notexample.com', list)).toBe(false);
    expect(hostBlocked('localhost', [])).toBe(true);
    expect(hostBlocked('metadata.google.internal', mergeBlocklists())).toBe(true);
  });

  it('keeps hostnames and lists lines that are paths, ports, or wildcards', () => {
    const parsed = parseBlocklistText('example.com\nhttps://example.com/a\n*.example.com\nexample.com:443\n');
    expect(parsed.hosts).toEqual(['example.com']);
    expect(parsed.rejected).toEqual(['https://example.com/a', '*.example.com', 'example.com:443']);
    expect(mergeBlocklists(['localhost'], parsed.hosts, [])).toEqual(['localhost', 'example.com']);
  });

  it('rejects a host whose labels are not DNS labels', () => {
    const malformed = ['.example.com', 'example..com', '-example.com'];
    for (const entry of malformed) {
      expect(canonicalBlockHost(entry)).toBeNull();
    }
    const parsed = parseBlocklistText(
      '.example.com\nexample..com\n-example.com\nexample.com\nsub.example.com\nnotexample.com\n',
    );
    expect(parsed.rejected).toEqual(malformed);
    expect(parsed.hosts).toEqual(['example.com', 'sub.example.com', 'notexample.com']);
  });
});
