import { describe, expect, it } from 'vitest';
import {
  flintVerifiedFromReport,
  matchesVerifiedModel,
  runEndpointSelfTest,
} from './endpoint-self-test';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cooperatingFetch(): typeof fetch {
  return async (input, init) => {
    if (init?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const url = String(input);
    if (url.endsWith('/models')) {
      return jsonResponse(200, { data: [{ id: 'phi-4-mini-instruct-generic-cpu' }] });
    }
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.tools) {
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"ping"}' } }] } }],
      });
    }
    if (body.stream) {
      return new Response('data: {"choices":[{"delta":{"content":"ping"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return jsonResponse(200, {
      choices: [{ message: { role: 'assistant', content: 'ping' } }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    });
  };
}

describe('runEndpointSelfTest', () => {
  it('blocks when the local service is not started', async () => {
    const report = await runEndpointSelfTest({ fetch, endpoint: null });
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0].status).toBe('blocked');
  });

  it('blocks later checks when /v1/models is empty', async () => {
    const report = await runEndpointSelfTest({
      fetch: async () => jsonResponse(200, { data: [] }),
      endpoint: 'http://127.0.0.1:5272/v1',
    });
    expect(report.checks[0].status).toBe('pass');
    expect(report.checks.filter((c) => c.status === 'blocked').map((c) => c.id))
      .toEqual(['chat', 'stream', 'usage', 'disconnect', 'tools']);
  });

  it('passes envelope, round-trip, stream, usage, disconnect, and tools when the gateway cooperates', async () => {
    const report = await runEndpointSelfTest({
      fetch: cooperatingFetch(),
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: true,
    });
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(flintVerifiedFromReport(report)).toMatchObject({
      modelId: 'phi-4-mini-instruct-generic-cpu',
      chat: true,
      stream: true,
      usage: true,
      disconnect: true,
      tools: 'verified',
    });
  });

  it('labels missing usage and missing tool_calls as not-verified rather than failed', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const url = String(input);
      if (url.endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
        });
      }
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'x' } }],
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
    });
    expect(report.checks.find((c) => c.id === 'usage')?.status).toBe('blocked');
    expect(report.checks.find((c) => c.id === 'tools')?.status).toBe('blocked');
    expect(report.checks.find((c) => c.id === 'chat')?.status).toBe('pass');
    expect(flintVerifiedFromReport(report)?.tools).toBe('not-verified');
  });

  it('fails disconnect when an aborted stream does not settle', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.stream && String(body.messages?.[0]?.content || '').includes('Keep writing')) {
        return new Promise<Response>(() => {});
      }
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
      }
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: false,
    });
    expect(report.checks.find((c) => c.id === 'disconnect')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'disconnect')?.detail).toMatch(/within 1000 ms/);
  });

  it('does not attempt tools when the catalog declares them unsupported', async () => {
    const report = await runEndpointSelfTest({
      fetch: cooperatingFetch(),
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: false,
    });
    expect(report.checks.find((c) => c.id === 'tools')?.status).toBe('blocked');
    expect(flintVerifiedFromReport(report)?.tools).toBe('not-verified');
  });

  it('fails models/chat/stream when fetch throws or returns a bad envelope', async () => {
    const reportModels = await runEndpointSelfTest({
      fetch: async () => { throw new Error('offline'); },
      endpoint: 'http://127.0.0.1:5272/v1',
      modelId: 'tiny-cpu',
    });
    expect(reportModels.checks.find((c) => c.id === 'models')?.status).toBe('fail');

    const reportChat: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      if (!JSON.parse(String(init?.body || '{}')).stream) {
        return jsonResponse(500, { error: { message: 'nope' } });
      }
      throw new Error('stream down');
    };
    const report = await runEndpointSelfTest({
      fetch: reportChat,
      endpoint: 'http://127.0.0.1:5272/v1',
    });
    expect(report.checks.find((c) => c.id === 'chat')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'stream')?.status).toBe('fail');
  });

  it('blocks tools when the tools request throws', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.tools) throw new Error('tools route missing');
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
      }
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
    });
    expect(report.checks.find((c) => c.id === 'tools')?.status).toBe('blocked');
    expect(report.checks.find((c) => c.id === 'tools')?.detail).toMatch(/tools route missing/);
  });

  it('fails /v1/models on a non-OK envelope and stream when [DONE] is missing', async () => {
    const badModels = await runEndpointSelfTest({
      fetch: async () => jsonResponse(500, { data: [] }),
      endpoint: 'http://127.0.0.1:5272/v1',
      modelId: 'tiny-cpu',
    });
    expect(badModels.checks.find((c) => c.id === 'models')?.status).toBe('fail');

    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.stream) {
        return new Response('not-sse', { status: 200 });
      }
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: false,
    });
    expect(report.checks.find((c) => c.id === 'stream')?.status).toBe('fail');
  });
});

describe('matchesVerifiedModel', () => {
  it('matches alias to variant ids', () => {
    expect(matchesVerifiedModel('phi-4-mini-instruct-generic-cpu', 'phi-4-mini-instruct')).toBe(true);
    expect(matchesVerifiedModel('phi-4-mini-instruct', 'phi-4-mini-instruct')).toBe(true);
    expect(matchesVerifiedModel('other-cpu', 'phi-4')).toBe(false);
  });
});
