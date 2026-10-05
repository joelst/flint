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

export function millisecondsUntilNextLocalDay(now = Date.now()): number {
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) return 60_000;
  const next = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() + 1,
  ).getTime();
  return Math.max(1, next - now + 100);
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

/**
 * Qwen3-family and QwQ templates open `<think>` in the prompt, before the model writes.
 * The generated text stays reasoning until the model emits the closing tag. Qwen2 does not.
 */
export function modelPrefillsThink(alias: string | null | undefined): boolean {
  const name = (alias ?? "").toLowerCase();
  return name.includes("qwen3") || name.includes("qwq");
}

/**
 * New replies store the flag. A reply saved before that flag existed has no producer
 * metadata, so it stays as written. The model selected now is not that metadata:
 * switching to Qwen3 must not hide another model's answer.
 */
export function replyUsesPrefilledThink(input: { stamped: boolean }): boolean {
  return input.stamped === true;
}

/**
 * Split a reply into reasoning and answer.
 * A prefilled-think model that never closes the tag has no answer yet, including after the
 * stream ends because the token budget ran out. Other reasoning models still show untagged
 * text as the answer once the stream settles.
 */
const ROLE_LINE = /^(user|system|assistant|tool)$/i;

function fenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('```')) {
      open = !open;
    } else {
      mask[index] = open;
    }
  }
  return mask;
}

/** A whole line the model wrote as a web tool call, not a call Flint executed. */
function webToolJsonLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const value = JSON.parse(trimmed) as { name?: unknown; arguments?: unknown };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const args = value.arguments;
    return (value.name === 'web_search' || value.name === 'web_fetch')
      && args !== null
      && typeof args === 'object'
      && !Array.isArray(args);
  } catch {
    return false;
  }
}

function textHasWebToolJsonLine(text: string): boolean {
  const lines = text.split('\n');
  const fenced = fenceMask(lines);
  return lines.some((line, index) => !fenced[index] && webToolJsonLine(line));
}

/**
 * Qwen-family templates mark turns with `<|im_start|>role` and `<|im_end|>`. The decoder
 * drops those markers and leaves the role word on its own line. Drop those lines when they
 * sit after a closing think tag, trail the reply, or come in a run. A single role word
 * between sentences stays, and so does one inside a code fence. While a stream is still
 * open, the last line is kept so a word the model has not finished can still grow.
 * A whole line of web_search or web_fetch JSON is dropped first, outside fences, so a
 * role line after those lines still counts as immediately after the think close.
 * `<|im_start|>`, `<|im_end|>`, and `<|endoftext|>` are removed only outside a code fence.
 */
export function stripChatTemplateSpill(
  text: string,
  options?: { keepTrailingOpenLine?: boolean },
): string {
  const rawLines = text.split('\n');
  const fenced = fenceMask(rawLines);
  const lines = rawLines.map((line, index) => (
    fenced[index]
      ? line
      : line.replace(/<\|(?:im_start|im_end|endoftext)\|>/gi, '')
  ));
  const blank = (line: string) => line.trim() === '';
  const isRole = (index: number) => !fenced[index] && ROLE_LINE.test(lines[index].trim());
  const openTail = options?.keepTrailingOpenLine === true
    && text.length > 0
    && !text.endsWith('\n');
  const canDrop = (index: number) => !(openTail && index === lines.length - 1);
  const drop = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!fenced[index] && webToolJsonLine(lines[index]) && canDrop(index)) drop.add(index);
  }
  const nonBlank: number[] = [];
  lines.forEach((line, index) => {
    if (!blank(line) && !drop.has(index)) nonBlank.push(index);
  });

  let runStart = 0;
  for (let cursor = 0; cursor <= nonBlank.length; cursor += 1) {
    const index = cursor < nonBlank.length ? nonBlank[cursor] : -1;
    const roleHere = index >= 0 && isRole(index);
    if (!roleHere) {
      const span = nonBlank.slice(runStart, cursor);
      if (span.length >= 2 && span.every((line) => isRole(line))) {
        for (const line of span) if (canDrop(line)) drop.add(line);
      }
      runStart = cursor + 1;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!/<\/think>|<\/thinking>/i.test(lines[index])) continue;
    for (let follow = index + 1; follow < lines.length; follow += 1) {
      if (blank(lines[follow]) || drop.has(follow)) continue;
      if (isRole(follow) && canDrop(follow)) drop.add(follow);
      else break;
    }
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (blank(lines[index]) || drop.has(index)) continue;
    if (isRole(index) && canDrop(index)) drop.add(index);
    else break;
  }

  const survivors = nonBlank.filter((index) => !drop.has(index));
  if (survivors.length === 0 && nonBlank.length === 1) drop.delete(nonBlank[0]);

  return lines.filter((_, index) => !drop.has(index)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const APP_STATUS_PREFIXES = [
  "Searching the public web",
  "Consulting the public web",
  "Reading ",
];
const APP_STOP_MARKER = "[Stopped after web retrieval";

function appStatusPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return APP_STATUS_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function presentAssistantText(input: {
  text: string;
  streaming: boolean;
  assumeReasoning: boolean;
  prefilledThink: boolean;
}): { visibleContent: string; thinkingContent: string[]; stoppedBeforeAnswer: boolean } {
  const strip = input.prefilledThink
    || /<\/think>|<\/thinking>|<\|im_start\|>|<\|im_end\|>/i.test(input.text)
    || textHasWebToolJsonLine(input.text);
  const text = strip
    ? stripChatTemplateSpill(input.text, { keepTrailingOpenLine: input.streaming })
    : input.text;
  // Status lines are written only while this send is active. After it ends, the same
  // prefix is model text: "Reading the question…" must still get the cutoff note.
  if (
    (input.streaming && appStatusPlaceholder(text))
    || text.trim().startsWith(APP_STOP_MARKER)
  ) {
    return { visibleContent: text.trim(), thinkingContent: [], stoppedBeforeAnswer: false };
  }
  const stopAt = text.indexOf(APP_STOP_MARKER);
  if (input.prefilledThink && stopAt >= 0 && !/<\/think>|<\/thinking>/i.test(text)) {
    const reasoning = text.slice(0, stopAt).trim();
    return {
      visibleContent: text.slice(stopAt).trim(),
      thinkingContent: reasoning ? [reasoning] : [],
      stoppedBeforeAnswer: false,
    };
  }
  const extracted = extractThinkingTrace(text, input.assumeReasoning);
  let visibleContent = extracted.visibleContent;
  let thinkingContent = extracted.thinkingContent;
  const untagged = thinkingContent.length === 0 && visibleContent.length > 0;
  const hold = untagged && (
    (input.streaming && (input.assumeReasoning || input.prefilledThink))
    || (!input.streaming && input.prefilledThink)
  );
  if (hold) {
    thinkingContent = [visibleContent];
    visibleContent = "";
  }
  const closed = /<\/think>|<\/thinking>/i.test(text);
  return {
    visibleContent,
    thinkingContent,
    stoppedBeforeAnswer: !input.streaming
      && input.prefilledThink
      && !closed
      && thinkingContent.length > 0
      && visibleContent.length === 0,
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
