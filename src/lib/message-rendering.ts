import { isBareContentPart, type MessageContent } from "./conversation-store";
import {
  MAX_CONVERSATION_PREVIEW_IMAGES,
  MAX_CONVERSATION_PREVIEW_PIXELS,
  parseImageDataUrl,
} from "../../sidecar/image-dimensions.js";

export type RenderableMessagePart =
  | { type: "text"; text: string }
  | { type: "image"; previewUrl: string | null; label: string }
  | { type: "file"; name: string; text: string }
  | { type: "unknown"; label: string };

export type RenderableMessageAttachment = Exclude<RenderableMessagePart, { type: "text" }>;

/**
 * Normalize a stored message's content into a parts array.
 *
 * Message records come straight out of the persisted archive and are typed `any` at the call
 * sites, so a record can legitimately be missing `content` (or carry a legacy shape). These
 * helpers feed a `$derived` read by the whole chat view, and a derived that throws takes the
 * entire Playground down rather than degrading one message — so anything that is not a string
 * or an array renders as no parts at all.
 *
 * A bare part object is the one non-array shape worth recovering, and it is recovered
 * everywhere rather than only here: `normalizeContentDetailed` repairs the same shape on
 * load and `reducePromptParts` sends it, so a lone part is not shown here only to be
 * dropped on the next launch. Each of the three still judges the part's own contents for
 * its own purpose; the shared rule is the wrapper, not the verdict.
 */
function contentParts(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  if (isBareContentPart(content)) return [content];
  return [];
}

// Parsing decodes the whole payload (a JPEG frame header can follow any amount of metadata),
// and messages re-render often, so verdicts are memoized per URL.
const PREVIEW_CACHE_LIMIT = 64;
const previewVerdicts = new Map<string, { width: number; height: number } | null>();

/**
 * True when a stored image may be handed to the webview. Stored and imported images never
 * passed composer compaction, and `<img>` decodes as soon as a conversation opens, so the
 * encoded length, raster label, header, and pixel budget are all checked first — the same
 * rules the native request applies.
 */
function safeImageDimensions(url: string): { width: number; height: number } | null {
  const cached = previewVerdicts.get(url);
  if (cached !== undefined) return cached;
  const parsed = parseImageDataUrl(url);
  const dimensions = parsed.ok ? { width: parsed.width, height: parsed.height } : null;
  if (previewVerdicts.size >= PREVIEW_CACHE_LIMIT) {
    previewVerdicts.delete(previewVerdicts.keys().next().value as string);
  }
  previewVerdicts.set(url, dimensions);
  return dimensions;
}

function hasTextPart(part: unknown): part is { type: "text"; text: string } {
  return typeof part === "object"
    && part !== null
    && (part as { type?: unknown }).type === "text"
    && typeof (part as { text?: unknown }).text === "string";
}

function hasFilePart(part: unknown): part is {
  type: "file_text";
  file: { name: string; text: string };
} {
  if (typeof part !== "object" || part === null || (part as { type?: unknown }).type !== "file_text") {
    return false;
  }
  const file = (part as { file?: unknown }).file;
  return typeof file === "object"
    && file !== null
    && typeof (file as { name?: unknown }).name === "string"
    && typeof (file as { text?: unknown }).text === "string";
}

function hasImagePart(part: unknown): part is {
  type: "image_url";
  image_url: { url: string };
} {
  if (typeof part !== "object" || part === null || (part as { type?: unknown }).type !== "image_url") {
    return false;
  }
  const image = (part as { image_url?: unknown }).image_url;
  return typeof image === "object"
    && image !== null
    && typeof (image as { url?: unknown }).url === "string";
}

/**
 * Allocate a bounded preview budget across a whole conversation, favoring its most recent
 * images. Every returned index identifies an image part in the corresponding message.
 */
export function conversationImagePreviewPartIndexes(
  contents: readonly MessageContent[],
): number[][] {
  const allowed = contents.map(() => [] as number[]);
  let remainingPixels = MAX_CONVERSATION_PREVIEW_PIXELS;
  let remainingImages = MAX_CONVERSATION_PREVIEW_IMAGES;
  for (let messageIndex = contents.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = contents[messageIndex];
    const parts = contentParts(content);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      if (remainingImages === 0) return allowed;
      const part = parts[partIndex];
      if (!hasImagePart(part)) continue;
      const dimensions = safeImageDimensions(part.image_url.url);
      if (!dimensions) continue;
      const pixels = dimensions.width * dimensions.height;
      if (pixels > remainingPixels) continue;
      allowed[messageIndex].push(partIndex);
      remainingPixels -= pixels;
      remainingImages -= 1;
    }
  }
  return allowed;
}

export function renderableMessageParts(
  content: MessageContent,
  previewImagePartIndexes?: readonly number[],
): RenderableMessagePart[] {
  const parts = contentParts(content);
  const allowed = new Set(
    previewImagePartIndexes ?? conversationImagePreviewPartIndexes([content])[0],
  );
  return parts.map((part, index) => {
    if (hasTextPart(part)) {
      return { type: "text" as const, text: part.text };
    }
    if (hasFilePart(part)) {
      return { type: "file" as const, name: part.file.name, text: part.file.text };
    }
    if (hasImagePart(part)) {
      return {
        type: "image" as const,
        previewUrl: allowed.has(index) && safeImageDimensions(part.image_url.url)
          ? part.image_url.url
          : null,
        label: "Attached image",
      };
    }
    return { type: "unknown" as const, label: "Attachment this version cannot display" };
  });
}

export function nonTextMessageParts(
  parts: readonly RenderableMessagePart[],
): RenderableMessageAttachment[] {
  return parts.filter((part): part is RenderableMessageAttachment => part.type !== "text");
}

export function messagePlainText(content: MessageContent): string {
  return contentParts(content)
    .filter(hasTextPart)
    .map((part) => part.text)
    .join("\n");
}

export function messageClipboardText(content: MessageContent): string {
  return renderableMessageParts(content)
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "file") return `[Attached file: ${part.name}]\n${part.text}`;
      return `[${part.label}]`;
    })
    .filter(Boolean)
    .join("\n");
}

export function messageTimestamp(
  timestamp: unknown,
  now = Date.now(),
  locale?: string,
): { label: string; title: string; datetime: string } | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;

  const current = new Date(now);
  const sameDay = Number.isFinite(current.getTime())
    && date.getFullYear() === current.getFullYear()
    && date.getMonth() === current.getMonth()
    && date.getDate() === current.getDate();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const label = sameDay
    ? time
    : new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
  const title = new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeStyle: "medium",
  }).format(date);
  return { label, title, datetime: date.toISOString() };
}

export function extractThinkingTrace(text: string, recognizePlainText = false): {
  visibleContent: string;
  thinkingContent: string[];
} {
  const sections: string[] = [];
  let visible = text;
  // Each tag: [closed pair, open-with-no-close (still streaming), bare open tag, bare close tag].
  // Some chat templates (e.g. Qwen3-family) inject the opening tag as part of the prompt
  // prefix fed to the model rather than the generated text, so only the closing tag ever
  // comes back in `content` — a plain open/close pair match alone misses that case entirely.
  const tagPairs: Array<[RegExp, RegExp, RegExp, RegExp]> = [
    [/<think>([\s\S]*?)<\/think>/gi, /<think>([\s\S]*)$/i, /<think>/i, /<\/think>/i],
    [/<thinking>([\s\S]*?)<\/thinking>/gi, /<thinking>([\s\S]*)$/i, /<thinking>/i, /<\/thinking>/i]
  ];

  for (const [closedPattern, openPattern, openTag, closeTag] of tagPairs) {
    const closedMatches = Array.from(visible.matchAll(closedPattern));
    for (const match of closedMatches) {
      const body = String(match[1] ?? '').trim();
      if (body) sections.push(body);
    }
    visible = visible.replace(closedPattern, '');

    const openIdx = visible.search(openTag);
    const closeIdx = visible.search(closeTag);
    if (closeIdx !== -1 && (openIdx === -1 || openIdx > closeIdx)) {
      const closeMatch = visible.match(closeTag);
      const tagLen = closeMatch ? closeMatch[0].length : 0;
      const body = visible.slice(0, closeIdx).trim();
      if (body) sections.push(body);
      visible = visible.slice(closeIdx + tagLen);
      continue;
    }

    const openMatch = visible.match(openPattern);
    if (openMatch) {
      const body = String(openMatch[1] ?? '').trim();
      if (body) sections.push(body);
      visible = visible.replace(openPattern, '');
    }
  }

  if (recognizePlainText && sections.length === 0) {
    const heading = visible.match(
      /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:thinking|reasoning) process(?:\*\*|__)?\s*:\s*/i,
    );
    if (heading) {
      const body = visible.slice(heading[0].length);
      const finalHeading = body.match(
        /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:final answer|answer)(?:\*\*|__)?\s*:\s*/i,
      );
      if (finalHeading?.index !== undefined) {
        const reasoning = body.slice(0, finalHeading.index).trim();
        if (reasoning) sections.push(reasoning);
        visible = body.slice(finalHeading.index + finalHeading[0].length);
      } else {
        const reasoning = body.trim();
        if (reasoning) sections.push(reasoning);
        visible = "";
      }
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
