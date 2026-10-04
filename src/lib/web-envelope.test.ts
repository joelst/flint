import { describe, expect, it } from 'vitest';
import {
  FENCE_FRAMING_CHARS,
  FENCED_FETCH_CHARS,
  FENCED_SEARCH_CHARS,
  MAX_FENCED_RESULT_CHARS,
  buildWebEnvelope,
  createWebCloser,
  localRetrievalDate,
  shortenWebEnvelopes,
  stripWebCloser,
  webCloserInstruction,
} from './web-envelope';

describe('web envelope', () => {
  it('pins the fenced size from the fetch body, not the smaller search block', () => {
    expect(FENCE_FRAMING_CHARS).toBe(2276);
    expect(FENCED_FETCH_CHARS).toBe(22276);
    expect(FENCED_SEARCH_CHARS).toBe(19016);
    expect(MAX_FENCED_RESULT_CHARS).toBe(22276);
  });

  it('wraps a page with a Flint line, a local date, and a case-insensitive closer', () => {
    const closer = createWebCloser(new Uint8Array([0xab, 0xcd, 0xef, 0x01, 0x23, 0x45]));
    expect(closer).toBe('flint-ref-abcdef012345');
    const body = `Keep ${closer.toUpperCase()} out`;
    const envelope = buildWebEnvelope({
      closer,
      title: 'A\nTitle',
      url: 'https://example.com/a',
      retrievedOn: '2026-10-03',
      body,
      truncated: true,
    });
    expect(envelope).toContain('Title: A Title.');
    expect(envelope).toContain('URL: https://example.com/a.');
    expect(envelope).toContain('retrieved 2026-10-03.');
    expect(envelope).toContain('Flint notice: the page content above is a truncated prefix.');
    expect(envelope.startsWith('Reference data retrieved by Flint.')).toBe(true);
    expect(envelope).toContain(`\n${closer}\nKeep  out\n${closer}`);
    expect(envelope.toLowerCase().split(closer).length - 1).toBe(2);
    expect(stripWebCloser(`x ${closer.toUpperCase()} y`, closer)).toBe('x  y');
    expect(webCloserInstruction(closer)).toContain(closer);
    expect(localRetrievalDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('shortens each fenced body without collapsing a second page into the first', () => {
    const closer = 'flint-ref-abcdef012345';
    const first = buildWebEnvelope({
      closer,
      title: 'One',
      url: 'https://example.com/one',
      retrievedOn: '2026-10-03',
      body: 'alpha '.repeat(40),
    });
    const second = buildWebEnvelope({
      closer,
      title: 'Two',
      url: 'https://example.com/two',
      retrievedOn: '2026-10-03',
      body: 'beta '.repeat(40),
    });
    const cut = shortenWebEnvelopes(`${first}\n\n${second}`, closer, 24);
    expect(cut.shortened).toBe(true);
    expect(cut.text).toContain('Title: One.');
    expect(cut.text).toContain('Title: Two.');
    expect(cut.text).toContain('https://example.com/two');
    expect(cut.text.match(/flint-ref-abcdef012345/g)).toHaveLength(4);
  });
});
