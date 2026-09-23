import { describe, expect, it } from 'vitest';
import { buildEndpointModelClassifier } from './endpoint-model-classification';
import {
  endpointAliases,
  flintVerifiedFromReport,
  groupSelfTestChecks,
  catalogModelForEndpointId,
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
      return jsonResponse(200, { data: [
        { id: 'phi-4-mini-instruct-generic-cpu' },
        { id: 'qwen3-embedding-generic-cpu' },
      ] });
    }
    if (url.endsWith('/embeddings')) {
      return jsonResponse(200, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] });
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
      .toEqual(['embeddings', 'chat', 'stream', 'usage', 'disconnect', 'tools']);
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
      embeddings: true,
      tools: 'verified',
    });
  });

  it('runs the disconnect probe only after every other endpoint probe', async () => {
    const requests: Array<{ model: string; disconnect: boolean }> = [];
    const progress: Array<{ modelId: string; index: number; total: number }> = [];
    const restored: string[] = [];
    // Each observation records how many model requests had gone out when it was taken.
    const observed: Array<{ modelId: string; requestsSoFar: number }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [
          { id: 'model-generic-cpu', parent: 'model' },
          { id: 'model-generic-cuda', parent: 'model' },
          { id: 'whisper-tiny-generic-cpu' },
        ] });
      }
      if (init?.body instanceof FormData) {
        requests.push({
          model: String(init.body.get('model')),
          disconnect: false,
        });
        return jsonResponse(200, { text: 'test audio' });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      requests.push({
        model: body.model,
        disconnect: body.messages?.[0]?.content === 'Keep writing until stopped.',
      });
      if (body.tools) return jsonResponse(200, { choices: [{ message: { tool_calls: [] } }] });
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"ping"}}]}\n\ndata: [DONE]\n\n');
      }
      return jsonResponse(200, {
        choices: [{ message: { content: 'ping' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };

    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: true,
      prepareSpeechModel: async (modelId) => modelId,
      beforeModelProbe: async (modelId) => { observed.push({ modelId, requestsSoFar: requests.length }); },
      afterModelProbe: async (modelId) => { restored.push(modelId); },
      disconnectModelId: 'MODEL-GENERIC-CPU',
      onProgress: (event) => progress.push(event),
    });

    expect(report.modelIds).toEqual(['model-generic-cpu', 'model-generic-cuda', 'model']);
    // One observation per alias group, taken before that group's first request and before
    // its restore. The whisper observation comes after every request of the model group.
    const firstWhisperRequest = requests.findIndex((request) => request.model.startsWith('whisper'));
    expect(observed).toEqual([
      { modelId: 'model', requestsSoFar: 0 },
      { modelId: 'whisper-tiny-generic-cpu', requestsSoFar: firstWhisperRequest },
    ]);
    expect(firstWhisperRequest).toBeGreaterThan(0);
    expect(requests.filter((request) => request.disconnect).map((request) => request.model))
      .toEqual(['model-generic-cpu']);
    const disconnectIndex = requests.findIndex((request) => request.disconnect);
    expect(disconnectIndex).toBe(requests.length - 1);
    expect(restored).toEqual([
      'model',
      'whisper-tiny-generic-cpu',
    ]);
    expect(report.checks.at(-1)).toMatchObject({ id: 'disconnect' });
    expect(report.checks.at(-1)).not.toHaveProperty('modelId');
    const verified = flintVerifiedFromReport(report);
    expect(verified?.disconnect).toBe(true);
    expect(verified?.aliases.every((alias) => 'disconnect' in alias)).toBe(false);
    expect(progress.at(-1)).toEqual({
      modelId: 'model-generic-cpu',
      index: progress.length - 1,
      total: progress.length,
    });
  });

  it('accepts usage from input_tokens fields and SSE data lines that are not JSON', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.stream) {
        return new Response('data: not-json\n\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
      }
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'x' } }],
        usage: { input_tokens: 4, output_tokens: 1 },
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: false,
    });
    expect(report.checks.find((c) => c.id === 'usage')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'stream')?.status).toBe('pass');
  });

  it('stops before loading more models when residency restoration fails', async () => {
    const report = await runEndpointSelfTest({
      fetch: cooperatingFetch(),
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: false,
      afterModelProbe: async () => {
        throw new Error('restore failed');
      },
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'residency',
      status: 'fail',
      detail: 'restore failed',
    }));
    expect(report.checks.at(-1)).toMatchObject({
      id: 'run',
      status: 'blocked',
    });
    expect(report.checks.some((item) => item.id === 'disconnect')).toBe(false);
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

  it('fails disconnect when the body reader does not settle after abort', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.stream && String(body.messages?.[0]?.content || '').includes('Keep writing')) {
        return new Response(new ReadableStream({ start () { /* never enqueue */ } }), { status: 200 });
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
      disconnectStartMs: 20,
    });
    expect(report.checks.find((c) => c.id === 'disconnect')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'disconnect')?.detail).toMatch(/did not settle/);
  });

  it('fails disconnect when the streaming response never starts', async () => {
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
      disconnectStartMs: 20,
    });
    expect(report.checks.find((c) => c.id === 'disconnect')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'disconnect')?.detail).toMatch(/did not start/);
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

  it('does not mint Flint-verified when /v1/models failed even if a UI alias is selected', async () => {
    const reportModels = await runEndpointSelfTest({
      fetch: async () => { throw new Error('offline'); },
      endpoint: 'http://127.0.0.1:5272/v1',
      modelId: 'tiny-cpu',
    });
    expect(reportModels.checks.find((c) => c.id === 'models')?.status).toBe('fail');
    expect(reportModels.checks.filter((c) => c.status === 'blocked').map((c) => c.id))
      .toEqual(['embeddings', 'chat', 'stream', 'usage', 'disconnect', 'tools']);
    expect(flintVerifiedFromReport(reportModels)).toBeNull();
  });

  it('fails models/chat/stream when fetch throws or returns a bad envelope', async () => {

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

  it('fails embeddings when POST /v1/embeddings is not a vector', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'qwen3-embedding-generic-cpu' }] });
      }
      if (String(input).endsWith('/embeddings')) {
        return jsonResponse(500, { error: { message: 'nope' } });
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
    expect(report.embeddingModelId).toBe('qwen3-embedding-generic-cpu');
    expect(report.checks.find((c) => c.id === 'embeddings')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'chat')?.status).toBe('blocked');
  });

  it('passes embeddings and blocks chat when only an embedding model is listed', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'qwen3-embedding-generic-cpu' }] });
      }
      if (String(input).endsWith('/embeddings')) {
        return jsonResponse(200, { data: [{ embedding: [0.4, 0.5], index: 0 }] });
      }
      throw new Error(`unexpected ${input}`);
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
    });
    expect(report.modelId).toBeNull();
    expect(report.embeddingModelId).toBe('qwen3-embedding-generic-cpu');
    expect(report.checks.find((c) => c.id === 'embeddings')?.status).toBe('pass');
    expect(report.checks.filter((c) => c.status === 'blocked').map((c) => c.id))
      .toEqual(['chat', 'stream', 'usage', 'disconnect', 'tools']);
    expect(flintVerifiedFromReport(report)).toMatchObject({
      modelId: 'qwen3-embedding-generic-cpu',
      embeddingModelId: 'qwen3-embedding-generic-cpu',
      embeddings: true,
      chat: false,
    });
  });

  it('fails embeddings when the embeddings request throws', async () => {
    const fetchMock: typeof fetch = async (input) => {
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }, { id: 'bge-embed-cpu' }] });
      }
      if (String(input).endsWith('/embeddings')) throw new Error('embed down');
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      embeddingModelId: 'bge-embed-cpu',
    });
    expect(report.checks.find((c) => c.id === 'embeddings')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'embeddings')?.detail).toMatch(/embed down/);
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

  it('round-trips a listed model id even when the UI selected an unlisted alias', async () => {
    const seen: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'phi-4-mini-instruct-generic-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.model) seen.push(body.model);
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"ping"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
      }
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'ping' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      modelId: 'not-in-the-envelope',
      catalogSupportsToolCalling: false,
    });
    expect(report.modelId).toBe('phi-4-mini-instruct-generic-cpu');
    expect(seen.every((id) => id === 'phi-4-mini-instruct-generic-cpu')).toBe(true);
    expect(report.checks.find((c) => c.id === 'chat')?.status).toBe('pass');
  });

  it('uses a requested embedding alias even when the listed id does not contain embed', async () => {
    const seen: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'my-model' }, { id: 'tiny-cpu' }] });
      }
      if (String(input).endsWith('/embeddings')) {
        const body = JSON.parse(String(init?.body || '{}'));
        seen.push(`embed:${body.model}`);
        return jsonResponse(200, { data: [{ embedding: [0.2, 0.3], index: 0 }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.model) seen.push(`chat:${body.model}`);
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"ping"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
      }
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'ping' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      embeddingModelId: 'my-model',
      catalogSupportsToolCalling: false,
    });
    expect(report.embeddingModelId).toBe('my-model');
    expect(report.modelId).toBe('tiny-cpu');
    expect(seen).toContain('embed:my-model');
    expect(seen.some((item) => item === 'chat:my-model')).toBe(false);
    expect(report.checks.find((c) => c.id === 'embeddings')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'chat')?.status).toBe('pass');
  });

  it('routes every opaque embedding model through embeddings from catalog metadata', async () => {
    const seen: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return jsonResponse(200, { data: [
          { id: 'custom-model-one-generic-cpu', parent: 'vectorizer-one' },
          { id: 'custom-model-two-generic-cpu', parent: 'semantic-two' },
        ] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (url.endsWith('/embeddings')) {
        seen.push(body.model);
        return jsonResponse(200, { data: [{ embedding: [0.2, 0.3], index: 0 }] });
      }
      throw new Error(`unexpected ${url}`);
    };
    const classifyModel = buildEndpointModelClassifier([
      {
        alias: 'vectorizer-one',
        task: 'embeddings',
        variants: [{ id: 'custom-model-one-generic-cpu:1' }],
      },
      {
        alias: 'semantic-two',
        capabilities: ['embedding'],
        variants: [{ id: 'custom-model-two-generic-cpu:2' }],
      },
    ]);

    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      classifyModel,
    });

    expect(report.modelIds).toEqual([]);
    expect(report.embeddingModelIds).toEqual([
      'custom-model-one-generic-cpu',
      'vectorizer-one',
      'custom-model-two-generic-cpu',
      'semantic-two',
    ]);
    expect(seen).toEqual(report.embeddingModelIds);
    expect(report.checks.filter((item) => item.id === 'embeddings' && item.status === 'pass'))
      .toHaveLength(4);
  });

  it('fails embeddings when a later vector element is not finite', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'qwen3-embedding-cpu' }] });
      }
      if (String(input).endsWith('/embeddings')) {
        return jsonResponse(200, { data: [{ embedding: [0.1, Number.NaN], index: 0 }] });
      }
      throw new Error(`chat should not run: ${input}`);
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
    });
    expect(report.checks.find((c) => c.id === 'embeddings')?.status).toBe('fail');
  });

  it('blocks chat when the envelope only lists STT or embedding models', async () => {
    const report = await runEndpointSelfTest({
      fetch: async (input) => {
        if (String(input).endsWith('/models')) {
          return jsonResponse(200, { data: [{ id: 'whisper-tiny' }, { id: 'qwen3-embedding-cpu' }] });
        }
        if (String(input).endsWith('/embeddings')) {
          return jsonResponse(200, { data: [{ embedding: [0.1], index: 0 }] });
        }
        if (String(input).endsWith('/audio/transcriptions')) {
          return jsonResponse(200, { text: 'ping' });
        }
        throw new Error(`chat should not run: ${input}`);
      },
      endpoint: 'http://127.0.0.1:5272/v1',
      prepareSpeechModel: async (modelId) => modelId,
    });
    expect(report.modelId).toBeNull();
    expect(report.checks.find((c) => c.id === 'chat')?.status).toBe('blocked');
    expect(report.checks.find((c) => c.id === 'embeddings')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'speech')?.status).toBe('pass');
  });

  it('blocks a speech probe when no preparation hook can provide a canonical variant', async () => {
    const report = await runEndpointSelfTest({
      fetch: async (input) => {
        if (String(input).endsWith('/models')) {
          return jsonResponse(200, { data: [{ id: 'whisper-tiny' }] });
        }
        throw new Error(`speech request should not run: ${input}`);
      },
      endpoint: 'http://127.0.0.1:5272/v1',
    });

    expect(report.checks.find((c) => c.id === 'speech')).toMatchObject({
      status: 'blocked',
      detail: expect.stringContaining('cannot be gateway-replayed'),
    });
  });

  it('creates a verified row for a speech-only endpoint with an empty transcript', async () => {
    const prepared: string[] = [];
    const report = await runEndpointSelfTest({
      fetch: async (input) => {
        if (String(input).endsWith('/models')) {
          return jsonResponse(200, { data: [{ id: 'whisper-tiny' }] });
        }
        if (String(input).endsWith('/audio/transcriptions')) {
          return jsonResponse(200, { text: '' });
        }
        throw new Error(`unexpected ${input}`);
      },
      endpoint: 'http://127.0.0.1:5272/v1',
      prepareSpeechModel: async (modelId) => { prepared.push(modelId); return modelId; },
    });
    expect(prepared).toEqual(['whisper-tiny']);
    expect(report.modelId).toBeNull();
    expect(report.speechModelIds).toEqual(['whisper-tiny']);
    expect(report.checks.find((c) => c.id === 'speech')?.status).toBe('pass');
    expect(flintVerifiedFromReport(report)).toMatchObject({
      modelId: 'whisper-tiny',
      aliases: [{ modelId: 'whisper-tiny', kind: 'speech', speech: true }],
    });
  });

  it('uses a speech variant kind for its parent alias', async () => {
    const seen: string[] = [];
    const aliases = endpointAliases(
      [{ id: 'my-asr-stt', parent: 'my-asr' }],
      null,
    );
    expect(aliases).toEqual({ chat: [], embed: [], speech: ['my-asr-stt', 'my-asr'] });

    await runEndpointSelfTest({
      fetch: async (input) => {
        if (String(input).endsWith('/models')) {
          return jsonResponse(200, { data: [{ id: 'my-asr-stt', parent: 'my-asr' }] });
        }
        if (String(input).endsWith('/audio/transcriptions')) {
          return jsonResponse(200, { text: 'ping' });
        }
        throw new Error(`unexpected ${input}`);
      },
      endpoint: 'http://127.0.0.1:5272/v1',
      prepareSpeechModel: async (modelId) => { seen.push(modelId); return `${modelId}:4`; },
    });
    expect(seen).toEqual(['my-asr-stt', 'my-asr']);
  });

  it('submits the canonical prepared variant for a speech parent alias', async () => {
    const submitted: string[] = [];
    const report = await runEndpointSelfTest({
      fetch: async (input, init) => {
        if (String(input).endsWith('/models')) {
          return jsonResponse(200, { data: [{ id: 'my-asr-stt', parent: 'my-asr' }] });
        }
        if (String(input).endsWith('/audio/transcriptions')) {
          const form = init?.body as FormData;
          submitted.push(String(form.get('model')));
          return jsonResponse(200, { text: '' });
        }
        throw new Error(`unexpected ${input}`);
      },
      endpoint: 'http://127.0.0.1:5272/v1',
      prepareSpeechModel: async () => 'my-asr-stt:4',
    });

    expect(submitted).toEqual(['my-asr-stt:4', 'my-asr-stt:4']);
    expect(report.checks.find((item) => item.id === 'speech' && item.modelId === 'my-asr'))
      .toMatchObject({
        status: 'pass',
        detail: 'my-asr resolved to my-asr-stt:4 and transcribed audio.',
      });
  });

  it('exercises every listed variant and each parent alias', async () => {
    const seen: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const url = String(input);
      if (url.endsWith('/models')) {
        return jsonResponse(200, { data: [
          { id: 'qwen3.5-9b-cuda-gpu', parent: 'qwen3.5-9b' },
          { id: 'qwen3.5-9b-generic-gpu', parent: 'qwen3.5-9b' },
          { id: 'bge-embed-cpu', parent: 'bge-embed' },
        ] });
      }
      if (url.endsWith('/embeddings')) {
        const body = JSON.parse(String(init?.body || '{}'));
        seen.push(`embed:${body.model}`);
        return jsonResponse(200, { data: [{ embedding: [0.2], index: 0 }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.model && !body.tools && !body.stream) seen.push(`chat:${body.model}`);
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"ping"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
      }
      return jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'ping' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: false,
    });
    expect(seen).toEqual([
      'embed:bge-embed-cpu',
      'embed:bge-embed',
      'chat:qwen3.5-9b-cuda-gpu',
      'chat:qwen3.5-9b-generic-gpu',
      'chat:qwen3.5-9b',
    ]);
    expect(report.modelIds).toEqual([
      'qwen3.5-9b-cuda-gpu',
      'qwen3.5-9b-generic-gpu',
      'qwen3.5-9b',
    ]);
    expect(report.checks.filter((item) => item.id === 'chat').map((item) => item.modelId)).toEqual(report.modelIds);
    expect(groupSelfTestChecks(report.checks).map((group) => group.modelId)).toContain('qwen3.5-9b-generic-gpu');
    const verified = flintVerifiedFromReport(report);
    expect(verified?.aliases.map((row) => row.modelId)).toEqual([
      'bge-embed-cpu',
      'bge-embed',
      'qwen3.5-9b-cuda-gpu',
      'qwen3.5-9b-generic-gpu',
      'qwen3.5-9b',
    ]);
    expect(verified?.aliases.find((row) => row.modelId === 'bge-embed')?.kind).toBe('embed');
    expect(verified?.aliases.find((row) => row.modelId === 'qwen3.5-9b-generic-gpu')?.chat).toBe(true);
  });

  it('does not treat HTTP-error usage or tool_calls as verified', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.tools) {
        return jsonResponse(500, {
          choices: [{ message: { tool_calls: [{ id: 'c1' }] } }],
        });
      }
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
      }
      return jsonResponse(500, {
        usage: { prompt_tokens: 4, completion_tokens: 1 },
        error: { message: 'nope' },
      });
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: true,
    });
    expect(report.checks.find((c) => c.id === 'chat')?.detail).toBe('HTTP 500; nope');
    expect(report.checks.find((c) => c.id === 'usage')?.status).toBe('blocked');
    expect(report.checks.find((c) => c.id === 'tools')?.status).toBe('blocked');
    expect(report.checks.find((c) => c.id === 'tools')?.detail).toMatch(/HTTP 500/);
    expect(flintVerifiedFromReport(report)?.usage).toBe(false);
    expect(flintVerifiedFromReport(report)?.tools).toBe('not-verified');
  });

  it('fails stream when SSE has [DONE] but no content token', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
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
    expect(report.checks.find((c) => c.id === 'stream')?.detail).toMatch(/token=false/);
  });

  it('fails models when the envelope body never arrives', async () => {
    const report = await runEndpointSelfTest({
      fetch: async () => new Response(new ReadableStream({ start () { /* never enqueue */ } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      endpoint: 'http://127.0.0.1:5272/v1',
      requestTimeoutMs: 40,
    });
    expect(report.checks.find((c) => c.id === 'models')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'models')?.detail).toMatch(/Timed out after 40 ms/);
  });

  it('fails models when the envelope request never settles', async () => {
    const report = await runEndpointSelfTest({
      fetch: () => new Promise<Response>(() => {}),
      endpoint: 'http://127.0.0.1:5272/v1',
      requestTimeoutMs: 30,
    });
    expect(report.checks.find((c) => c.id === 'models')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'models')?.detail).toMatch(/Timed out after 30 ms/);
    expect(flintVerifiedFromReport(report)).toBeNull();
  });

  it('fails chat when the completions request throws', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      throw new Error('chat down');
    };
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: false,
    });
    expect(report.checks.find((c) => c.id === 'chat')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'chat')?.detail).toMatch(/chat down/);
  });

  it('fails disconnect when starting the abort request throws', async () => {
    const fetchMock: typeof fetch = ((input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return Promise.resolve(jsonResponse(200, { data: [{ id: 'tiny-cpu' }] }));
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.stream && String(body.messages?.[0]?.content || '').includes('Keep writing')) {
        throw new Error('disconnect setup failed');
      }
      if (body.stream) {
        return Promise.resolve(new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n', { status: 200 }));
      }
      return Promise.resolve(jsonResponse(200, {
        choices: [{ message: { role: 'assistant', content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    }) as typeof fetch;
    const report = await runEndpointSelfTest({
      fetch: fetchMock,
      endpoint: 'http://127.0.0.1:5272/v1',
      catalogSupportsToolCalling: false,
    });
    expect(report.checks.find((c) => c.id === 'disconnect')?.status).toBe('fail');
    expect(report.checks.find((c) => c.id === 'disconnect')?.detail).toMatch(/disconnect setup failed/);
  });

  it.each([
    {
      name: 'HTTP errors',
      response: () => jsonResponse(503, { error: { message: 'unavailable' } }),
      detail: /HTTP 503/,
    },
    {
      name: 'bodyless success responses',
      response: () => new Response(null, { status: 200 }),
      detail: /no readable body/,
    },
  ])('fails disconnect for $name', async ({ response, detail }) => {
    const fetchMock: typeof fetch = async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (String(input).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'tiny-cpu' }] });
      }
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.stream && String(body.messages?.[0]?.content || '').includes('Keep writing')) {
        return response();
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
    expect(report.checks.find((c) => c.id === 'disconnect')?.detail).toMatch(detail);
  });
});

describe('endpointAliases', () => {
  it('keeps every variant id and adds each parent alias once', () => {
    expect(endpointAliases([
      { id: 'qwen3.5-9b-cuda-gpu', parent: 'qwen3.5-9b' },
      { id: 'qwen3.5-9b-generic-gpu', parent: 'qwen3.5-9b' },
      { id: 'whisper-tiny', parent: 'whisper' },
    ], null)).toEqual({
      chat: ['qwen3.5-9b-cuda-gpu', 'qwen3.5-9b-generic-gpu', 'qwen3.5-9b'],
      embed: [],
      speech: ['whisper-tiny', 'whisper'],
    });
  });

  it('uses the known embedding parent to classify an opaque variant id', () => {
    expect(endpointAliases([
      { id: 'custom-model-generic-cpu', parent: 'vectorizer' },
    ], 'vectorizer')).toEqual({
      chat: [],
      embed: ['custom-model-generic-cpu', 'vectorizer'],
      speech: [],
    });
  });

  it('classifies every opaque embedding model from its own catalog metadata', () => {
    expect(endpointAliases([
      { id: 'custom-model-one-generic-cpu', parent: 'vectorizer-one' },
      { id: 'custom-model-two-generic-cpu', parent: 'semantic-two' },
    ], null, (_id, parent) => (
      parent === 'vectorizer-one' || parent === 'semantic-two' ? 'embed' : null
    ))).toEqual({
      chat: [],
      embed: [
        'custom-model-one-generic-cpu',
        'custom-model-two-generic-cpu',
        'vectorizer-one',
        'semantic-two',
      ],
      speech: [],
    });
  });

  it('uses a speech parent to classify an opaque variant id', () => {
    expect(endpointAliases([
      { id: 'custom-model-generic-cpu', parent: 'whisper-custom' },
    ], null)).toEqual({
      chat: [],
      embed: [],
      speech: ['custom-model-generic-cpu', 'whisper-custom'],
    });
  });
});

describe('matchesVerifiedModel', () => {
  it('matches alias to variant ids', () => {
    expect(matchesVerifiedModel('phi-4-mini-instruct-generic-cpu', 'phi-4-mini-instruct')).toBe(true);
    expect(matchesVerifiedModel('phi-4-mini-instruct', 'phi-4-mini-instruct')).toBe(true);
    expect(matchesVerifiedModel('other-cpu', 'phi-4')).toBe(false);
  });
});

describe('catalogModelForEndpointId', () => {
  const vectorizer = {
    alias: 'vectorizer-one',
    variants: [{ id: 'custom-model-one-generic-cpu:1' }],
    supportsToolCalling: false,
  };
  const phi4 = { alias: 'phi-4', variants: [{ id: 'phi-4-generic-cpu:2' }], supportsToolCalling: true };
  const phi4Mini = {
    alias: 'phi-4-mini-instruct',
    variants: [{ id: 'phi-4-mini-instruct-generic-cpu:3' }],
    supportsToolCalling: true,
  };
  const models = [phi4, vectorizer, phi4Mini];

  it('resolves an opaque variant id, with or without its version, to its alias', () => {
    expect(catalogModelForEndpointId(models, 'custom-model-one-generic-cpu')).toBe(vectorizer);
    expect(catalogModelForEndpointId(models, 'custom-model-one-generic-cpu:1')).toBe(vectorizer);
    expect(catalogModelForEndpointId(models, 'Custom-Model-One-Generic-CPU')).toBe(vectorizer);
  });

  it('resolves an alias exactly', () => {
    expect(catalogModelForEndpointId(models, 'vectorizer-one')).toBe(vectorizer);
    expect(catalogModelForEndpointId(models, 'phi-4')).toBe(phi4);
  });

  it('falls back to the longest alias prefix only when no id matches', () => {
    // Not a listed variant of either model; the prefix rule prefers the longer alias.
    expect(catalogModelForEndpointId(models, 'phi-4-mini-instruct-generic-cuda')).toBe(phi4Mini);
    expect(catalogModelForEndpointId(models, 'phi-4-generic-cuda')).toBe(phi4);
    expect(catalogModelForEndpointId(models, 'unrelated-model')).toBeNull();
  });
});
