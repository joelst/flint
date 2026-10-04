/**
 * Context-size estimation for the Playground's token meter.
 *
 * This is a display heuristic, not a tokenizer: Foundry Local exposes no tokenizer to the
 * frontend, so the meter approximates. It feeds a `$derived` read by the whole chat view,
 * so every shape that is not what this expects contributes what it can and nothing else
 * rather than throwing and blanking the Playground over a number.
 *
 * It expects *prompt* messages — what `normalizeForAlternatingChat` produces, where every
 * part is already `text` or `image_url`. Composer-only parts such as `file_text` have been
 * flattened into their framed prompt text by then, so there is deliberately no branch for
 * them: a raw file body is not what gets sent, and counting it here would estimate text
 * the model never receives.
 */

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

function isImagePart(part: unknown): boolean {
  return typeof part === "object"
    && part !== null
    && (part as { type?: unknown }).type === "image_url";
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
    const content = typeof message === "object" && message !== null
      ? (message as { content?: unknown }).content
      : undefined;
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = partText(part);
        if (text !== null) {
          total += estimateTokens(text);
        } else if (isImagePart(part)) {
          total += IMAGE_TOKEN_OVERHEAD;
        }
      }
      continue;
    }
    if (typeof content === "string") {
      total += estimateTokens(content);
      continue;
    }
    // A non-string, non-array payload still costs context. Serializing is the only estimate
    // available, and a value that cannot be serialized (a cycle, a BigInt) contributes none
    // rather than throwing out of the caller's derived.
    if (content === undefined || content === null) continue;
    try {
      total += estimateTokens(JSON.stringify(content) ?? "");
    } catch {
      // Unserializable payload: counted as its message overhead only.
    }
  }
  return total + Math.ceil(msgs.length * PER_MESSAGE_OVERHEAD);
}
