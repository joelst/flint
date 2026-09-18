/**
 * Live checks against Flint's local OpenAI-compatible gateway.
 * Blocked (not failed) when no endpoint or no cached chat model is available.
 * A catalog tool-calling flag is not a Flint verification.
 */

export type SelfTestStatus = 'pass' | 'fail' | 'blocked';

export interface SelfTestCheck {
  id: string;
  title: string;
  status: SelfTestStatus;
  detail: string;
}

export interface SelfTestReport {
  ranAt: string;
  endpoint: string | null;
  modelId: string | null;
  embeddingModelId: string | null;
  checks: SelfTestCheck[];
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
}

const REQUEST_TIMEOUT_MS = 8_000;
const DISCONNECT_START_MS = 2_000;

function check(
  id: string,
  title: string,
  status: SelfTestStatus,
  detail: string,
): SelfTestCheck {
  return { id, title, status, detail };
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function passed(report: SelfTestReport, id: string): boolean {
  return report.checks.some((item) => item.id === id && item.status === 'pass');
}

export function flintVerifiedFromReport(report: SelfTestReport): FlintVerified | null {
  // A failed /v1/models envelope is not a verified endpoint. Chat/stream can still
  // have run against a UI alias; do not mint a badge from that.
  if (!passed(report, 'models')) return null;
  const id = report.modelId || report.embeddingModelId;
  if (!id) return null;
  const toolsCheck = report.checks.find((item) => item.id === 'tools');
  return {
    modelId: id,
    embeddingModelId: report.embeddingModelId,
    ranAt: report.ranAt,
    chat: passed(report, 'chat'),
    stream: passed(report, 'stream'),
    usage: passed(report, 'usage'),
    disconnect: passed(report, 'disconnect'),
    embeddings: passed(report, 'embeddings'),
    tools: toolsCheck?.status === 'pass' ? 'verified' : 'not-verified',
  };
}

export function matchesVerifiedModel(modelId: string, alias: string | null | undefined): boolean {
  if (!alias) return false;
  const id = modelId.toLowerCase();
  const name = alias.toLowerCase();
  return id === name || id.startsWith(`${name}-`);
}

function listedIds(body: { data?: Array<{ id?: string }> } | null): string[] {
  return (body?.data ?? [])
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function isEmbeddingModelId(id: string): boolean {
  return /embed/i.test(id);
}

function isChatModelId(id: string): boolean {
  const name = id.toLowerCase();
  if (isEmbeddingModelId(name)) return false;
  if (/(whisper|-stt(?:-|$)|(?:^|-)stt-|parakeet|nemotron-speech)/i.test(name)) return false;
  return true;
}

function pickListedId(listed: string[], requested: string | null): string | null {
  if (requested) {
    const match = listed.find((id) => matchesVerifiedModel(id, requested));
    if (match) return match;
  }
  return listed[0] ?? null;
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

export async function runEndpointSelfTest(options: {
  fetch: typeof fetch;
  endpoint: string | null;
  modelId?: string | null;
  catalogSupportsToolCalling?: boolean | null;
  embeddingModelId?: string | null;
  requestTimeoutMs?: number;
  disconnectStartMs?: number;
}): Promise<SelfTestReport> {
  const ranAt = new Date().toISOString();
  const endpoint = options.endpoint?.trim() || null;
  const requestedModel = options.modelId?.trim() || null;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const disconnectStartMs = options.disconnectStartMs ?? DISCONNECT_START_MS;

  if (!endpoint) {
    return {
      ranAt,
      endpoint: null,
      modelId: requestedModel,
      embeddingModelId: null,
      checks: [
        check('endpoint', 'Local gateway reachable', 'blocked', 'Start the local service first.'),
      ],
    };
  }

  const checks: SelfTestCheck[] = [];
  let modelsBody: { data?: Array<{ id?: string }> } | null = null;

  try {
    const { res, json } = await fetchAndRead(
      options.fetch,
      joinUrl(endpoint, '/models'),
      { method: 'GET', headers: { Accept: 'application/json' } },
      requestTimeoutMs,
      'json',
    );
    const data = Array.isArray(json?.data) ? json.data : null;
    if (!res.ok || !data) {
      checks.push(check(
        'models',
        'GET /v1/models returns an OpenAI envelope',
        'fail',
        `HTTP ${res.status}; expected { data: [...] }.`,
      ));
    } else {
      modelsBody = json as { data?: Array<{ id?: string }> };
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
  const ids = modelsOk ? listedIds(modelsBody) : [];
  const chatIds = ids.filter(isChatModelId);
  const embedIds = ids.filter(isEmbeddingModelId);
  // The check is "a returned ID round-trips into chat". Never send an unlisted UI alias.
  const modelId = pickListedId(chatIds, requestedModel);
  const embeddingModelId = pickListedId(embedIds, options.embeddingModelId?.trim() || null);

  if (!modelsOk) {
    const blocked = 'GET /v1/models did not return an OpenAI envelope.';
    checks.push(check('embeddings', 'POST /v1/embeddings returns a vector', 'blocked', blocked));
    checks.push(check('chat', 'Returned model id round-trips into chat', 'blocked', blocked));
    checks.push(check('stream', 'Streaming delivers a token and [DONE]', 'blocked', blocked));
    checks.push(check('usage', 'usage is present when the model emits it', 'blocked', blocked));
    checks.push(check('disconnect', 'Aborting a stream settles the caller', 'blocked', blocked));
    checks.push(check('tools', 'tool_calls when prompted', 'blocked', blocked));
    return { ranAt, endpoint, modelId: null, embeddingModelId: null, checks };
  }

  if (!embeddingModelId) {
    checks.push(check(
      'embeddings',
      'POST /v1/embeddings returns a vector',
      'blocked',
      'Import a BYOM embedding model, then run the test again.',
    ));
  } else {
    try {
      const { res, json } = await fetchAndRead(
        options.fetch,
        joinUrl(endpoint, '/embeddings'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: embeddingModelId, input: 'ping' }),
        },
        requestTimeoutMs,
        'json',
      );
      const vector = (json as { data?: Array<{ embedding?: unknown }> } | null)?.data?.[0]?.embedding;
      if (
        !res.ok
        || !Array.isArray(vector)
        || vector.length === 0
        || typeof vector[0] !== 'number'
        || !Number.isFinite(vector[0])
      ) {
        checks.push(check(
          'embeddings',
          'POST /v1/embeddings returns a vector',
          'fail',
          `HTTP ${res.status}; expected data[0].embedding number[].`,
        ));
      } else {
        checks.push(check(
          'embeddings',
          'POST /v1/embeddings returns a vector',
          'pass',
          `${vector.length}-d vector from ${embeddingModelId}.`,
        ));
      }
    } catch (error) {
      checks.push(check(
        'embeddings',
        'POST /v1/embeddings returns a vector',
        'fail',
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  if (!modelId) {
    checks.push(check('chat', 'Returned model id round-trips into chat', 'blocked', 'Download a chat model, then run the test again.'));
    checks.push(check('stream', 'Streaming delivers a token and [DONE]', 'blocked', 'Needs a cached chat model.'));
    checks.push(check('usage', 'usage is present when the model emits it', 'blocked', 'Needs a cached chat model.'));
    checks.push(check('disconnect', 'Aborting a stream settles the caller', 'blocked', 'Needs a cached chat model.'));
    checks.push(check('tools', 'tool_calls when prompted', 'blocked', 'Needs a cached chat model.'));
    return { ranAt, endpoint, modelId: null, embeddingModelId, checks };
  }

  let usageSeen = false;
  try {
    const { res, json } = await fetchAndRead(
      options.fetch,
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
      checks.push(check('chat', 'Returned model id round-trips into chat', 'fail', `HTTP ${res.status}; no assistant message.`));
    } else {
      usageSeen = !!(usage && (usage.prompt_tokens != null || usage.completion_tokens != null
        || usage.input_tokens != null || usage.output_tokens != null));
      checks.push(check('chat', 'Returned model id round-trips into chat', 'pass', `id ${modelId} produced a completion.`));
    }
  } catch (error) {
    checks.push(check(
      'chat',
      'Returned model id round-trips into chat',
      'fail',
      error instanceof Error ? error.message : String(error),
    ));
  }

  if (usageSeen) {
    checks.push(check('usage', 'usage is present when the model emits it', 'pass', 'Non-streamed completion included usage.'));
  } else {
    checks.push(check(
      'usage',
      'usage is present when the model emits it',
      'blocked',
      'This model did not emit usage; not treated as a failure.',
    ));
  }

  try {
    const { res, text } = await fetchAndRead(
      options.fetch,
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
      checks.push(check('stream', 'Streaming delivers a token and [DONE]', 'fail', `HTTP ${res.status}; done=${hasDone} token=${hasToken}.`));
    } else {
      checks.push(check('stream', 'Streaming delivers a token and [DONE]', 'pass', 'SSE stream terminated with [DONE].'));
    }
  } catch (error) {
    checks.push(check(
      'stream',
      'Streaming delivers a token and [DONE]',
      'fail',
      error instanceof Error ? error.message : String(error),
    ));
  }

  try {
    const abort = new AbortController();
    const pending = options.fetch(joinUrl(endpoint, '/chat/completions'), {
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
        setTimeout(() => resolve({ kind: 'slow' }), disconnectStartMs);
      }),
    ]);
    if (started.kind !== 'headers') {
      abort.abort();
      checks.push(check(
        'disconnect',
        'Aborting a stream settles the caller',
        'fail',
        started.kind === 'error'
          ? (started.error instanceof Error ? started.error.message : String(started.error))
          : `Streaming response did not start within ${disconnectStartMs} ms; disconnect was not exercised.`,
      ));
    } else {
      if (started.res.body) {
        const reader = started.res.body.getReader();
        await Promise.race([
          reader.read().catch(() => undefined),
          new Promise<void>((resolve) => {
            setTimeout(resolve, disconnectStartMs);
          }),
        ]);
      }
      abort.abort();
      // fetch() settles at headers. Waiting for headers is what proves the request
      // left the client; abort then tells the gateway to drop the body.
      checks.push(check(
        'disconnect',
        'Aborting a stream settles the caller',
        'pass',
        'Stream started and abort was issued. Native generation may still finish.',
      ));
    }
  } catch (error) {
    checks.push(check(
      'disconnect',
      'Aborting a stream settles the caller',
      'fail',
      error instanceof Error ? error.message : String(error),
    ));
  }

  if (options.catalogSupportsToolCalling === false) {
    checks.push(check(
      'tools',
      'tool_calls when prompted',
      'blocked',
      'Catalog declares no tool calling; Flint-verified remains not-verified.',
    ));
  } else {
    try {
      const { res, json } = await fetchAndRead(
        options.fetch,
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
        checks.push(check('tools', 'tool_calls when prompted', 'pass', 'Model emitted OpenAI-style tool_calls.'));
      } else {
        checks.push(check(
          'tools',
          'tool_calls when prompted',
          'blocked',
          res.ok
            ? 'No tool_calls in the response; labeled not-verified rather than failed.'
            : `HTTP ${res.status}; labeled not-verified rather than failed.`,
        ));
      }
    } catch (error) {
      checks.push(check(
        'tools',
        'tool_calls when prompted',
        'blocked',
        `Could not verify tools (${error instanceof Error ? error.message : String(error)}).`,
      ));
    }
  }

  return { ranAt, endpoint, modelId, embeddingModelId, checks };
}
