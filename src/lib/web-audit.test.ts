import { describe, expect, it } from 'vitest';
import {
  buildWebAudit,
  isAuditableUrl,
  messageClipboardWithWebAudit,
  normalizeWebAudit,
  webAuditErrorLabel,
  webAuditPlainText,
  webAuditSourceLabel,
} from './web-audit';

describe('web audit', () => {
  it('deduplicates by URL, merges truncation, and does not mutate input', () => {
    const sources = [
      { title: 'Page', url: 'https://example.com/' },
      { title: 'Duplicate', url: 'https://example.com/', truncated: true },
      { title: '', url: 'https://example.org/' },
    ];
    const audit = buildWebAudit(sources, ['web_fetch: failed']);
    expect(audit).toEqual({
      sources: [
        { title: 'Page', url: 'https://example.com/', truncated: true },
        { title: 'https://example.org/', url: 'https://example.org/' },
      ],
      errors: ['web_fetch: failed'],
    });
    expect(sources[0]).toEqual({ title: 'Page', url: 'https://example.com/' });
  });

  it('builds nothing when no request left the device and no error occurred', () => {
    expect(buildWebAudit([], [])).toBeUndefined();
    expect(buildWebAudit([], [''])).toBeUndefined();
  });

  it('never carries a non-https link into the app-controlled section', () => {
    expect(buildWebAudit([
      { title: 'x', url: 'javascript:alert(1)' },
      { title: 'y', url: 'http://example.com/' },
      { title: 'z', url: 'not a url' },
    ], [])).toBeUndefined();
    expect(isAuditableUrl('https://example.com/')).toBe(true);
    expect(isAuditableUrl('https://example.com:443/')).toBe(true);
    expect(isAuditableUrl('https://u:p@example.com/')).toBe(false);
    expect(isAuditableUrl('https://example.com:8443/')).toBe(false);
    expect(isAuditableUrl(42)).toBe(false);
    expect(isAuditableUrl('')).toBe(false);
  });

  it('is independent of model Markdown that would hide an appended audit', () => {
    const audit = buildWebAudit([{ title: 'Source', url: 'https://example.com/' }], []);
    const text = messageClipboardWithWebAudit('Answer <!-- ``` <details>', audit);
    expect(text).toBe('Answer <!-- ``` <details>\n\nSources consulted:\n- Source: https://example.com/');
    expect(messageClipboardWithWebAudit('', audit)).toBe(
      'Sources consulted:\n- Source: https://example.com/',
    );
    expect(messageClipboardWithWebAudit('Answer', undefined)).toBe('Answer');
  });

  it('formats labels on one line and marks truncation', () => {
    expect(webAuditSourceLabel({ title: 'A\n\tB', url: 'https://e.com/', truncated: true }))
      .toBe('A B (truncated)');
    expect(webAuditSourceLabel({ title: '  ', url: 'https://e.com/' })).toBe('https://e.com/');
    expect(webAuditErrorLabel('web_fetch:\nbad\u0000x')).toBe('web_fetch: bad x');
    expect(webAuditPlainText(undefined)).toBe('');
    expect(webAuditPlainText({ sources: [], errors: ['oops'] })).toBe('Web tool issues:\n- oops');
  });

  it('accepts a stored audit unchanged and rejects anything this schema would not write', () => {
    const stored = { sources: [{ title: 'T', url: 'https://e.com/', truncated: false }], errors: ['e'], future: 1 };
    expect(normalizeWebAudit(stored)).toBe(stored);
    for (const bad of [
      null,
      [],
      'x',
      { sources: [], errors: [] },
      { sources: {}, errors: [] },
      { sources: [], errors: [1] },
      { sources: [null], errors: [] },
      { sources: [[]], errors: [] },
      { sources: [{ title: 1, url: 'https://e.com/' }], errors: [] },
      { sources: [{ title: 'T', url: 'javascript:alert(1)' }], errors: [] },
      { sources: [{ title: 'T', url: 'https://e.com/', truncated: 'yes' }], errors: [] },
    ]) {
      expect(normalizeWebAudit(bad)).toBeUndefined();
    }
  });
});
