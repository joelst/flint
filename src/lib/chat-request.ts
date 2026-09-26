/**
 * Building the message array that is actually sent to a model.
 *
 * This is separated from the chat UI because it is where content *shape* stops being a display
 * concern and becomes a correctness one. A conversation holds two kinds of content — a plain
 * string, and an array of parts for a vision turn — and the previous implementation merged and
 * prefixed them with template literals. Interpolating an array yields `[object Object]`, so a
 * vision turn that had to be merged or prefixed reached the model with its text destroyed and
 * its image silently gone.
 *
 * Everything here is pure so those shape rules are testable; the UI keeps the full thread.
 */

import {
  isPromptRole,
  supportedParts,
  type ImagePart,
  type MessageContent,
  type TextPart,
} from './conversation-store';

/** A part this builder knows how to send. Opaque parts never reach a request. */
export type PromptPart = TextPart | ImagePart;

/** What a request message's content may be: a plain string, or vision parts. */
export type PromptContent = string | PromptPart[];

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: PromptContent;
}

/**
 * Separator between two turns that had to be merged into one.
 *
 * It applies only at a *turn* boundary. Parts within a single message are fragments of one
 * piece of text and are concatenated untouched — inserting a blank line between them would
 * reformat the user's content, which is especially destructive for code.
 */
const TURN_SEPARATOR = '\n\n';

/**
 * Reduce content to the parts that may be sent.
 *
 * A string becomes a single text part so merging has one shape to reason about. Parts are
 * validated here rather than trusted: this runs on the live `chatMessages` array, which is not
 * schema-checked, so a malformed part is reachable. An unusable part is skipped instead of
 * being coerced — `String(123)` would invent text the user never wrote, and a part with no
 * usable url is an image the model cannot fetch.
 */
export function toPromptParts(content: unknown): PromptPart[] {
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [{ type: 'text', text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: PromptPart[] = [];
  // `supportedParts` removes anything a newer build stored that this one cannot describe to a
  // model; the checks below then reject anything malformed that it let through.
  for (const part of supportedParts(content as MessageContent)) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      if (typeof part.text !== 'string') continue;
      // Kept byte for byte, including leading whitespace. A part is a fragment of a larger
      // message, so trimming one would silently re-indent code split across parts, and
      // dropping a whitespace-only part would delete a deliberate blank line.
      if (part.text) parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const url = (part as ImagePart).image_url?.url;
      if (typeof url === 'string' && url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return parts;
}

/**
 * Collapse parts back to the narrowest shape that carries them.
 *
 * Text-only content is sent as a string because that is what a text-only model expects, and
 * wrapping it in a parts array is the kind of difference that makes a strict server reject an
 * otherwise valid request. Anything holding an image must stay structured.
 */
export function fromPromptParts(parts: PromptPart[]): PromptContent | null {
  if (parts.length === 0) return null;
  if (parts.every((p) => p.type === 'text')) {
    // Concatenated with no separator: any turn boundary among these was already fused into a
    // single part by `mergePromptParts`, so everything still separate here belongs to one
    // message and must join exactly as the user wrote it.
    const text = (parts as TextPart[]).map((p) => p.text).join('');
    return text.trim() ? text : null;
  }
  return parts;
}

/**
 * True when these parts carry something worth sending.
 *
 * Whitespace-only text is not: it is a turn the model still has to account for, and it is what
 * an assistant placeholder looks like before its stream starts.
 */
export function hasSendableContent(parts: PromptPart[]): boolean {
  return parts.some((p) => (p.type === 'text' ? p.text.trim() !== '' : true));
}

/**
 * Join two turns into one.
 *
 * Adjacent text is merged into a single part rather than left as two, because parts are
 * concatenated without a separator downstream — leaving them apart would run the end of one
 * turn into the start of the next.
 */
export function mergePromptParts(a: PromptPart[], b: PromptPart[]): PromptPart[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  const merged = [...a];
  const last = merged[merged.length - 1];
  const [first, ...rest] = b;
  if (last.type === 'text' && first.type === 'text') {
    merged[merged.length - 1] = { type: 'text', text: `${last.text}${TURN_SEPARATOR}${first.text}` };
    return [...merged, ...rest];
  }
  return [...merged, ...b];
}

export interface AlternatingOptions {
  /**
   * Text that must reach the model even when it has no system role available.
   *
   * Folded into the first user turn rather than sent as a `system` message, because the strict
   * templates this function exists for reject one.
   */
  systemInstruction?: string;
  /** Wording of the folded-in instruction. Injected so the prompt text is testable. */
  instructionPrefix?: string;
  /**
   * Reduce every turn to plain text, replacing images with a placeholder.
   *
   * For requests whose *output* is text about the thread rather than a reply to it —
   * summarization is the case that exists — where the image contributes nothing but has to
   * travel as base64. It also keeps such a request on the SDK transport, which rejects
   * non-string content outright, so a vision thread would otherwise fail the moment no HTTP
   * endpoint was available.
   *
   * A placeholder rather than a deletion: the model should know a turn carried an image, or a
   * summary can end up describing a conversation that reads as though nothing was shared.
   */
  textOnly?: boolean;
  /** Stand-in for an image when `textOnly` is set. Injected so the prompt text is testable. */
  imagePlaceholder?: string;
}

export const DEFAULT_INSTRUCTION_PREFIX = 'Follow these instructions:';

export const DEFAULT_IMAGE_PLACEHOLDER = '[image]';

/**
 * Collapse parts to text, standing an image in with a placeholder.
 *
 * Adjacent text is joined without a separator: parts of one message are fragments of a single
 * piece of text, and inserting anything between them would reformat the user's content.
 */
function flattenPartsToText(parts: PromptPart[], placeholder: string): PromptPart[] {
  const text = parts
    .map((part) => (part.type === 'text' ? part.text : placeholder))
    .join('');
  return text.trim() ? [{ type: 'text', text }] : [];
}

/**
 * Normalize a thread for templates that accept only user/assistant, strictly alternating.
 *
 * Several local models (Mistral Instruct among them) fail outright on a system role or on two
 * turns of the same role in a row, so this is not a nicety. Three rules:
 *
 *  - System text is collected and folded into the first user turn.
 *  - Roles that cannot be replayed are dropped, not guessed at. `tool` is excluded here even
 *    though it is a stored role, because a faithful tool turn carries call linkage this build
 *    does not model.
 *  - Consecutive same-role turns are merged structurally, never by stringification.
 *
 * A thread that opens with an assistant turn has that turn dropped, since a template requiring
 * alternation has nowhere to put it — unless `systemInstruction` is set, which prepends a user
 * turn and so gives the assistant turn a valid position to occupy.
 *
 * With `textOnly`, images are replaced by a placeholder and every turn collapses to a string.
 */
export function normalizeForAlternatingChat(
  messages: Array<{ role?: unknown; content?: unknown }>,
  options: AlternatingOptions = {},
): PromptMessage[] {
  const instructionParts: PromptPart[] = [];
  const seed = typeof options.systemInstruction === 'string' ? options.systemInstruction.trim() : '';
  if (seed) instructionParts.push({ type: 'text', text: seed });

  const collected: Array<{ role: 'user' | 'assistant'; parts: PromptPart[] }> = [];
  for (const message of messages ?? []) {
    const role = message?.role;
    if (!isPromptRole(role)) continue;
    const raw = toPromptParts(message?.content);
    const parts = options.textOnly
      ? flattenPartsToText(raw, options.imagePlaceholder ?? DEFAULT_IMAGE_PLACEHOLDER)
      : raw;
    if (!hasSendableContent(parts)) continue;
    if (role === 'system') {
      // An image in a system turn has nowhere to go once the instruction is folded into a user
      // turn, so only its text carries. Dropping it silently is acceptable because a system
      // turn cannot hold one through normal use.
      const systemText = parts.filter((p) => p.type === 'text').map((p) => (p as TextPart).text).join('');
      if (systemText.trim()) instructionParts.push({ type: 'text', text: systemText });
      continue;
    }
    collected.push({ role, parts });
  }

  if (instructionParts.length > 0) {
    const prefix = options.instructionPrefix ?? DEFAULT_INSTRUCTION_PREFIX;
    // Each entry came from a separate source (the app's prompt, then each system turn), so
    // these are turn boundaries and do take a blank line between them.
    const instructionText = instructionParts.map((p) => (p as TextPart).text).join(TURN_SEPARATOR);
    const instruction: PromptPart[] = [
      { type: 'text', text: `${prefix}\n${instructionText}` },
    ];
    if (collected.length > 0 && collected[0].role === 'user') {
      collected[0] = { role: 'user', parts: mergePromptParts(instruction, collected[0].parts) };
    } else {
      collected.unshift({ role: 'user', parts: instruction });
    }
  }

  const alternating: Array<{ role: 'user' | 'assistant'; parts: PromptPart[] }> = [];
  for (const message of collected) {
    if (alternating.length === 0) {
      if (message.role !== 'user') continue;
      alternating.push(message);
      continue;
    }
    const previous = alternating[alternating.length - 1];
    if (previous.role === message.role) {
      previous.parts = mergePromptParts(previous.parts, message.parts);
      continue;
    }
    alternating.push(message);
  }

  const result: PromptMessage[] = [];
  for (const message of alternating) {
    const content = fromPromptParts(message.parts);
    if (content === null) continue;
    result.push({ role: message.role, content });
  }
  return result;
}

/**
 * True when a turn is an empty assistant placeholder awaiting a stream.
 *
 * Deliberately not `content?.trim()`: an array has no `trim`, so that form throws on any vision
 * turn it is handed.
 */
export function isEmptyAssistantPlaceholder(message: { role?: unknown; content?: unknown }): boolean {
  return message?.role === 'assistant' && !hasSendableContent(toPromptParts(message?.content));
}
