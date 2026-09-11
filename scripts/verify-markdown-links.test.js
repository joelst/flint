import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractLinks,
  isExternalOrNonFileLink,
  stripFragment,
  verifyMarkdownLinks,
  verifyMarkdownLinksFromFiles,
} from './verify-markdown-links.cjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('extractLinks', () => {
  it('extracts an ordinary markdown link', () => {
    expect(extractLinks('See [a](./b.md) for details.')).toEqual(['./b.md']);
  });

  it('ignores links inside fenced code blocks', () => {
    const markdown = '```js\nconst x = "[fake](./nope.md)";\n```\n';
    expect(extractLinks(markdown)).toEqual([]);
  });

  it('ignores links inside inline code spans', () => {
    expect(extractLinks('Inline `[fake](./nope.md)` code.')).toEqual([]);
  });

  it('extracts a link inside a list item', () => {
    expect(extractLinks('- [a](./b.md)\n- [c](./d.md)\n')).toEqual(['./b.md', './d.md']);
  });

  it('extracts a link inside a GFM table cell', () => {
    const markdown = '| Doc |\n| --- |\n| [a](./b.md) |\n';
    expect(extractLinks(markdown)).toEqual(['./b.md']);
  });
});

describe('isExternalOrNonFileLink', () => {
  it('treats http(s) and mailto links as external', () => {
    expect(isExternalOrNonFileLink('https://example.com')).toBe(true);
    expect(isExternalOrNonFileLink('http://example.com')).toBe(true);
    expect(isExternalOrNonFileLink('mailto:a@example.com')).toBe(true);
  });

  it('treats a bare same-document anchor as external', () => {
    expect(isExternalOrNonFileLink('#some-heading')).toBe(true);
  });

  it('treats a relative path as not external', () => {
    expect(isExternalOrNonFileLink('./docs/FOO.md')).toBe(false);
    expect(isExternalOrNonFileLink('../README.md')).toBe(false);
  });
});

describe('stripFragment', () => {
  it('removes a trailing fragment', () => {
    expect(stripFragment('./FOO.md#some-heading')).toBe('./FOO.md');
  });

  it('leaves a fragment-less link untouched', () => {
    expect(stripFragment('./FOO.md')).toBe('./FOO.md');
  });
});

describe('verifyMarkdownLinksFromFiles', () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('passes when every relative link resolves to an existing file', () => {
    root = mkdtempSync(join(tmpdir(), 'flint-md-links-'));
    writeFileSync(join(root, 'TARGET.md'), '# Target\n');
    const files = [{ path: 'SOURCE.md', markdown: 'See [target](./TARGET.md).\n' }];
    expect(verifyMarkdownLinksFromFiles(root, files, { log: () => {} })).toBe(1);
  });

  it('passes for a link to an existing directory', () => {
    root = mkdtempSync(join(tmpdir(), 'flint-md-links-'));
    mkdirSync(join(root, 'docs'));
    const files = [{ path: 'SOURCE.md', markdown: 'See [docs](./docs) for more.\n' }];
    expect(verifyMarkdownLinksFromFiles(root, files, { log: () => {} })).toBe(1);
  });

  it('ignores external links, mailto links, and same-document anchors', () => {
    root = mkdtempSync(join(tmpdir(), 'flint-md-links-'));
    const markdown =
      'See [site](https://example.com), [mail](mailto:a@example.com), and [here](#heading).\n';
    const files = [{ path: 'SOURCE.md', markdown }];
    expect(verifyMarkdownLinksFromFiles(root, files, { log: () => {} })).toBe(0);
  });

  it('resolves a link relative to the source file directory, not the repo root', () => {
    root = mkdtempSync(join(tmpdir(), 'flint-md-links-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'SIBLING.md'), '# Sibling\n');
    const files = [{ path: 'docs/SOURCE.md', markdown: 'See [sibling](./SIBLING.md).\n' }];
    expect(verifyMarkdownLinksFromFiles(root, files, { log: () => {} })).toBe(1);
  });

  it('does not verify the fragment portion of a link', () => {
    root = mkdtempSync(join(tmpdir(), 'flint-md-links-'));
    writeFileSync(join(root, 'TARGET.md'), '# Target\n');
    const files = [
      { path: 'SOURCE.md', markdown: 'See [target](./TARGET.md#a-heading-that-does-not-exist).\n' },
    ];
    expect(verifyMarkdownLinksFromFiles(root, files, { log: () => {} })).toBe(1);
  });

  it('throws with the file, link, and resolved path when a target is missing', () => {
    root = mkdtempSync(join(tmpdir(), 'flint-md-links-'));
    const files = [{ path: 'SOURCE.md', markdown: 'See [missing](./NOPE.md).\n' }];
    expect(() => verifyMarkdownLinksFromFiles(root, files, { log: () => {} })).toThrow(
      /SOURCE\.md: link "\.\/NOPE\.md" -> missing/,
    );
  });

  it('reports every broken link, not just the first', () => {
    root = mkdtempSync(join(tmpdir(), 'flint-md-links-'));
    const files = [
      { path: 'A.md', markdown: 'See [a](./NOPE1.md).\n' },
      { path: 'B.md', markdown: 'See [b](./NOPE2.md).\n' },
    ];
    try {
      verifyMarkdownLinksFromFiles(root, files, { log: () => {} });
      throw new Error('expected verifyMarkdownLinksFromFiles to throw');
    } catch (error) {
      expect(String(error.message)).toMatch(/NOPE1\.md/);
      expect(String(error.message)).toMatch(/NOPE2\.md/);
    }
  });
});

describe('verifyMarkdownLinks', () => {
  it('checks every tracked markdown file in the real repo without throwing', () => {
    const messages = [];
    const count = verifyMarkdownLinks(repoRoot, { log: (message) => messages.push(message) });
    expect(count).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/Markdown links verified: \d+ relative links across \d+ files/);
  });
});
