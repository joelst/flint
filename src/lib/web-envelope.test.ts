import { describe, expect, it } from 'vitest';
import { DEFAULT_OMITTED_IMAGE_PLACEHOLDER } from './chat-request';
import {
  CLOSER_HEX_CHARS,
  CLOSER_PREFIX,
  FENCE_FRAMING_CHARS,
  SHORTENED_FENCE_MARKER,
  FENCED_FETCH_CHARS,
  IMAGE_LABEL_CHARS,
  FENCED_SEARCH_CHARS,
  FETCH_BODY_CHARS,
  MAX_FENCED_RESULT_CHARS,
  SEARCH_RESULT_COUNT,
  SEARCH_SNIPPET_CHARS,
  SEARCH_TITLE_CHARS,
  SEARCH_URL_CHARS,
  buildWebEnvelope,
  createWebCloser,
  localRetrievalDate,
  messageContentWithFence,
  shortenWebEnvelope,
  shortenWebEnvelopes,
  stripWebCloser,
  toolContentsWithCloser,
  webCloserInstruction,
  withVisionImage,
} from './web-envelope';
import { userSearchContext } from './web-tools';

describe('web envelope', () => {
  it('pins fence framing to a worst-case envelope', () => {
    const closer = `${CLOSER_PREFIX}${'0'.repeat(CLOSER_HEX_CHARS)}`;
    const envelope = buildWebEnvelope({
      closer,
      title: 'T'.repeat(120),
      url: 'u'.repeat(SEARCH_URL_CHARS),
      retrievedOn: '2026-10-05',
      body: '',
      truncated: true,
      shortened: true,
    });
    expect(envelope.length).toBeGreaterThan(2276);
    expect(FENCE_FRAMING_CHARS).toBe(envelope.length + SHORTENED_FENCE_MARKER.length);
    expect(FENCED_FETCH_CHARS).toBe(FETCH_BODY_CHARS + FENCE_FRAMING_CHARS + IMAGE_LABEL_CHARS);
    expect(MAX_FENCED_RESULT_CHARS).toBe(Math.max(FENCED_FETCH_CHARS, FENCED_SEARCH_CHARS));
  });

  it('counts the query line and headings in the search reserve', () => {
    const worst = userSearchContext({
      operation: 'search',
      query: 'q'.repeat(200),
      results: Array.from({ length: SEARCH_RESULT_COUNT }, () => ({
        title: 't'.repeat(SEARCH_TITLE_CHARS),
        url: 'u'.repeat(SEARCH_URL_CHARS),
        snippet: 's'.repeat(SEARCH_SNIPPET_CHARS),
      })),
    });
    expect(FENCED_SEARCH_CHARS).toBe(worst.context.length + FENCE_FRAMING_CHARS);
  });

  it('keeps a shortened worst-case page inside the framing reserve', () => {
    const closer = `${CLOSER_PREFIX}${'0'.repeat(CLOSER_HEX_CHARS)}`;
    const maxChars = 80;
    const envelope = buildWebEnvelope({
      closer,
      title: 'T'.repeat(120),
      url: 'u'.repeat(SEARCH_URL_CHARS),
      retrievedOn: '2026-10-05',
      body: 'x'.repeat(maxChars + 25),
      truncated: true,
      shortened: true,
    });
    const cut = shortenWebEnvelope(envelope, closer, maxChars);
    expect(cut.shortened).toBe(true);
    expect(cut.text).toContain('x'.repeat(maxChars));
    expect(cut.text.length).toBeLessThanOrEqual(maxChars + FENCE_FRAMING_CHARS);
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

  it('shortens a single envelope whose closer is the end of the text', () => {
    const closer = 'flint-ref-abcdef012345';
    const envelope = buildWebEnvelope({
      closer,
      title: 'Only',
      url: 'https://example.com/only',
      retrievedOn: '2026-10-03',
      body: 'alpha '.repeat(40),
    });
    expect(envelope.endsWith(closer)).toBe(true);
    const cut = shortenWebEnvelopes(envelope, closer, 24);
    expect(cut.shortened).toBe(true);
    expect(cut.text).toContain('Title: Only.');
    expect(cut.text).toContain('https://example.com/only');
    expect(cut.text).toContain('[shortened to fit context]');
    expect(cut.text.match(/flint-ref-abcdef012345/g)).toHaveLength(2);
  });

  it('copies a fence onto string content and text parts without touching other parts', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aa' } };
    const content = [{ type: 'text', text: 'question' }, image];
    const fenced = messageContentWithFence(content, 'fenced question');
    expect(fenced).not.toBe(content);
    expect(fenced).toEqual([
      { type: 'text', text: 'fenced question' },
      image,
    ]);
    expect(content[0]).toEqual({ type: 'text', text: 'question' });
    expect(messageContentWithFence('question', 'fenced question')).toBe('fenced question');
    expect(messageContentWithFence(null, 'fenced question')).toBeNull();
  });

  it('leaves text unchanged when there is no closer to shorten', () => {
    const closer = 'flint-ref-abcdef012345';
    expect(stripWebCloser('keep', '')).toBe('keep');
    expect(shortenWebEnvelopes('plain', closer, 24)).toEqual({ text: 'plain', shortened: false });
    expect(shortenWebEnvelopes(`mentions ${closer} inline`, closer, 24)).toEqual({
      text: `mentions ${closer} inline`,
      shortened: false,
    });
    const trailing = `header\n${closer}\nbody\n${closer} trailing`;
    expect(shortenWebEnvelopes(trailing, closer, 1)).toEqual({ text: trailing, shortened: false });
    expect(shortenWebEnvelope('no fence', closer, 1)).toEqual({ text: 'no fence', shortened: false });
    expect(shortenWebEnvelope(trailing, closer, 1)).toEqual({ text: trailing, shortened: false });
  });

  it('joins tool envelopes that contain the closer and skips other roles', () => {
    const closer = 'flint-ref-abcdef012345';
    const first = `${closer}\nshort page\n${closer}`;
    const second = `${closer}\nsecond\n${closer}`;
    expect(toolContentsWithCloser([
      { role: 'user', content: `${closer}\nuser fence\n${closer}` },
      { role: 'tool', content: first },
      { role: 'tool', content: 'no fence here' },
      { role: 'tool', content: [{ type: 'text', text: closer }] },
      { role: 'assistant', content: `${closer}\nnot a tool\n${closer}` },
      { role: 'tool', content: second },
    ], closer)).toBe(`${first}\n\n${second}`);
    expect(toolContentsWithCloser([{ role: 'tool', content: first }], '')).toBe('');
  });

  it('keeps the page JPEG as the only image and the fence on the latest user text', () => {
    const historyImage = { type: 'image_url', image_url: { url: 'data:image/png;base64,HISTORY' } };
    const currentImage = { type: 'image_url', image_url: { url: 'data:image/png;base64,CURRENT' } };
    const jpeg = 'data:image/jpeg;base64,PAGEJPEG';
    const fence = 'flint-ref-abcdef012345\npage title\nflint-ref-abcdef012345';
    const messages = [
      { role: 'user', content: [historyImage] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'older question' },
          { type: 'file_text', file: { text: 'notes' } },
          historyImage,
        ],
      },
      { role: 'assistant', content: 'older answer' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'current question' },
          currentImage,
        ],
      },
    ];
    const result = withVisionImage(messages, fence, jpeg);
    const images = result.flatMap((message) => (
      Array.isArray(message.content)
        ? message.content.filter((part) => (
          part && typeof part === 'object' && (part as { type?: unknown }).type === 'image_url'
        ))
        : []
    ));
    expect(images).toEqual([{ type: 'image_url', image_url: { url: jpeg } }]);
    const latest = result[result.length - 1];
    const latestText = Array.isArray(latest.content)
      ? (latest.content.find((part) => (
        part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
      )) as { text?: unknown } | undefined)?.text
      : latest.content;
    expect(latestText).toBe(`current question\n\n${fence}`);
    expect(result.some((message) => message.content && Array.isArray(message.content) && message.content.length === 0)).toBe(false);
    expect(result[0].content).toEqual([{ type: 'text', text: DEFAULT_OMITTED_IMAGE_PLACEHOLDER }]);
    expect(result[1].content).toEqual([
      { type: 'text', text: 'older question' },
      { type: 'file_text', file: { text: 'notes' } },
    ]);
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'older question' },
      { type: 'file_text', file: { text: 'notes' } },
      historyImage,
    ]);
  });

  it('turns the latest string turn into text plus the page image', () => {
    const jpeg = 'data:image/jpeg;base64,ONLY';
    const result = withVisionImage([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,OLD' } }] },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'typed question' },
    ], 'fence body', jpeg);
    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: DEFAULT_OMITTED_IMAGE_PLACEHOLDER }],
      },
      { role: 'assistant', content: 'answer' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'typed question\n\nfence body' },
          { type: 'image_url', image_url: { url: jpeg } },
        ],
      },
    ]);
    expect(withVisionImage([{ role: 'assistant', content: 'hi' }], 'fence', jpeg)).toEqual([
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('still adds the shortening notice when the title already says it', () => {
    const closer = 'flint-ref-abcdef012345';
    const envelope = buildWebEnvelope({
      closer,
      title: 'Report. Shortened to fit context.',
      url: 'https://kept.example/a',
      retrievedOn: '2026-10-04',
      body: `alpha ${'word '.repeat(80)}`,
    });
    const cut = shortenWebEnvelope(envelope, closer, 40);
    expect(cut.shortened).toBe(true);
    const header = cut.text.split('\n')[0] ?? '';
    expect(header.endsWith('Shortened to fit context.')).toBe(true);
    expect(header.split('Shortened to fit context.').length - 1).toBe(2);
  });
});
