/**
 * Live checks against Flint's local OpenAI-compatible gateway.
 * Blocked (not failed) when no endpoint or no cached chat model is available.
 * A catalog tool-calling flag is not a Flint verification.
 */

import type {
  EndpointModelClassifier,
  EndpointModelKind,
} from './endpoint-model-classification';

export type SelfTestStatus = 'pass' | 'fail' | 'blocked';

export interface SelfTestCheck {
  id: string;
  title: string;
  status: SelfTestStatus;
  detail: string;
  /** Endpoint model name this check called. Envelope-level checks omit it. */
  modelId?: string;
}

export interface SelfTestReport {
  ranAt: string;
  endpoint: string | null;
  /** First chat id, kept so a one-model report still names its target. */
  modelId: string | null;
  modelIds: string[];
  embeddingModelId: string | null;
  embeddingModelIds: string[];
  speechModelIds: string[];
  checks: SelfTestCheck[];
}

export interface FlintVerifiedAlias {
  modelId: string;
  kind: 'chat' | 'embed' | 'speech';
  chat: boolean;
  stream: boolean;
  usage: boolean;
  embeddings: boolean;
  speech: boolean;
  tools: 'verified' | 'not-verified';
}

export interface FlintVerified {
  modelId: string;
  embeddingModelId: string | null;
  ranAt: string;
  chat: boolean;
  stream: boolean;
  usage: boolean;
  disconnect: boolean;
  embeddings: boolean;
  tools: 'verified' | 'not-verified';
  /** One row per endpoint name the run actually called. */
  aliases: FlintVerifiedAlias[];
}

// Gateway autoload runs inside the chat request. A cold load of a cached
// multi-gigabyte model has to finish, then produce the completion, inside this
// deadline.
const REQUEST_TIMEOUT_MS = 60_000;
const DISCONNECT_START_MS = 2_000;
const ABORT_SETTLE_TIMEOUT_MS = 1_000;

function check(
  id: string,
  title: string,
  status: SelfTestStatus,
  detail: string,
  modelId?: string,
): SelfTestCheck {
  return modelId ? { id, title, status, detail, modelId } : { id, title, status, detail };
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function passed(report: SelfTestReport, id: string): boolean {
  return report.checks.some((item) => item.id === id && item.status === 'pass');
}

function passedFor(report: SelfTestReport, id: string, modelId: string): boolean {
  return report.checks.some((item) => item.id === id && item.modelId === modelId && item.status === 'pass');
}

function toolsLabel(report: SelfTestReport, modelId: string | null): 'verified' | 'not-verified' {
  const toolsCheck = report.checks.find((item) => item.id === 'tools'
    && (modelId == null || item.modelId === modelId));
  return toolsCheck?.status === 'pass' ? 'verified' : 'not-verified';
}

export function flintVerifiedFromReport(report: SelfTestReport): FlintVerified | null {
  // A failed /v1/models envelope is not a verified endpoint. Chat/stream can still
  // have run against a UI alias; do not mint a badge from that.
  if (!passed(report, 'models')) return null;
  const aliasIds: string[] = [];
  for (const item of report.checks) {
    if (item.modelId && !aliasIds.includes(item.modelId)) aliasIds.push(item.modelId);
  }
  const id = report.modelId || report.embeddingModelId || report.speechModelIds[0] || null;
  if (!id) return null;
  const aliases = aliasIds.map((modelId) => ({
    modelId,
    kind: (report.checks.some((item) => item.modelId === modelId && item.id === 'embeddings')
      ? 'embed'
      : report.checks.some((item) => item.modelId === modelId && item.id === 'speech')
        ? 'speech'
        : 'chat') as 'chat' | 'embed' | 'speech',
    chat: passedFor(report, 'chat', modelId),
    stream: passedFor(report, 'stream', modelId),
    usage: passedFor(report, 'usage', modelId),
    embeddings: passedFor(report, 'embeddings', modelId),
    speech: passedFor(report, 'speech', modelId),
    tools: toolsLabel(report, modelId),
  }));
  return {
    modelId: id,
    embeddingModelId: report.embeddingModelId,
    ranAt: report.ranAt,
    chat: report.modelId ? passedFor(report, 'chat', report.modelId) : passed(report, 'chat'),
    stream: report.modelId ? passedFor(report, 'stream', report.modelId) : passed(report, 'stream'),
    usage: report.modelId ? passedFor(report, 'usage', report.modelId) : passed(report, 'usage'),
    disconnect: passed(report, 'disconnect'),
    embeddings: passed(report, 'embeddings'),
    tools: toolsLabel(report, report.modelId),
    aliases,
  };
}

/** Groups checks in list order, splitting when the endpoint name changes. */
export function groupSelfTestChecks(checks: SelfTestCheck[]): Array<{ modelId: string | null; checks: SelfTestCheck[] }> {
  const groups: Array<{ modelId: string | null; checks: SelfTestCheck[] }> = [];
  for (const item of checks) {
    const modelId = item.modelId ?? null;
    const last = groups[groups.length - 1];
    if (last && last.modelId === modelId) last.checks.push(item);
    else groups.push({ modelId, checks: [item] });
  }
  return groups;
}

export function matchesVerifiedModel(modelId: string, alias: string | null | undefined): boolean {
  if (!alias) return false;
  const id = modelId.toLowerCase();
  const name = alias.toLowerCase();
  return id === name || id.startsWith(`${name}-`);
}

export interface ListedEndpointModel {
  id: string;
  parent: string | null;
}

function isEmbeddingModelId(id: string): boolean {
  return /embed/i.test(id);
}

function isSpeechModelId(id: string): boolean {
  return /(whisper|-stt(?:-|$)|(?:^|-)stt-|parakeet|nemotron-speech)/i.test(id);
}

function endpointKind(
  id: string,
  requestedEmbed: string | null,
  parent: string | null = null,
  classifyModel?: EndpointModelClassifier,
): EndpointModelKind {
  const classified = classifyModel?.(id, parent);
  if (classified) return classified;
  if (
    requestedEmbed
    && (
      matchesVerifiedModel(id, requestedEmbed)
      || parent?.toLowerCase() === requestedEmbed.toLowerCase()
    )
  ) return 'embed';
  if (isEmbeddingModelId(id)) return 'embed';
  if (isSpeechModelId(id) || (parent && isSpeechModelId(parent))) return 'speech';
  return 'chat';
}

/**
 * Every name a client can send: each listed variant id, then each distinct
 * parent alias that is not already one of those ids.
 */
export function endpointAliases(
  models: ListedEndpointModel[],
  requestedEmbed: string | null,
  classifyModel?: EndpointModelClassifier,
): { chat: string[]; embed: string[]; speech: string[] } {
  const embed: string[] = [];
  const speech: string[] = [];
  const chat: string[] = [];
  const seen = new Set<string>();
  const add = (id: string, kind = endpointKind(id, requestedEmbed, null, classifyModel)) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (kind === 'embed') embed.push(id);
    else if (kind === 'speech') speech.push(id);
    else chat.push(id);
  };
  for (const row of models) {
    add(row.id, endpointKind(row.id, requestedEmbed, row.parent, classifyModel));
  }
  for (const row of models) {
    if (row.parent) {
      add(row.parent, endpointKind(row.id, requestedEmbed, row.parent, classifyModel));
    }
  }
  return { chat, embed, speech };
}

function listedModels(body: { data?: Array<{ id?: string; parent?: string }> } | null): ListedEndpointModel[] {
  const out: ListedEndpointModel[] = [];
  for (const row of body?.data ?? []) {
    if (typeof row?.id !== 'string' || !row.id) continue;
    const parent = typeof row.parent === 'string' && row.parent.trim() ? row.parent.trim() : null;
    out.push({ id: row.id, parent });
  }
  return out;
}

function groupedTargets(
  ids: string[],
  kind: EndpointModelKind,
  models: ListedEndpointModel[],
): Array<{ modelId: string; kind: EndpointModelKind; residencyModelId: string; restoreAfter: boolean }> {
  const groups = new Map<string, Array<{ modelId: string; residencyModelId: string }>>();
  for (const modelId of ids) {
    const normalizedId = modelId.toLowerCase();
    const row = models.find((item) => item.id.toLowerCase() === normalizedId);
    const parent = row?.parent
      ?? models.find((item) => item.parent?.toLowerCase() === normalizedId)?.parent
      ?? modelId;
    const key = parent.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push({ modelId, residencyModelId: parent });
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => group.map((target, index) => ({
    ...target,
    kind,
    restoreAfter: index === group.length - 1,
  })));
}

function blockedChatChecks(detail: string): SelfTestCheck[] {
  return [
    check('chat', 'Returned model id round-trips into chat', 'blocked', detail),
    check('stream', 'Streaming delivers a token and [DONE]', 'blocked', detail),
    check('usage', 'usage is present when the model emits it', 'blocked', detail),
    check('disconnect', 'Aborting a stream settles the caller', 'blocked', detail),
    check('tools', 'tool_calls when prompted', 'blocked', detail),
  ];
}

function noChatModelChecks(): SelfTestCheck[] {
  return [
    check('chat', 'Returned model id round-trips into chat', 'blocked', 'Download a chat model, then run the test again.'),
    check('stream', 'Streaming delivers a token and [DONE]', 'blocked', 'Needs a cached chat model.'),
    check('usage', 'usage is present when the model emits it', 'blocked', 'Needs a cached chat model.'),
    check('disconnect', 'Aborting a stream settles the caller', 'blocked', 'Needs a cached chat model.'),
    check('tools', 'tool_calls when prompted', 'blocked', 'Needs a cached chat model.'),
  ];
}

function modelsEnvelopeData(json: unknown): unknown[] | null {
  if (!json || typeof json !== 'object') return null;
  const data = (json as { data?: unknown }).data;
  return Array.isArray(data) ? data : null;
}

function failureDetail(status: number, json: unknown, fallback: string): string {
  const message = json && typeof json === 'object'
    ? (json as { error?: { message?: unknown } }).error?.message
    : null;
  const reason = typeof message === 'string' && message.trim() ? message.trim() : fallback;
  return `HTTP ${status}; ${reason}`;
}

function isNumericVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function streamHasToken(text: string): boolean {
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const json = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
      };
      const content = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.length > 0) return true;
    } catch {
      // Non-JSON data lines are not a token.
    }
  }
  return false;
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

function whenAborted(signal: AbortSignal, error: Error): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(error);
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

async function fetchAndRead(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  read: 'json' | 'text',
): Promise<{ res: Response; json: unknown; text: string }> {
  const timeout = new AbortController();
  const timedOut = new Error(`Timed out after ${timeoutMs} ms`);
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const res = await Promise.race([
      fetchFn(url, { ...init, signal: mergeSignals(init.signal ?? undefined, timeout.signal) }),
      whenAborted(timeout.signal, timedOut),
    ]);
    const abortBody = () => {
      try {
        const cancel = res.body && !res.body.locked ? res.body.cancel() : null;
        if (cancel && typeof cancel.catch === 'function') void cancel.catch(() => {});
      } catch { /* already closed or locked */ }
    };
    timeout.signal.addEventListener('abort', abortBody, { once: true });
    if (timeout.signal.aborted) abortBody();
    if (read === 'text') {
      const text = await Promise.race([res.text(), whenAborted(timeout.signal, timedOut)]);
      return { res, json: null, text };
    }
    const json = await Promise.race([res.json().catch(() => null), whenAborted(timeout.signal, timedOut)]);
    return { res, json, text: '' };
  } catch (error) {
    if (timeout.signal.aborted) throw timedOut;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function tinyWav(): Blob {
  const samples = 160;
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

function declaredToolCalling(
  modelId: string,
  options: {
    catalogSupportsToolCalling?: boolean | null;
    supportsToolCalling?: (modelId: string) => boolean | null | undefined;
  },
): boolean | null {
  if (options.supportsToolCalling) {
    const specific = options.supportsToolCalling(modelId);
    if (specific === true || specific === false) return specific;
    return null;
  }
  if (options.catalogSupportsToolCalling === false) return false;
  if (options.catalogSupportsToolCalling === true) return true;
  return null;
}

async function runEmbeddingChecks(
  fetchFn: typeof fetch,
  endpoint: string,
  modelId: string,
  requestTimeoutMs: number,
): Promise<SelfTestCheck[]> {
  try {
    const { res, json } = await fetchAndRead(
      fetchFn,
      joinUrl(endpoint, '/embeddings'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, input: 'ping' }),
      },
      requestTimeoutMs,
      'json',
    );
    const embeddingJson = json && typeof json === 'object'
      ? json as { data?: Array<{ embedding?: unknown }> }
      : null;
    const vector = embeddingJson?.data?.[0]?.embedding;
    if (!res.ok || !isNumericVector(vector)) {
      return [check(
        'embeddings',
        'POST /v1/embeddings returns a vector',
        'fail',
        failureDetail(res.status, json, 'expected data[0].embedding number[].'),
        modelId,
      )];
    }
    return [check(
      'embeddings',
      'POST /v1/embeddings returns a vector',
      'pass',
      `${vector.length}-d vector from ${modelId}.`,
      modelId,
    )];
  } catch (error) {
    return [check(
      'embeddings',
      'POST /v1/embeddings returns a vector',
      'fail',
      error instanceof Error ? error.message : String(error),
      modelId,
    )];
  }
}

async function runSpeechChecks(
  fetchFn: typeof fetch,
  endpoint: string,
  modelId: string,
  requestTimeoutMs: number,
  prepareModel?: (modelId: string) => Promise<string>,
): Promise<SelfTestCheck[]> {
  try {
    if (!prepareModel) {
      return [check(
        'speech',
        'POST /v1/audio/transcriptions returns text',
        'blocked',
        'Speech checks require model preparation because multipart requests cannot be gateway-replayed.',
        modelId,
      )];
    }
    const preparedModelId = await prepareModel(modelId);
    if (!preparedModelId.trim()) {
      throw new Error(`Speech model preparation returned no canonical variant for ${modelId}.`);
    }
    const form = new FormData();
    form.append('model', preparedModelId);
    form.append('file', tinyWav(), 'ping.wav');
    const { res, json } = await fetchAndRead(
      fetchFn,
      joinUrl(endpoint, '/audio/transcriptions'),
      { method: 'POST', body: form },
      requestTimeoutMs,
      'json',
    );
    const text = json && typeof json === 'object' ? (json as { text?: unknown }).text : null;
    if (!res.ok || typeof text !== 'string') {
      return [check(
        'speech',
        'POST /v1/audio/transcriptions returns text',
        'fail',
        failureDetail(res.status, json, 'no transcript.'),
        modelId,
      )];
    }
    return [check(
      'speech',
      'POST /v1/audio/transcriptions returns text',
      'pass',
      preparedModelId === modelId
        ? `${modelId} transcribed audio.`
        : `${modelId} resolved to ${preparedModelId} and transcribed audio.`,
      modelId,
    )];
  } catch (error) {
    return [check(
      'speech',
      'POST /v1/audio/transcriptions returns text',
      'fail',
      error instanceof Error ? error.message : String(error),
      modelId,
    )];
  }
}

async function runChatChecks(
  fetchFn: typeof fetch,
  endpoint: string,
  modelId: string,
  requestTimeoutMs: number,
  toolsDeclared: boolean | null,
): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];
  let usageSeen = false;
  try {
    const { res, json } = await fetchAndRead(
      fetchFn,
      joinUrl(endpoint, '/chat/completions'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply with the single word ping.' }],
          stream: false,
          max_tokens: 8,
        }),
      },
      requestTimeoutMs,
      'json',
    );
    const payload = json as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, unknown> } | null;
    const content = payload?.choices?.[0]?.message?.content;
    const usage = payload?.usage;
    if (!res.ok || typeof content !== 'string' || !content.trim()) {
      checks.push(check('chat', 'Returned model id round-trips into chat', 'fail', failureDetail(res.status, json, 'no assistant message.'), modelId));
    } else {
      usageSeen = !!(usage && (usage.prompt_tokens != null || usage.completion_tokens != null
        || usage.input_tokens != null || usage.output_tokens != null));
      checks.push(check('chat', 'Returned model id round-trips into chat', 'pass', `id ${modelId} produced a completion.`, modelId));
    }
  } catch (error) {
    checks.push(check(
      'chat',
      'Returned model id round-trips into chat',
      'fail',
      error instanceof Error ? error.message : String(error),
      modelId,
    ));
  }

  if (usageSeen) {
    checks.push(check('usage', 'usage is present when the model emits it', 'pass', 'Non-streamed completion included usage.', modelId));
  } else {
    checks.push(check(
      'usage',
      'usage is present when the model emits it',
      'blocked',
      'This model did not emit usage; not treated as a failure.',
      modelId,
    ));
  }

  try {
    const { res, text } = await fetchAndRead(
      fetchFn,
      joinUrl(endpoint, '/chat/completions'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply with the single word ping.' }],
          stream: true,
          max_tokens: 8,
        }),
      },
      requestTimeoutMs,
      'text',
    );
    const hasDone = text.includes('[DONE]');
    const hasToken = streamHasToken(text);
    if (!res.ok || !hasDone || !hasToken) {
      checks.push(check('stream', 'Streaming delivers a token and [DONE]', 'fail', `HTTP ${res.status}; done=${hasDone} token=${hasToken}.`, modelId));
    } else {
      checks.push(check('stream', 'Streaming delivers a token and [DONE]', 'pass', 'SSE stream terminated with [DONE].', modelId));
    }
  } catch (error) {
    checks.push(check(
      'stream',
      'Streaming delivers a token and [DONE]',
      'fail',
      error instanceof Error ? error.message : String(error),
      modelId,
    ));
  }

  if (toolsDeclared === false) {
    checks.push(check(
      'tools',
      'tool_calls when prompted',
      'blocked',
      'Catalog declares no tool calling; Flint-verified remains not-verified.',
      modelId,
    ));
  } else {
    try {
      const { res, json } = await fetchAndRead(
        fetchFn,
        joinUrl(endpoint, '/chat/completions'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'Call the echo tool with text ping.' }],
            tools: [{
              type: 'function',
              function: {
                name: 'echo',
                description: 'Echo text',
                parameters: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            }],
            max_tokens: 32,
          }),
        },
        requestTimeoutMs,
        'json',
      );
      const payload = json as {
        choices?: Array<{ message?: { tool_calls?: unknown }; delta?: { tool_calls?: unknown } }>;
      } | null;
      const toolCalls = payload?.choices?.[0]?.message?.tool_calls
        ?? payload?.choices?.[0]?.delta?.tool_calls;
      if (res.ok && Array.isArray(toolCalls) && toolCalls.length > 0) {
        checks.push(check('tools', 'tool_calls when prompted', 'pass', 'Model emitted OpenAI-style tool_calls.', modelId));
      } else {
        checks.push(check(
          'tools',
          'tool_calls when prompted',
          'blocked',
          res.ok
            ? 'No tool_calls in the response; labeled not-verified rather than failed.'
            : `HTTP ${res.status}; labeled not-verified rather than failed.`,
          modelId,
        ));
      }
    } catch (error) {
      checks.push(check(
        'tools',
        'tool_calls when prompted',
        'blocked',
        `Could not verify tools (${error instanceof Error ? error.message : String(error)}).`,
        modelId,
      ));
    }
  }

  return checks;
}

async function runDisconnectCheck(
  fetchFn: typeof fetch,
  endpoint: string,
  modelId: string,
  requestStartMs: number,
  disconnectStartMs: number,
): Promise<SelfTestCheck> {
  try {
    const abort = new AbortController();
    const pending = fetchFn(joinUrl(endpoint, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Keep writing until stopped.' }],
        stream: true,
        max_tokens: 64,
      }),
      signal: abort.signal,
    });
    // Wait until headers (and a first body chunk, if any) so this is a disconnect of
    // an in-flight stream, not a cancel of a request that never left the client.
    const started = await Promise.race([
      pending.then((res) => ({ kind: 'headers' as const, res })).catch((error) => ({ kind: 'error' as const, error })),
      new Promise<{ kind: 'slow' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'slow' }), requestStartMs);
      }),
    ]);
    if (started.kind !== 'headers') {
      abort.abort();
      return check(
        'disconnect',
        'Aborting a stream settles the caller',
        'fail',
        started.kind === 'error'
          ? (started.error instanceof Error ? started.error.message : String(started.error))
          : `Streaming response did not start within ${requestStartMs} ms; disconnect was not exercised.`,
      );
    }

    if (!started.res.ok) {
      abort.abort();
      return check(
        'disconnect',
        'Aborting a stream settles the caller',
        'fail',
        `HTTP ${started.res.status}; streaming response did not start.`,
      );
    }

    const reader = started.res.body?.getReader() ?? null;
    if (!reader) {
      abort.abort();
      return check(
        'disconnect',
        'Aborting a stream settles the caller',
        'fail',
        'Streaming response had no readable body; disconnect was not exercised.',
      );
    }

    const pendingRead = reader.read().then(() => 'read' as const, () => 'rejected' as const);
    await Promise.race([
      pendingRead,
      new Promise<void>((resolve) => {
        setTimeout(resolve, disconnectStartMs);
      }),
    ]);
    abort.abort();

    const settled = await Promise.race([
      pendingRead.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), ABORT_SETTLE_TIMEOUT_MS);
      }),
    ]);
    return check(
      'disconnect',
      'Aborting a stream settles the caller',
      settled === 'timeout' ? 'fail' : 'pass',
      settled === 'timeout'
        ? `Abort did not settle the stream body within ${ABORT_SETTLE_TIMEOUT_MS} ms.`
        : 'Stream started and abort settled the body reader. Native generation may still finish.',
    );
  } catch (error) {
    return check(
      'disconnect',
      'Aborting a stream settles the caller',
      'fail',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function runEndpointSelfTest(options: {
  fetch: typeof fetch;
  endpoint: string | null;
  modelId?: string | null;
  catalogSupportsToolCalling?: boolean | null;
  /** Per listed id. When set, it replaces catalogSupportsToolCalling. */
  supportsToolCalling?: (modelId: string) => boolean | null | undefined;
  embeddingModelId?: string | null;
  /** Per listed model. Catalog metadata should take precedence over name heuristics. */
  classifyModel?: EndpointModelClassifier;
  /**
   * Explicitly prepares each speech target and returns its canonical loaded variant because
   * multipart requests cannot be gateway-replayed or rewritten.
   */
  prepareSpeechModel?: (modelId: string) => Promise<string>;
  /** Restores or unloads a model after its ordinary probes complete. */
  afterModelProbe?: (modelId: string) => Promise<void>;
  /** Prefer an already-resident chat alias for the terminal disconnect probe. */
  disconnectModelId?: string | null;
  requestTimeoutMs?: number;
  disconnectStartMs?: number;
  onProgress?: (event: { modelId: string; index: number; total: number }) => void;
}): Promise<SelfTestReport> {
  const ranAt = new Date().toISOString();
  const endpoint = options.endpoint?.trim() || null;
  const requestedModel = options.modelId?.trim() || null;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const disconnectStartMs = options.disconnectStartMs ?? DISCONNECT_START_MS;
  const disconnectRequestStartMs = options.disconnectStartMs == null
    ? requestTimeoutMs
    : disconnectStartMs;

  if (!endpoint) {
    return {
      ranAt,
      endpoint: null,
      modelId: requestedModel,
      modelIds: [],
      embeddingModelId: null,
      embeddingModelIds: [],
      speechModelIds: [],
      checks: [
        check('endpoint', 'Local gateway reachable', 'blocked', 'Start the local service first.'),
      ],
    };
  }

  const checks: SelfTestCheck[] = [];
  let modelsBody: { data?: Array<{ id?: string; parent?: string }> } | null = null;

  try {
    const { res, json } = await fetchAndRead(
      options.fetch,
      joinUrl(endpoint, '/models'),
      { method: 'GET', headers: { Accept: 'application/json' } },
      requestTimeoutMs,
      'json',
    );
    const data = modelsEnvelopeData(json);
    if (!res.ok || !data) {
      checks.push(check(
        'models',
        'GET /v1/models returns an OpenAI envelope',
        'fail',
        `HTTP ${res.status}; expected { data: [...] }.`,
      ));
    } else {
      modelsBody = json as { data?: Array<{ id?: string; parent?: string }> };
      checks.push(check(
        'models',
        'GET /v1/models returns an OpenAI envelope',
        'pass',
        `${data.length} model id(s).`,
      ));
    }
  } catch (error) {
    checks.push(check(
      'models',
      'GET /v1/models returns an OpenAI envelope',
      'fail',
      error instanceof Error ? error.message : String(error),
    ));
  }

  const modelsOk = checks.some((item) => item.id === 'models' && item.status === 'pass');
  const requestedEmbed = options.embeddingModelId?.trim() || null;
  const listed = modelsOk ? listedModels(modelsBody) : [];
  const aliases = modelsOk
    ? endpointAliases(listed, requestedEmbed, options.classifyModel)
    : { chat: [], embed: [], speech: [] };
  const emptyIds = { modelIds: [] as string[], embeddingModelIds: [] as string[], speechModelIds: [] as string[] };

  if (!modelsOk) {
    const blocked = 'GET /v1/models did not return an OpenAI envelope.';
    checks.push(check('embeddings', 'POST /v1/embeddings returns a vector', 'blocked', blocked));
    checks.push(...blockedChatChecks(blocked));
    return {
      ranAt,
      endpoint,
      modelId: null,
      embeddingModelId: null,
      ...emptyIds,
      checks,
    };
  }

  const queue = [
    ...groupedTargets(aliases.embed, 'embed', listed),
    ...groupedTargets(aliases.chat, 'chat', listed),
    ...groupedTargets(aliases.speech, 'speech', listed),
  ];
  const orderedAliases = {
    embed: queue.filter((target) => target.kind === 'embed').map((target) => target.modelId),
    chat: queue.filter((target) => target.kind === 'chat').map((target) => target.modelId),
    speech: queue.filter((target) => target.kind === 'speech').map((target) => target.modelId),
  };

  if (aliases.embed.length === 0) {
    checks.push(check(
      'embeddings',
      'POST /v1/embeddings returns a vector',
      'blocked',
      'Import a BYOM embedding model, then run the test again.',
    ));
  }

  let index = 0;
  const requestedDisconnectModel = options.disconnectModelId?.trim() || null;
  const matchingDisconnectModel = requestedDisconnectModel
    ? orderedAliases.chat.find((modelId) => modelId.toLowerCase() === requestedDisconnectModel.toLowerCase())
    : null;
  const disconnectModelId = matchingDisconnectModel
    ? matchingDisconnectModel
    : orderedAliases.chat[orderedAliases.chat.length - 1] ?? null;
  const progressTotal = queue.length + (disconnectModelId ? 1 : 0);
  let residencyRestoreFailed = false;
  for (const target of queue) {
    options.onProgress?.({ modelId: target.modelId, index, total: progressTotal });
    index += 1;
    if (target.kind === 'embed') {
      checks.push(...await runEmbeddingChecks(options.fetch, endpoint, target.modelId, requestTimeoutMs));
    } else if (target.kind === 'chat') {
      checks.push(...await runChatChecks(
        options.fetch,
        endpoint,
        target.modelId,
        requestTimeoutMs,
        declaredToolCalling(target.modelId, options),
      ));
    } else {
      checks.push(...await runSpeechChecks(
        options.fetch,
        endpoint,
        target.modelId,
        requestTimeoutMs,
        options.prepareSpeechModel,
      ));
    }
    if (target.restoreAfter && options.afterModelProbe) {
      try {
        await options.afterModelProbe(target.residencyModelId);
      } catch (error) {
        checks.push(check(
          'residency',
          'Restore model residency after probe',
          'fail',
          error instanceof Error ? error.message : String(error),
          target.residencyModelId,
        ));
        checks.push(check(
          'run',
          'Continue endpoint self-test',
          'blocked',
          'Stopped after residency restoration failed so additional models are not loaded.',
        ));
        residencyRestoreFailed = true;
        break;
      }
    }
  }

  if (disconnectModelId && !residencyRestoreFailed) {
    options.onProgress?.({ modelId: disconnectModelId, index, total: progressTotal });
    checks.push(await runDisconnectCheck(
      options.fetch,
      endpoint,
      disconnectModelId,
      disconnectRequestStartMs,
      disconnectStartMs,
    ));
  } else if (!residencyRestoreFailed) {
    checks.push(...noChatModelChecks());
  }

  return {
    ranAt,
    endpoint,
    modelId: orderedAliases.chat[0] ?? null,
    modelIds: orderedAliases.chat,
    embeddingModelId: orderedAliases.embed[0] ?? null,
    embeddingModelIds: orderedAliases.embed,
    speechModelIds: orderedAliases.speech,
    checks,
  };
}
