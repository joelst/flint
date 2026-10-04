/**
 * Fit a chat request to a token budget. The turn slider is a ceiling, not this budget.
 * The meter keeps the unscaled estimator. This multiplies by 1.15 so a short count drops
 * history instead of overrunning the model.
 */
import { estimateTokens, estimateTokensForMessages, IMAGE_TOKEN_OVERHEAD } from './token-estimate';
import {
  FENCE_FRAMING_CHARS,
  FETCH_BODY_CHARS,
  MAX_FENCED_RESULT_CHARS,
  shortenWebEnvelopes,
} from './web-envelope';

export { IMAGE_TOKEN_OVERHEAD };
export const PACKER_SAFETY_FACTOR = 1.15;
export const UNKNOWN_CONTEXT_TOKENS = 4096;

export interface PackableMessage {
  role?: string;
  content?: unknown;
  pinned?: unknown;
  isSummary?: unknown;
}

export function generationReserve(contextTokens: number, maxTokens: number): number {
  const quarter = Math.floor(contextTokens * 0.25);
  const reply = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : quarter;
  return Math.max(0, Math.min(reply, quarter));
}

export function promptBudget(input: {
  contextTokens: number | null | undefined;
  maxTokens: number;
  reserveTokens?: number;
}): number {
  const context = input.contextTokens && input.contextTokens > 0
    ? input.contextTokens
    : UNKNOWN_CONTEXT_TOKENS;
  const reserve = Math.max(0, input.reserveTokens ?? 0);
  return Math.max(0, context - generationReserve(context, input.maxTokens) - reserve);
}

function scaled(messages: readonly PackableMessage[], system: string): number {
  return Math.ceil((estimateTokens(system) + estimateTokensForMessages(messages)) * PACKER_SAFETY_FACTOR);
}

/**
 * Tokens held back for tool results that have not arrived.
 * Until a smaller `maxChars` is chosen, `fencedChars` is `MAX_FENCED_RESULT_CHARS`.
 * Each remaining round may still make two calls.
 */
export function pendingWebReserve(input: {
  roundsRemaining: number;
  fencedChars: number;
  reserveImage?: boolean;
}): number {
  const slots = Math.max(0, Math.floor(input.roundsRemaining)) * 2;
  const perResult = estimateTokens('x'.repeat(Math.max(0, Math.floor(input.fencedChars))));
  return slots * perResult + (input.reserveImage ? IMAGE_TOKEN_OVERHEAD : 0);
}

/** Characters to ask the helper for. The helper floor is 1,000 and this never asks past one fetch body. */
export function chooseFetchMaxChars(input: {
  contextTokens: number | null | undefined;
  maxTokens: number;
  roundsRemaining: number;
  occupiedTokens: number;
  reserveImage?: boolean;
}): number {
  const context = input.contextTokens && input.contextTokens > 0
    ? input.contextTokens
    : UNKNOWN_CONTEXT_TOKENS;
  const image = input.reserveImage ? IMAGE_TOKEN_OVERHEAD : 0;
  const available = Math.max(
    0,
    context - generationReserve(context, input.maxTokens) - image - Math.max(0, input.occupiedTokens),
  );
  const slots = Math.max(1, Math.max(0, Math.floor(input.roundsRemaining)) * 2);
  const chars = Math.floor(available / slots * 3.9) - FENCE_FRAMING_CHARS;
  if (!Number.isFinite(chars)) return 1_000;
  return Math.min(FETCH_BODY_CHARS, Math.max(1_000, chars));
}

/**
 * Prompt tokens left after the generation reserve and the pending tool reserve.
 * A full fenced page is reserved only when it fits. Otherwise the reserve shrinks
 * to the helper floor, and if that still crowds out the system prompt the leftover
 * room is reserved and the packer shortens the page after it returns.
 */
export function plannedWebFit(input: {
  contextTokens: number | null | undefined;
  maxTokens: number;
  roundsRemaining: number;
  occupiedTokens: number;
  reserveImage?: boolean;
}): { maxChars: number; reserveTokens: number; promptTokens: number; fencedChars: number } {
  const context = input.contextTokens && input.contextTokens > 0
    ? input.contextTokens
    : UNKNOWN_CONTEXT_TOKENS;
  const generation = generationReserve(context, input.maxTokens);
  const image = input.reserveImage ? IMAGE_TOKEN_OVERHEAD : 0;
  const available = Math.max(0, context - generation - image);
  const reserveRoom = Math.max(0, available - Math.max(0, input.occupiedTokens));
  const fullReserve = pendingWebReserve({
    roundsRemaining: input.roundsRemaining,
    fencedChars: MAX_FENCED_RESULT_CHARS,
    reserveImage: false,
  });
  let maxChars = FETCH_BODY_CHARS;
  let fencedChars = MAX_FENCED_RESULT_CHARS;
  if (input.roundsRemaining > 0 && fullReserve > reserveRoom) {
    maxChars = chooseFetchMaxChars(input);
    fencedChars = maxChars + FENCE_FRAMING_CHARS;
  }
  // Image overhead was already removed from `available`. Counting it here would reserve it twice.
  let reserveTokens = pendingWebReserve({
    roundsRemaining: input.roundsRemaining,
    fencedChars,
    reserveImage: false,
  });
  // `occupiedTokens` is the scaled size of the system prompt and the latest user turn
  // (the turns the packer cannot drop). Clamping the tool reserve to the room beside
  // that measurement leaves `promptTokens` large enough for it. A reserve of four full
  // fences does not fit in the 4096-token fallback and must not consume the send.
  if (reserveTokens > reserveRoom) reserveTokens = reserveRoom;
  return {
    maxChars,
    fencedChars,
    reserveTokens,
    promptTokens: Math.max(0, available - reserveTokens),
  };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'text') return '';
    return String((part as { text?: unknown }).text ?? '');
  }).join('\n');
}

function replaceText(content: unknown, next: string): unknown {
  if (typeof content === 'string') return next;
  if (!Array.isArray(content)) return content;
  let used = false;
  return content.map((part) => {
    if (used || !part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'text') return part;
    used = true;
    return { ...(part as object), text: next };
  });
}

function shortenFenced<T extends PackableMessage>(
  message: T,
  closer: string | undefined,
  bodyChars: number,
): { message: T; shortened: boolean } {
  if (!closer) return { message, shortened: false };
  const text = contentText(message.content);
  if (!text.includes(closer)) return { message, shortened: false };
  const cut = shortenWebEnvelopes(text, closer, bodyChars);
  if (!cut.shortened) return { message, shortened: false };
  return { message: { ...message, content: replaceText(message.content, cut.text) }, shortened: true };
}

export function packContextMessages<T extends PackableMessage>(input: {
  messages: readonly T[];
  systemPrompt: string;
  budgetTokens: number;
  closer?: string;
  bodyChars?: number;
  minimumBodyChars?: number;
}): {
  messages: T[];
  shortened: boolean;
  omittedPinned: number;
  omittedSummaries: number;
  contextFull: boolean;
} {
  const minimumBody = input.minimumBodyChars ?? 280;
  const bodyChars = input.bodyChars ?? 20_000;
  const latestIndex = [...input.messages].reverse().findIndex((message) => message.role === 'user');
  const latestAt = latestIndex < 0 ? -1 : input.messages.length - 1 - latestIndex;
  const latest = latestAt >= 0 ? input.messages[latestAt] : undefined;
  const earlier = input.messages.filter((_, index) => index !== latestAt);
  const summaries = earlier.filter((message) => message.isSummary);
  const pinned = earlier.filter((message) => message.pinned && !message.isSummary);
  const history = earlier.filter((message) => !message.pinned && !message.isSummary);

  let shortened = false;
  const fitLatest = (chars: number): T | undefined => {
    if (!latest) return undefined;
    const cut = shortenFenced(latest, input.closer, chars);
    if (cut.shortened) shortened = true;
    return cut.message;
  };

  const within = (messages: T[]) => scaled(messages, input.systemPrompt) <= input.budgetTokens;
  let user = fitLatest(bodyChars) as T | undefined;
  let chosen = user ? [user] : [];
  if (!within(chosen)) {
    user = fitLatest(minimumBody);
    chosen = user ? [user] : [];
    shortened = true;
  }
  if (!within(chosen)) {
    return { messages: [], shortened, omittedPinned: pinned.length, omittedSummaries: summaries.length, contextFull: true };
  }

  const keptSummaries: T[] = [];
  for (const message of summaries) {
    if (within([...keptSummaries, message, ...chosen])) keptSummaries.push(message);
  }
  const keptPinned: T[] = [];
  for (const message of [...pinned].reverse()) {
    if (within([...keptSummaries, ...keptPinned, message, ...chosen])) keptPinned.unshift(message);
  }
  const keptHistory: T[] = [];
  for (const message of [...history].reverse()) {
    if (within([...keptSummaries, ...keptPinned, ...keptHistory, message, ...chosen])) {
      keptHistory.unshift(message);
    }
  }
  return {
    messages: [...keptSummaries, ...keptPinned, ...keptHistory, ...chosen],
    shortened,
    omittedPinned: pinned.length - keptPinned.length,
    omittedSummaries: summaries.length - keptSummaries.length,
    contextFull: false,
  };
}

/**
 * Fit a request that already contains this send's tool results.
 * The first message carries the folded system prompt, and every message from the
 * latest user turn onward (including tool results) stays. Older turns are the only
 * ones that can be left out. Web bodies are shortened before that.
 */
export function repackToolRequest<T extends PackableMessage>(input: {
  messages: readonly T[];
  budgetTokens: number;
  closer?: string;
  bodyChars?: number;
  minimumBodyChars?: number;
}): {
  messages: T[];
  shortened: boolean;
  omittedHistory: number;
  contextFull: boolean;
} {
  const minimumBody = input.minimumBodyChars ?? 280;
  const bodyChars = input.bodyChars ?? 20_000;
  const latestIndex = [...input.messages].reverse().findIndex((message) => message.role === 'user');
  const latestAt = latestIndex < 0 ? 0 : input.messages.length - 1 - latestIndex;
  const head = input.messages.slice(0, Math.min(1, latestAt));
  const middle = input.messages.slice(head.length, latestAt);
  const tail = input.messages.slice(latestAt);
  let shortened = false;
  const shrink = (messages: readonly T[], chars: number): T[] => messages.map((message) => {
    const cut = shortenFenced(message, input.closer, chars);
    if (cut.shortened) shortened = true;
    return cut.message;
  });
  const within = (messages: T[]) => scaled(messages, '') <= input.budgetTokens;
  let keptHead = shrink(head, bodyChars);
  let keptTail = shrink(tail, bodyChars);
  if (!within([...keptHead, ...keptTail])) {
    keptHead = shrink(head, minimumBody);
    keptTail = shrink(tail, minimumBody);
    shortened = true;
  }
  if (!within([...keptHead, ...keptTail])) {
    return { messages: [], shortened, omittedHistory: middle.length, contextFull: true };
  }
  const keptMiddle: T[] = [];
  for (const message of [...middle].reverse()) {
    if (within([...keptHead, ...keptMiddle, message, ...keptTail])) keptMiddle.unshift(message);
  }
  return {
    messages: [...keptHead, ...keptMiddle, ...keptTail],
    shortened,
    omittedHistory: middle.length - keptMiddle.length,
    contextFull: false,
  };
}
