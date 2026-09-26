#!/usr/bin/env node
/**
 * Verify that relative markdown links in tracked `.md` files resolve to a file or
 * directory that exists on disk.
 *
 * This checks the path portion of a link only. `#anchor` fragments are not verified:
 * GitHub's heading-slug rules (duplicate-heading suffixes, punctuation stripping) are
 * a separate, more failure-prone problem than "does this file exist," so a link whose
 * fragment is wrong will not be caught here.
 *
 * External links (http/https/mailto), same-document anchors (`#foo`), and links inside
 * fenced or inline code are all ignored: `marked`'s lexer walks the parsed token tree
 * rather than regex-matching raw text, so code samples containing `[text](...)` syntax
 * are never mistaken for real links.
 *
 * Usage:
 *   node scripts/verify-markdown-links.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { marked } = require('marked');

/** Lists tracked `.md` files via git, so build output and node_modules are never scanned. */
function listTrackedMarkdownFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: root,
    encoding: 'utf8',
  });
  return output.split('\0').filter(Boolean);
}

/** Collects every link `href` in a markdown document, skipping code spans/blocks. */
function extractLinks(markdown) {
  const links = [];
  // `walkTokens` recurses into every token shape marked produces, including table
  // header/row cells (`token.tokens`/`token.items` alone miss those), so it is used
  // instead of a hand-rolled recursive visitor.
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type === 'link') links.push(token.href);
  });
  return links;
}

function isExternalOrNonFileLink(href) {
  return (
    href.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/i.test(href) // any URL scheme: http:, https:, mailto:, etc.
  );
}

/** Strips a trailing `#fragment` (fragments are not verified; see module docs). */
function stripFragment(href) {
  const hashIndex = href.indexOf('#');
  return hashIndex < 0 ? href : href.slice(0, hashIndex);
}

/**
 * Checks every relative link in the given markdown documents and returns the count of
 * relative links checked. Throws with all failures listed if any target is missing.
 *
 * Pure core: takes file contents directly (as `{ path, markdown }` entries relative to
 * `root`) so it can be exercised with fixtures without depending on git or the real
 * filesystem tree.
 */
function verifyMarkdownLinksFromFiles(root, files, log = console) {
  const failures = [];
  let checkedLinks = 0;

  for (const { path: relativeFile, markdown } of files) {
    const absoluteFile = path.join(root, relativeFile);
    const links = extractLinks(markdown);

    for (const href of links) {
      if (isExternalOrNonFileLink(href)) continue;
      const targetPath = stripFragment(decodeURIComponent(href));
      if (targetPath === '') continue; // a bare `#fragment` link, already filtered, but be defensive

      checkedLinks += 1;
      const resolved = path.resolve(path.dirname(absoluteFile), targetPath);
      if (!fs.existsSync(resolved)) {
        failures.push({ file: relativeFile, href, resolved });
      }
    }
  }

  if (failures.length > 0) {
    const details = failures
      .map((failure) => `  ${failure.file}: link "${failure.href}" -> missing ${failure.resolved}`)
      .join('\n');
    throw new Error(`Broken relative markdown links found:\n${details}`);
  }

  log.log(`Markdown links verified: ${checkedLinks} relative links across ${files.length} files`);
  return checkedLinks;
}

/** Reads every tracked markdown file from `root` and delegates to the pure checker. */
function verifyMarkdownLinks(root, log = console) {
  const trackedFiles = listTrackedMarkdownFiles(root);
  const files = trackedFiles.map((relativeFile) => ({
    path: relativeFile,
    markdown: fs.readFileSync(path.join(root, relativeFile), 'utf8'),
  }));
  return verifyMarkdownLinksFromFiles(root, files, log);
}

module.exports = {
  extractLinks,
  isExternalOrNonFileLink,
  listTrackedMarkdownFiles,
  stripFragment,
  verifyMarkdownLinks,
  verifyMarkdownLinksFromFiles,
};

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  try {
    verifyMarkdownLinks(root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
