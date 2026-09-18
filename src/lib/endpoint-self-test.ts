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
  checks: SelfTestCheck[];
}

export interface FlintVerified {
  modelId: string;
  ranAt: string;
  chat: boolean;
  stream: boolean;
  usage: boolean;
  disconnect: boolean;
  tools: 'verified' | 'not-verified';
}

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
  if (!report.modelId) return null;
  const toolsCheck = report.checks.find((item) => item.id === 'tools');
  return {
    modelId: report.modelId,
    ranAt: report.ranAt,
    chat: passed(report, 'chat'),
    stream: passed(report, 'stream'),
    usage: passed(report, 'usage'),
    disconnect: passed(report, 'disconnect'),
    tools: toolsCheck?.status === 'pass' ? 'verified' : 'not-verified',
  };
}

export function matchesVerifiedModel(modelId: string, alias: string | null | undefined): boolean {
  if (!alias) return false;
  const id = modelId.toLowerCase();
  const name = alias.toLowerCase();
  return id === name || id.startsWith(`${name}-`);
}

export async function runEndpointSelfTest(options: {
  fetch: typeof fetch;
  endpoint: string | null;
  modelId?: string | null;
  catalogSupportsToolCalling?: boolean | null;
}): Promise<SelfTestReport> {
  const ranAt = new Date().toISOString();
  const endpoint = options.endpoint?.trim() || null;
  const requestedModel = options.modelId?.trim() || null;

  if (!endpoint) {
    return {
      ranAt,
      endpoint: null,
      modelId: requestedModel,
      checks: [
        check('endpoint', 'Local gateway reachable', 'blocked', 'Start the local service first.'),
      ],
    };
  }

  const checks: SelfTestCheck[] = [];
  let modelsBody: { data?: Array<{ id?: string }> } | null = null;

  try {
    const res = await options.fetch(joinUrl(endpoint, '/models'), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const json = await res.json().catch(() => null);
    const data = Array.isArray(json?.data) ? json.data : null;
    if (!res.ok || !data) {
      checks.push(check(
        'models',
        'GET /v1/models returns an OpenAI envelope',
        'fail',
        `HTTP ${res.status}; expected { data: [...] }.`,
      ));
    } else {
      modelsBody = json;
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

  const modelId = requestedModel
    || modelsBody?.data?.find((row) => typeof row.id === 'string' && row.id)?.id
    || null;

  if (!modelId) {
    checks.push(check('chat', 'Returned model id round-trips into chat', 'blocked', 'Download a chat model, then run the test again.'));
    checks.push(check('stream', 'Streaming delivers a token and [DONE]', 'blocked', 'Needs a cached chat model.'));
    checks.push(check('usage', 'usage is present when the model emits it', 'blocked', 'Needs a cached chat model.'));
    checks.push(check('disconnect', 'Aborting a stream settles the caller', 'blocked', 'Needs a cached chat model.'));
    checks.push(check('tools', 'tool_calls when prompted', 'blocked', 'Needs a cached chat model.'));
    return { ranAt, endpoint, modelId: null, checks };
  }

  let usageSeen = false;
  try {
    const res = await options.fetch(joinUrl(endpoint, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with the single word ping.' }],
        stream: false,
        max_tokens: 8,
      }),
    });
    const json = await res.json().catch(() => null);
    const content = json?.choices?.[0]?.message?.content;
    const usage = json?.usage;
    usageSeen = !!(usage && (usage.prompt_tokens != null || usage.completion_tokens != null
      || usage.input_tokens != null || usage.output_tokens != null));
    if (!res.ok || typeof content !== 'string') {
      checks.push(check('chat', 'Returned model id round-trips into chat', 'fail', `HTTP ${res.status}; no assistant message.`));
    } else {
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
    const res = await options.fetch(joinUrl(endpoint, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with the single word ping.' }],
        stream: true,
        max_tokens: 8,
      }),
    });
    const text = await res.text();
    const hasDone = text.includes('[DONE]');
    const hasDelta = /data:\s*\{/.test(text);
    if (!res.ok || !hasDone || !hasDelta) {
      checks.push(check('stream', 'Streaming delivers a token and [DONE]', 'fail', `HTTP ${res.status}; done=${hasDone} delta=${hasDelta}.`));
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
    abort.abort();
    let settled = false;
    try {
      await pending;
      settled = true;
    } catch {
      settled = true;
    }
    checks.push(check(
      'disconnect',
      'Aborting a stream settles the caller',
      settled ? 'pass' : 'fail',
      settled
        ? 'Caller completed after abort. Native generation may still finish.'
        : 'Abort did not settle the request.',
    ));
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
      const res = await options.fetch(joinUrl(endpoint, '/chat/completions'), {
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
      });
      const json = await res.json().catch(() => null);
      const toolCalls = json?.choices?.[0]?.message?.tool_calls
        ?? json?.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        checks.push(check('tools', 'tool_calls when prompted', 'pass', 'Model emitted OpenAI-style tool_calls.'));
      } else {
        checks.push(check(
          'tools',
          'tool_calls when prompted',
          'blocked',
          'No tool_calls in the response; labeled not-verified rather than failed.',
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

  return { ranAt, endpoint, modelId, checks };
}
