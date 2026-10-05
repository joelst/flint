/**
 * Context-size estimation for the Playground's token meter.
 *
 * This is a display heuristic, not a tokenizer: Foundry Local exposes no tokenizer to the
 * frontend, so the meter approximates. It feeds a `$derived` read by the whole chat view,
 * so every shape that is not what this expects contributes what it can and nothing else
 * rather than throwing and blanking the Playground over a number.
 *
 * Normalized prompts are `text` or `image_url`. A stored `file_text` part is counted as the
 * framed prompt `formatTextAttachmentPrompt` will send, not the raw file body. A part whose
 * name or text is not a string adds nothing and does not throw.
 */

import { formatTextAttachmentPrompt } from "./text-attachment-policy";

/** Rough per-image context cost. Images are opaque here, so one flat overhead is used. */
export const IMAGE_TOKEN_OVERHEAD = 500;

/** Per-message overhead for role markers and chat-template formatting. */
const PER_MESSAGE_OVERHEAD = 1.5;

/**
 * Estimate the token count of a single string.
 *
 * Blends two heuristics and takes the larger, so neither long unbroken tokens nor ordinary
 * prose is badly under-counted: ~3.9 characters per token, and ~1.33 tokens per word.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = text.trim().split(/\s+/).length;
  const charBased = chars / 3.9;
  const wordBased = words * 1.33;
  return Math.ceil(Math.max(charBased, wordBased));
}

/** Text carried by a content part, or null when the part carries none this can read. */
function partText(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  if ((part as { type?: unknown }).type !== "text") return null;
  const text = (part as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/** Framed prompt tokens for a stored file part, or 0 when it is not one. */
function framedFileTokens(part: unknown): number {
  if (typeof part !== "object" || part === null) return 0;
  if ((part as { type?: unknown }).type !== "file_text") return 0;
  const file = (part as { file?: unknown }).file;
  if (!file || typeof file !== "object") return 0;
  const name = (file as { name?: unknown }).name;
  const text = (file as { text?: unknown }).text;
  if (typeof name !== "string" || typeof text !== "string") return 0;
  return estimateTokens(formatTextAttachmentPrompt({ name, text }));
}

function isImagePart(part: unknown): boolean {
  return typeof part === "object"
    && part !== null
    && (part as { type?: unknown }).type === "image_url";
}

/**
 * Ids, function names, and argument strings travel with the completion even when `content`
 * is empty. A display `name` is counted only on a tool result that names its `tool_call_id`.
 */
function toolLinkageText(message: object): string {
  const lines: string[] = [];
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const id = (call as { id?: unknown }).id;
      const fn = (call as { function?: unknown }).function;
      const name = fn && typeof fn === "object" ? (fn as { name?: unknown }).name : undefined;
      const args = fn && typeof fn === "object" ? (fn as { arguments?: unknown }).arguments : undefined;
      if (typeof id === "string" && id.length > 0) lines.push(id);
      if (typeof name === "string" && name.length > 0) lines.push(name);
      if (typeof args === "string" && args.length > 0) lines.push(args);
    }
  }
  const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
  if (typeof toolCallId === "string" && toolCallId.length > 0) {
    lines.push(toolCallId);
    const name = (message as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) lines.push(name);
  }
  return lines.join("\n");
}

/**
 * Estimate the context a message list occupies.
 *
 * Non-object messages, and messages whose content is neither a string nor an array, still
 * count their formatting overhead: they occupy a turn even when their payload is unreadable.
 */
export function estimateTokensForMessages(msgs: readonly unknown[]): number {
  if (!Array.isArray(msgs)) return 0;
  let total = 0;
  for (const message of msgs) {
    const record = typeof message === "object" && message !== null
      ? message as { content?: unknown }
      : null;
    const content = record?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = partText(part);
        if (text !== null) {
          total += estimateTokens(text);
        } else if (isImagePart(part)) {
          total += IMAGE_TOKEN_OVERHEAD;
        } else {
          total += framedFileTokens(part);
        }
      }
    } else if (typeof content === "string") {
      total += estimateTokens(content);
    } else if (content !== undefined && content !== null) {
      // A non-string, non-array payload still costs context. Serializing is the only estimate
      // available, and a value that cannot be serialized (a cycle, a BigInt) contributes none
      // rather than throwing out of the caller's derived.
      try {
        total += estimateTokens(JSON.stringify(content) ?? "");
      } catch {
        // Unserializable payload: counted as its message overhead only.
      }
    }
    if (record) {
      const linkage = toolLinkageText(record);
      if (linkage) total += estimateTokens(linkage);
    }
  }
  return total + Math.ceil(msgs.length * PER_MESSAGE_OVERHEAD);
}
