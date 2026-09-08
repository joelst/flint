import { describe, it, expect } from 'vitest';
import { isFetchableUrl, detectFetchableUrls } from './url-chips';

describe('isFetchableUrl', () => {
  it('accepts http and https URLs with a host', () => {
    expect(isFetchableUrl('http://example.com')).toBe(true);
    expect(isFetchableUrl('https://example.com/a/b?c=d#e')).toBe(true);
    expect(isFetchableUrl('  https://example.com  ')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not a URL', 'example.com'],
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
    expect(detectFetchableUrls('javascript:alert(1) file:///etc/passwd')).toEqual([]);
  });

  it('treats a punctuation-stripped duplicate as the same URL', () => {
    expect(detectFetchableUrls('https://example.com/x. and https://example.com/x')).toEqual([
      'https://example.com/x'
    ]);
  });
});
