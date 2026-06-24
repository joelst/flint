export function extractThinkingTrace(text: string): {
  visibleContent: string;
  thinkingContent: string[];
} {
  const sections: string[] = [];
  let visible = text;
  const tagPairs: Array<[RegExp, RegExp]> = [
    [/<think>([\s\S]*?)<\/think>/gi, /<think>([\s\S]*)$/i],
    [/<thinking>([\s\S]*?)<\/thinking>/gi, /<thinking>([\s\S]*)$/i]
  ];

  for (const [closedPattern, openPattern] of tagPairs) {
    const closedMatches = Array.from(visible.matchAll(closedPattern));
    for (const match of closedMatches) {
      const body = String(match[1] ?? '').trim();
      if (body) sections.push(body);
    }
    visible = visible.replace(closedPattern, '');

    const openMatch = visible.match(openPattern);
    if (openMatch) {
      const body = String(openMatch[1] ?? '').trim();
      if (body) sections.push(body);
      visible = visible.replace(openPattern, '');
    }
  }

  return {
    visibleContent: visible.trim(),
    thinkingContent: sections
  };
}

export function sanitizeAssistantHtml(html: string): string {
  if (typeof DOMParser === 'undefined' || typeof NodeFilter === 'undefined') {
    return html
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const allowedTags = new Set([
    'A',
    'P',
    'BR',
    'STRONG',
    'EM',
    'UL',
    'OL',
    'LI',
    'PRE',
    'CODE',
    'BLOCKQUOTE',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'TABLE',
    'THEAD',
    'TBODY',
    'TR',
    'TH',
    'TD',
    'HR'
  ]);
  const allowedAttrs = new Set(['href', 'title', 'target', 'rel']);

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  const toRemove: Element[] = [];
  let node = walker.nextNode() as Element | null;
  while (node) {
    const tag = node.tagName.toUpperCase();
    if (!allowedTags.has(tag)) {
      toRemove.push(node);
    } else {
      const attrs = Array.from(node.attributes);
      for (const attr of attrs) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || !allowedAttrs.has(name)) {
          node.removeAttribute(attr.name);
          continue;
        }
        if (name === 'href') {
          const value = attr.value.trim().toLowerCase();
          const safe =
            value.startsWith('http://') ||
            value.startsWith('https://') ||
            value.startsWith('mailto:') ||
            value.startsWith('tel:') ||
            (value.startsWith('/') && !value.startsWith('//')) ||
            value.startsWith('#');
          if (!safe) {
            node.removeAttribute(attr.name);
          }
        }
      }
      if (tag === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
    node = walker.nextNode() as Element | null;
  }

  for (const el of toRemove) {
    el.replaceWith(doc.createTextNode(el.textContent || ''));
  }

  return doc.body.innerHTML;
}
