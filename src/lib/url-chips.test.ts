import { describe, it, expect } from 'vitest';
import { decideChipFetchHop, detectFetchableUrls, isFetchableUrl } from './url-chips';

describe('isFetchableUrl', () => {
  it('accepts credential-free HTTPS URLs on the standard port', () => {
    expect(isFetchableUrl('https://example.com/a/b?c=d#e')).toBe(true);
    expect(isFetchableUrl('  https://example.com  ')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not a URL', 'example.com'],
    ['http scheme', 'http://example.com'],
    ['credentials', 'https://user:pass@example.com'],
    ['nonstandard port', 'https://example.com:8443'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['file scheme', 'file:///etc/passwd'],
    ['data scheme', 'data:text/html,<h1>x</h1>'],
    ['ftp scheme', 'ftp://example.com'],
    ['no host', 'http://']
  ])('rejects %s', (_label, value) => {
    expect(isFetchableUrl(value)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isFetchableUrl(undefined as any)).toBe(false);
    expect(isFetchableUrl(null as any)).toBe(false);
    expect(isFetchableUrl(42 as any)).toBe(false);
  });

  it.each([
    'https://localhost/',
    'https://LOCALHOST./',
    'https://app.localhost/',
    'https://printer.local/',
    'https://127.0.0.1/',
    'https://0x7f.1/',
    'https://10.0.0.1/',
    'https://192.168.1.1/',
    'https://169.254.169.254/',
    'https://[::1]/',
    'https://[fe80::1]/',
    'https://[fd00::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[2001:db8::1]/',
  ])('does not offer Fetch for local or special destination %s', (value) => {
    expect(isFetchableUrl(value)).toBe(false);
    expect(detectFetchableUrls(`see ${value}`)).toEqual([]);
  });

  it('still offers public hostnames and public IP literals', () => {
    expect(isFetchableUrl('https://1.1.1.1/')).toBe(true);
    expect(isFetchableUrl('https://[2606:4700:4700::1111]/')).toBe(true);
    expect(isFetchableUrl('https://localhost.example.com/')).toBe(true);
  });

  it('does not offer a chip for a blocklisted host or its subdomain', () => {
    const blocklist = ['example.com'];
    expect(isFetchableUrl('https://example.com/a', blocklist)).toBe(false);
    expect(isFetchableUrl('https://sub.example.com/a', blocklist)).toBe(false);
    expect(isFetchableUrl('https://notexample.com/a', blocklist)).toBe(true);
    expect(detectFetchableUrls('see https://example.com/a and https://other.example/b', [], blocklist))
      .toEqual(['https://other.example/b']);
  });
});

describe('decideChipFetchHop', () => {
  it('refuses a host blocked after the chip was accepted, and a blocked redirect', () => {
    const queued = 'https://news.example/story';
    expect(isFetchableUrl(queued, [])).toBe(true);
    expect(decideChipFetchHop(queued, ['news.example'], 0)).toEqual({
      ok: false,
      error: 'This host is blocked on this device.',
    });
    expect(decideChipFetchHop('https://cdn.example/out', ['cdn.example'], 1)).toEqual({
      ok: false,
      error: 'This host is blocked on this device.',
    });
    expect(decideChipFetchHop('https://other.example/next', ['news.example'], 1)).toEqual({ ok: true });
    expect(decideChipFetchHop('http://other.example/next', [], 1)).toEqual({
      ok: false,
      error: 'Not a fetchable URL: http://other.example/next',
    });
    expect(decideChipFetchHop('https://other.example/next', [], 4)).toEqual({
      ok: false,
      error: 'Too many redirects',
    });
  });
});

describe('detectFetchableUrls', () => {
  it('returns nothing for text without URLs', () => {
    expect(detectFetchableUrls('just some words')).toEqual([]);
    expect(detectFetchableUrls('')).toEqual([]);
    expect(detectFetchableUrls(undefined as any)).toEqual([]);
  });

  it('preserves first-seen order and de-duplicates', () => {
    const text = 'see https://b.example and https://a.example and https://b.example again';
    expect(detectFetchableUrls(text)).toEqual(['https://b.example', 'https://a.example']);
  });

  it('excludes already-queued URLs', () => {
    const text = 'https://a.example https://b.example';
    expect(detectFetchableUrls(text, ['https://a.example'])).toEqual(['https://b.example']);
  });

  it('strips trailing sentence punctuation', () => {
    expect(detectFetchableUrls('read https://example.com/page.')).toEqual([
      'https://example.com/page'
    ]);
    expect(detectFetchableUrls('read https://example.com/page, then go')).toEqual([
      'https://example.com/page'
    ]);
  });

  it('keeps ! and ?, which are legitimate at the end of real URLs', () => {
    expect(detectFetchableUrls('see https://en.wikipedia.org/wiki/Hello!')).toEqual([
      'https://en.wikipedia.org/wiki/Hello!'
    ]);
    expect(detectFetchableUrls('see https://example.com/search?')).toEqual([
      'https://example.com/search?'
    ]);
  });

  it('does not offer schemes the fetcher cannot use', () => {
    expect(detectFetchableUrls(
      'http://example.com javascript:alert(1) file:///etc/passwd',
    )).toEqual([]);
  });

  it('treats a punctuation-stripped duplicate as the same URL', () => {
    expect(detectFetchableUrls('https://example.com/x. and https://example.com/x')).toEqual([
      'https://example.com/x'
    ]);
  });
});
