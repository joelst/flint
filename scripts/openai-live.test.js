import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOpenAiLive, TOOL_PROMPT } from './openai-live.mjs';

const MODEL = 'tool-control';
const USAGE = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };

function jsonResponse(status, value) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(value),
  };
}

function sseResponse(value) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => 'text/event-stream' },
    text: async () => value,
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array([1]) }),
        cancel: async () => {},
      }),
    },
  };
}

function toolStream(argumentsText = '{"color":"blue"}') {
  const first = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-1',
          function: { name: 'pick_', arguments: '{"color":' },
        }],
      },
    }],
  };
  const second = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          function: {
            name: 'color',
            arguments: argumentsText.slice('{"color":'.length),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  };
  return [
    `data: ${JSON.stringify(first)}`,
    `data: ${JSON.stringify(second)}`,
    'data: [DONE]',
    '',
  ].join('\n');
}

function installGateway({ listed = true, usage = true, toolArguments, finalToolCalls = [] } = {}) {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/models')) {
      return jsonResponse(200, {
        object: 'list',
        data: listed ? [{ id: MODEL }] : [],
      });
    }
    if (target.endsWith(`/models/${MODEL}`)) return jsonResponse(404, { error: { message: 'not found' } });
    if (target.endsWith('/responses')) return jsonResponse(404, { error: { message: 'not supported' } });
    if (!target.endsWith('/chat/completions')) throw new Error(`Unexpected request: ${target}`);

    const body = JSON.parse(init.body);
    if (body.model === 'flint-openai-live-missing') {
      return jsonResponse(404, { error: { message: 'model not found' } });
    }
    const latest = body.messages?.at(-1);
    if (body.stream && latest?.content === TOOL_PROMPT) {
      return sseResponse(toolStream(toolArguments));
    }
    if (body.stream && latest?.content === 'Keep writing until stopped.') {
      return sseResponse('data: {"choices":[{"delta":{"content":"working"}}]}\n\n');
    }
    if (body.stream) {
      return sseResponse(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'ready' }, finish_reason: 'stop' }],
        usage: USAGE,
      })}\ndata: [DONE]\n`);
    }
    if (body.messages?.some((message) => message.role === 'tool')) {
      requests.push(body);
      return jsonResponse(200, {
        choices: [{
          message: {
            content: finalToolCalls.length ? '' : 'blue selected',
            tool_calls: finalToolCalls,
          },
          finish_reason: finalToolCalls.length ? 'tool_calls' : 'stop',
        }],
        usage: USAGE,
      });
    }
    return jsonResponse(200, {
      choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }],
      ...(usage ? { usage: USAGE } : {}),
    });
  }));
  return requests;
}

function check(report, name) {
  return report.checks.find((item) => item.name === name);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openai-live qualification gates', () => {
  it('requires a listed model, complete usage, and a tool-result turn with a tool-free final answer', async () => {
    const toolResultRequests = installGateway();
    const report = await runOpenAiLive({
      base: 'http://127.0.0.1:5272/v1',
      model: MODEL,
      requireTools: true,
      timeoutMs: 1000,
    });

    expect(report.requiredOk).toBe(true);
    expect(check(report, 'model-listed')).toMatchObject({ required: true, ok: true });
    expect(check(report, 'usage')).toMatchObject({ required: true, ok: true });
    expect(check(report, 'tools')).toMatchObject({ required: true, ok: true });
    expect(check(report, 'tool-boundary')).toMatchObject({ required: true, ok: true });
    expect(toolResultRequests).toHaveLength(1);
    expect(toolResultRequests[0].messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      content: '{"color":"blue"}',
    });
  });

  it('fails required gates when the model, usage, or a valid tool call is missing', async () => {
    installGateway({ listed: false, usage: false, toolArguments: '{"color":"green"}' });
    const report = await runOpenAiLive({
      base: 'http://127.0.0.1:5272/v1',
      model: MODEL,
      requireTools: true,
      timeoutMs: 1000,
    });

    expect(report.requiredOk).toBe(false);
    expect(check(report, 'model-listed')).toMatchObject({ required: true, ok: false });
    expect(check(report, 'usage')).toMatchObject({ required: true, ok: false });
    expect(check(report, 'tools')).toMatchObject({ required: true, ok: false });
    expect(check(report, 'tool-boundary')).toMatchObject({ required: true, ok: false });
  });

  it('rejects a tool call instead of a tool-free final answer', async () => {
    installGateway({
      finalToolCalls: [{ id: 'call-2', type: 'function', function: { name: 'pick_color', arguments: '{"color":"red"}' } }],
    });
    const report = await runOpenAiLive({
      base: 'http://127.0.0.1:5272/v1',
      model: MODEL,
      requireTools: true,
      timeoutMs: 1000,
    });

    expect(check(report, 'tools')).toMatchObject({ required: true, ok: true });
    expect(check(report, 'tool-boundary')).toMatchObject({ required: true, ok: false });
    expect(report.requiredOk).toBe(false);
  });
});
