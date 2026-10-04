import { describe, expect, it } from 'vitest';
import {
  buildWebAudit,
  chipTextIsReadable,
  isAuditableUrl,
  messageClipboardWithWebAudit,
  normalizeWebAudit,
  urlChipRetrievalAudit,
  webAuditErrorLabel,
  webAuditPlainText,
  webAuditSourceLabel,
  webSourceIndex,
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
    for (const local of [
      'https://localhost/',
      'https://api.localhost./',
      'https://printer.local/',
      'https://127.0.0.1/',
      'https://10.0.0.5/',
      'https://192.168.1.1/',
      'https://[::1]/',
      'https://[fd00::1]/',
      'https://[3ffe::1]/',
      'https://2130706433/',
    ]) {
      expect(isAuditableUrl(local), local).toBe(false);
    }
    expect(isAuditableUrl('https://93.184.216.34/')).toBe(true);
    expect(isAuditableUrl('https://[2606:4700:4700::1111]/')).toBe(true);
    expect(normalizeWebAudit({ sources: [{ title: 'x', url: 'https://localhost/' }], errors: [] }))
      .toBeUndefined();
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

  it('keeps failed and empty URL-chip fetches and drops chips that never finished', () => {
    expect(chipTextIsReadable('  hello ')).toBe(true);
    expect(chipTextIsReadable('   ')).toBe(false);
    expect(chipTextIsReadable(undefined)).toBe(false);
    const audit = urlChipRetrievalAudit([
      { url: 'https://example.com/page', status: 'done', title: 'Page', text: 'Hello', truncated: true },
      { url: 'https://example.com/empty', status: 'done', finalUrl: 'https://example.com/empty/', text: ' \n ' },
      { url: 'https://example.com/fail', status: 'error', error: 'timed\nout' },
      { url: 'https://example.com/hide', status: 'error', error: 'dismissed' },
      { url: 'https://example.com/wait', status: 'fetching' },
      { url: 'https://example.com/queue', status: 'pending' },
    ]);
    expect(audit.sources).toEqual([
      { title: 'Page', url: 'https://example.com/page', truncated: true },
    ]);
    expect(audit.errors).toEqual([
      'web_fetch: https://example.com/empty/: The page contained no readable text',
      'web_fetch: https://example.com/fail: timed out',
    ]);
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
      { sources: [{ title: 'T', url: 'https://e.com/', budgetShortened: 'yes' }], errors: [] },
      { sources: [], errors: [], queries: [1] },
    ]) {
      expect(normalizeWebAudit(bad)).toBeUndefined();
    }
  });

  it('keeps searched queries and ORs a shortened flag onto a duplicate URL', () => {
    expect(buildWebAudit([], [], [' public\nweather '])).toEqual({
      sources: [],
      errors: [],
      queries: ['public weather'],
    });
    const audit = buildWebAudit([
      { title: 'Page', url: 'https://example.com/' },
      { title: 'Page', url: 'https://example.com/', budgetShortened: true },
    ], []);
    expect(audit?.sources).toEqual([
      { title: 'Page', url: 'https://example.com/', budgetShortened: true },
    ]);
    expect(webAuditPlainText(buildWebAudit([], [], ['public weather']))).toContain('Searched for:\n- public weather');
  });

  it('indexes earlier pages without their body or tool errors', () => {
    const index = webSourceIndex([
      { role: 'user', webAudit: { sources: [{ title: 'Hidden', url: 'https://hidden.example/' }], errors: [] } },
      {
        role: 'assistant',
        webAudit: {
          sources: [{ title: 'Page\nA', url: 'https://example.com/', truncated: true, budgetShortened: true }],
          errors: ['web_fetch: secret failure'],
          queries: ['secret query'],
        },
      },
    ]);
    expect(index).toContain('The body is not in this request.');
    expect(index).toContain('Page A https://example.com/ (truncated, shortened to fit context)');
    expect(index).not.toContain('secret failure');
    expect(index).not.toContain('secret query');
    expect(index).not.toContain('Hidden');
    expect(webSourceIndex([])).toBe('');
  });
});
