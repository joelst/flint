/**
 * Fit a chat request to a token budget. The turn slider is a ceiling, not this budget.
 * The meter keeps the unscaled estimator. This multiplies by 1.15 so a short count drops
 * history instead of overrunning the model.
 */
import {
  estimateTokens,
  estimateTokensCeiling,
  estimateTokensForMessages,
  IMAGE_TOKEN_OVERHEAD,
  maxCharsWithinTokenCeiling,
} from './token-estimate';
import {
  FENCE_FRAMING_CHARS,
  FETCH_BODY_CHARS,
  IMAGE_LABEL_CHARS,
  MAX_FENCED_RESULT_CHARS,
  SEARCH_URL_CHARS,
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
 * A user message plus the non-user messages that follow it.
 * A non-user message whose question is not in this list is its own turn,
 * so a pinned or summary question can still keep its answer alone.
 */
function userLedTurns<T extends PackableMessage>(messages: readonly T[]): T[][] {
  const turns: T[][] = [];
  let current: T[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      if (current.length > 0) turns.push(current);
      current = [message];
      continue;
    }
    if (current.length > 0 && current[0]?.role === 'user') {
      current.push(message);
      continue;
    }
    turns.push([message]);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/** Keep a turn only when every message in it fits. A partial turn would orphan its answer. */
function keepWholeTurns<T extends PackableMessage>(
  messages: readonly T[],
  within: (candidate: T[]) => boolean,
  prefix: readonly T[],
  suffix: readonly T[],
): T[] {
  const kept: T[] = [];
  for (const turn of [...userLedTurns(messages)].reverse()) {
    if (within([...prefix, ...turn, ...kept, ...suffix])) kept.unshift(...turn);
  }
  return kept;
}

/**
 * One assistant `tool_calls` entry and the tool message that answers it.
 * The call carries a 64-character id, `web_fetch`, and a URL argument at the
 * search length cap. The result carries the same id and name, not a second URL.
 * Each is scaled once, plus one message overhead.
 */
function webToolCallReserve(): number {
  const scaled = (text: string) => (
    Math.ceil(estimateTokens(text) * PACKER_SAFETY_FACTOR) + Math.ceil(1.5)
  );
  const call = [
    'c'.repeat(64),
    'web_fetch',
    JSON.stringify({ url: 'u'.repeat(SEARCH_URL_CHARS) }),
  ].join('\n');
  const result = ['c'.repeat(64), 'web_fetch'].join('\n');
  return scaled(call) + scaled(result);
}

/**
 * The short pair a one-call round keeps for a call it does not run: id, name,
 * and `{}` on the assistant side, and the tool message id, name, and error.
 * The assistant message overhead is already in `webToolCallReserve`.
 */
export function rejectedWebCallReserve(): number {
  const assistant = ['c'.repeat(64), 'web_fetch', '{}'].join('\n');
  const tool = [
    'c'.repeat(64),
    'web_fetch',
    JSON.stringify({ error: 'Only one web result fits this context.' }),
  ].join('\n');
  return Math.ceil(estimateTokens(assistant) * PACKER_SAFETY_FACTOR)
    + Math.ceil(estimateTokens(tool) * PACKER_SAFETY_FACTOR)
    + Math.ceil(1.5);
}

/**
 * Tokens held back for tool results that have not arrived.
 * Until a smaller `maxChars` is chosen, `fencedChars` is `MAX_FENCED_RESULT_CHARS`.
 * Each remaining round may still make two calls, and each call keeps its tool-call
 * linkage as well as the fenced page. The 1.15 factor is applied once here,
 * because a returned page is measured with that same factor.
 */
export function pendingWebReserve(input: {
  roundsRemaining: number;
  fencedChars: number;
  reserveImage?: boolean;
}): number {
  const slots = Math.max(0, Math.floor(input.roundsRemaining)) * 2;
  const perResult = Math.ceil(
    estimateTokensCeiling(input.fencedChars) * PACKER_SAFETY_FACTOR,
  ) + webToolCallReserve();
  const image = input.reserveImage ? Math.ceil(IMAGE_TOKEN_OVERHEAD * PACKER_SAFETY_FACTOR) : 0;
  return slots * perResult + image;
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
  const image = input.reserveImage ? Math.ceil(IMAGE_TOKEN_OVERHEAD * PACKER_SAFETY_FACTOR) : 0;
  const available = Math.max(
    0,
    context - generationReserve(context, input.maxTokens) - image - Math.max(0, input.occupiedTokens),
  );
  const slots = Math.max(1, Math.max(0, Math.floor(input.roundsRemaining)) * 2);
  // `occupiedTokens` is already scaled. The fence is the longest one whose
  // scaled token ceiling fits in one slot.
  const perSlot = Math.floor(available / slots);
  const fenced = maxCharsWithinTokenCeiling(Math.floor(perSlot / PACKER_SAFETY_FACTOR));
  const chars = fenced - FENCE_FRAMING_CHARS;
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
  /** Already included in occupiedTokens. Subtracted once from the message budget. */
  schemaTokens?: number;
}): {
  maxChars: number;
  reserveTokens: number;
  promptTokens: number;
  fencedChars: number;
  toolsViable: boolean;
  maxToolCalls: number;
} {
  const context = input.contextTokens && input.contextTokens > 0
    ? input.contextTokens
    : UNKNOWN_CONTEXT_TOKENS;
  const generation = generationReserve(context, input.maxTokens);
  const image = input.reserveImage ? Math.ceil(IMAGE_TOKEN_OVERHEAD * PACKER_SAFETY_FACTOR) : 0;
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
    fencedChars = maxChars + FENCE_FRAMING_CHARS + IMAGE_LABEL_CHARS;
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
  // One 280-character fence, scaled once. Image cost is already out of `available`.
  // A round that will not call tools needs no further result, so that fit stays viable.
  const minimumFenceTokens = Math.ceil(
    estimateTokensCeiling(280 + FENCE_FRAMING_CHARS + IMAGE_LABEL_CHARS) * PACKER_SAFETY_FACTOR,
  ) + webToolCallReserve();
  // A round may return two calls. Offer tools when one fence fits, and say how many.
  let maxToolCalls = 0;
  let toolsViable = true;
  if (input.roundsRemaining <= 0) {
    maxToolCalls = 0;
    toolsViable = true;
  } else if (reserveRoom >= 2 * minimumFenceTokens) {
    maxToolCalls = 2;
    toolsViable = true;
  } else if (reserveRoom >= minimumFenceTokens + rejectedWebCallReserve()) {
    maxToolCalls = 1;
    toolsViable = true;
  } else {
    maxToolCalls = 0;
    toolsViable = false;
  }
  const rawSchema = input.schemaTokens ?? 0;
  const schemaTokens = Number.isFinite(rawSchema) && rawSchema > 0 ? rawSchema : 0;
  return {
    maxChars,
    fencedChars,
    reserveTokens,
    promptTokens: Math.max(0, available - reserveTokens - schemaTokens),
    toolsViable,
    maxToolCalls,
  };
}

function shortenOneText(text: string, closer: string, bodyChars: number): { text: string; shortened: boolean } {
  if (!text.includes(closer)) return { text, shortened: false };
  const cut = shortenWebEnvelopes(text, closer, bodyChars);
  return cut.shortened ? { text: cut.text, shortened: true } : { text, shortened: false };
}

function shortenFenced<T extends PackableMessage>(
  message: T,
  closer: string | undefined,
  bodyChars: number,
): { message: T; shortened: boolean } {
  if (!closer) return { message, shortened: false };
  const content = message.content;
  if (typeof content === 'string') {
    const cut = shortenOneText(content, closer, bodyChars);
    if (!cut.shortened) return { message, shortened: false };
    return { message: { ...message, content: cut.text }, shortened: true };
  }
  if (!Array.isArray(content)) return { message, shortened: false };
  let shortened = false;
  const next = content.map((part) => {
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'text') return part;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== 'string') return part;
    const cut = shortenOneText(text, closer, bodyChars);
    if (!cut.shortened) return part;
    shortened = true;
    return { ...(part as object), text: cut.text };
  });
  if (!shortened) return { message, shortened: false };
  return { message: { ...message, content: next }, shortened: true };
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
  const keptHistory = keepWholeTurns(
    history,
    within,
    [...keptSummaries, ...keptPinned],
    chosen,
  );
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
  const keptMiddle = keepWholeTurns(middle, within, keptHead, keptTail);
  return {
    messages: [...keptHead, ...keptMiddle, ...keptTail],
    shortened,
    omittedHistory: middle.length - keptMiddle.length,
    contextFull: false,
  };
}
