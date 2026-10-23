// Live OpenAI-compatible checks. Every request uses global fetch.
// --self-test checks parsers only and does not open a socket.
//
// Against a running Flint gateway:
//   node .\scripts\openai-live.mjs --base http://127.0.0.1:5272/v1 --model <id>
//
// The Foundry 2.1.0 spike calls runOpenAiLive after it starts Foundry's own listener.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const READY_PROMPT = 'Reply with the single word: ready';
export const TOOL_PROMPT = 'Call pick_color with blue.';
export const COLOR_TOOL = [{
  type: 'function',
  function: {
    name: 'pick_color',
    description: 'Pick one color.',
    parameters: {
      type: 'object',
      properties: { color: { type: 'string', enum: ['red', 'blue'] } },
      required: ['color'],
    },
  },
}];

export function v1Base(root) {
  const trimmed = String(root || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('--base is required');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function mergeToolDeltas(calls) {
  const byIndex = new Map();
  for (const call of calls) {
    const index = Number.isInteger(call?.index) ? call.index : 0;
    const prev = byIndex.get(index) ?? { index, id: null, name: '', arguments: '' };
    if (typeof call?.id === 'string' && call.id) prev.id = call.id;
    if (typeof call?.callId === 'string' && call.callId) prev.id = call.callId;
    if (typeof call?.function?.name === 'string') prev.name += call.function.name;
    else if (typeof call?.name === 'string' && call.name) prev.name = call.name;
    if (typeof call?.function?.arguments === 'string') prev.arguments += call.function.arguments;
    else if (typeof call?.arguments === 'string' && !call?.function) prev.arguments = call.arguments;
    byIndex.set(index, prev);
  }
  return [...byIndex.values()];
}

export function judgeToolCall(call) {
  if (!call) return { wellFormed: false, reason: 'no tool call' };
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(call.arguments || '');
  } catch (error) {
    parseError = error?.message ?? String(error);
  }
  const color = typeof parsed?.color === 'string' ? parsed.color : null;
  const wellFormed = call.name === 'pick_color' && !parseError && (color === 'red' || color === 'blue');
  return {
    wellFormed,
    id: call.id || null,
    name: call.name || null,
    arguments: (call.arguments || '').slice(0, 2000),
    color,
    parseError,
  };
}

export function secondTurnMessages(call, judgment, userText = TOOL_PROMPT) {
  if (!call?.id) return null;
  const content = judgment.wellFormed
    ? JSON.stringify({ color: judgment.color })
    : (call.arguments || '');
  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: call.id,
        type: 'function',
        function: { name: call.name || 'pick_color', arguments: call.arguments || '' },
      }],
    },
    { role: 'tool', tool_call_id: call.id, content },
  ];
}

function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    promptTokens: usage.prompt_tokens ?? usage.promptTokens ?? null,
    completionTokens: usage.completion_tokens ?? usage.completionTokens ?? null,
    totalTokens: usage.total_tokens ?? usage.totalTokens ?? null,
  };
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function absorbChoice(state, parsed) {
  const choice = parsed?.choices?.[0];
  const message = choice?.message;
  const delta = choice?.delta;
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  const content = textOf(message?.content) || textOf(delta?.content);
  const reasoning = textOf(message?.reasoning) || textOf(delta?.reasoning)
    || textOf(message?.reasoning_content) || textOf(delta?.reasoning_content);
  if (content && state.text.length < 4000) state.text += content;
  if (reasoning && state.reasoning.length < 4000) state.reasoning += reasoning;
  const calls = message?.tool_calls ?? delta?.tool_calls;
  if (Array.isArray(calls)) state.deltas.push(...calls);
  const usage = mapUsage(parsed?.usage);
  if (usage) state.usage = usage;
  if (typeof parsed?.model === 'string') state.model = parsed.model;
}

export function parseSse(raw) {
  const state = {
    text: '',
    reasoning: '',
    deltas: [],
    usage: null,
    finishReason: null,
    model: null,
    done: false,
    eventCount: 0,
  };
  for (const line of String(raw || '').split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    state.eventCount += 1;
    if (payload === '[DONE]') {
      state.done = true;
      continue;
    }
    try {
      absorbChoice(state, JSON.parse(payload));
    } catch {
      // A non-JSON data line is not a token and not a terminal marker.
    }
  }
  return {
    text: state.text,
    reasoning: state.reasoning,
    toolCalls: mergeToolDeltas(state.deltas),
    usage: state.usage,
    finishReason: state.finishReason,
    model: state.model,
    done: state.done,
    eventCount: state.eventCount,
  };
}

export function judgeModels(status, json) {
  const data = json?.data;
  return {
    ok: status === 200 && Array.isArray(data),
    count: Array.isArray(data) ? data.length : 0,
    object: typeof json?.object === 'string' ? json.object : null,
  };
}

export function listedModel(json, model) {
  const wanted = String(model || '').toLowerCase();
  if (!wanted || !Array.isArray(json?.data)) return false;
  return json.data.some((row) => {
    const id = typeof row?.id === 'string' ? row.id.toLowerCase() : '';
    const parent = typeof row?.parent === 'string' ? row.parent.toLowerCase() : '';
    return id === wanted || parent === wanted;
  });
}

function assistantText(json) {
  const message = json?.choices?.[0]?.message;
  return {
    content: textOf(message?.content),
    reasoning: textOf(message?.reasoning) || textOf(message?.reasoning_content),
    finishReason: json?.choices?.[0]?.finish_reason ?? null,
    model: typeof json?.model === 'string' ? json.model : null,
    usage: mapUsage(json?.usage),
  };
}

export function judgeChat(status, json) {
  const answer = assistantText(json);
  const visible = answer.content.trim() || answer.reasoning.trim();
  return {
    ok: status === 200 && visible.length > 0,
    ...answer,
    text: (answer.content || answer.reasoning).slice(0, 200),
  };
}

export function judgeErrorEnvelope(status, json) {
  const message = json?.error?.message;
  return {
    ok: status >= 400 && status < 600 && typeof message === 'string' && message.trim().length > 0,
    status,
    message: typeof message === 'string' ? message.slice(0, 300) : null,
  };
}

export function judgeEmbeddings(status, json) {
  const vector = json?.data?.[0]?.embedding;
  const ok = status === 200
    && Array.isArray(vector)
    && vector.length > 0
    && vector.every((item) => typeof item === 'number' && Number.isFinite(item));
  return { ok, dimensions: ok ? vector.length : 0 };
}

export function judgeTranscript(status, json) {
  return {
    ok: status === 200 && typeof json?.text === 'string',
    text: typeof json?.text === 'string' ? json.text.slice(0, 200) : null,
  };
}

function check(name, required, ok, detail, extra = {}) {
  return { name, required, ok: Boolean(ok), detail, ...extra };
}

async function readResponse(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get('content-type'),
    text,
    json,
  };
}

function chatBody(model, messages, extra = {}) {
  return JSON.stringify({
    model,
    messages,
    max_tokens: 256,
    ...extra,
  });
}

export function silentWav() {
  const sampleRate = 16000;
  const samples = 1600;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function disconnectStream(base, model, timeoutMs) {
  const controller = new AbortController();
  let settled = false;
  const pending = fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: chatBody(model, [{ role: 'user', content: 'Keep writing until stopped.' }], { stream: true, max_tokens: 64 }),
    signal: controller.signal,
  }).then((res) => {
    settled = true;
    return res;
  }, (error) => {
    settled = true;
    throw error;
  });
  const started = await Promise.race([
    pending.then((res) => ({ kind: 'headers', res })).catch((error) => ({ kind: 'error', error })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'slow' }), Math.min(timeoutMs, 30000))),
  ]);
  if (started.kind !== 'headers') {
    controller.abort();
    return {
      ok: false,
      detail: started.kind === 'error'
        ? (started.error?.message ?? String(started.error))
        : 'Streaming response did not start.',
    };
  }
  if (!started.res.ok) {
    controller.abort();
    return { ok: false, detail: `HTTP ${started.res.status}; stream did not start.` };
  }
  const reader = started.res.body?.getReader?.() ?? null;
  if (!reader) {
    controller.abort();
    return { ok: false, detail: 'Streaming response had no body.' };
  }
  const read = reader.read().then(() => 'read', () => 'rejected');
  await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 2000))]);
  controller.abort();
  const outcome = await Promise.race([
    read.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve(settled ? 'settled' : 'timeout'), 5000)),
  ]);
  try { await reader.cancel(); } catch { /* the abort already owns the body */ }
  return {
    ok: outcome !== 'timeout',
    detail: outcome === 'timeout'
      ? 'Abort did not settle the stream within 5s.'
      : 'Abort settled the stream. Native generation may still finish.',
  };
}

export async function waitForHttpOk(url, deadlineMs = 20000) {
  const started = Date.now();
  let last = 'not requested';
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return { ok: true, status: res.status };
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error?.message ?? String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, error: last };
}

export async function runOpenAiLive(options) {
  const base = v1Base(options.base);
  const model = options.model ? String(options.model) : '';
  const timeoutMs = options.timeoutMs ?? 180_000;
  const requireTools = options.requireTools === true;
  const checks = [];
  const report = { base, model: model || null, checks, requiredOk: false };

  const models = await readResponse(`${base}/models`, { method: 'GET' }, 30_000);
  const modelsJudgment = judgeModels(models.status, models.json);
  checks.push(check(
    'models',
    true,
    modelsJudgment.ok,
    modelsJudgment.ok
      ? `GET /v1/models returned ${modelsJudgment.count} rows.`
      : `GET /v1/models HTTP ${models.status}; data is not an array.`,
    { count: modelsJudgment.count, object: modelsJudgment.object },
  ));

  if (model) {
    checks.push(check(
      'model-listed',
      false,
      listedModel(models.json, model),
      listedModel(models.json, model)
        ? `${model} is in GET /v1/models.`
        : `${model} is not in GET /v1/models. Chat still uses the requested id.`,
    ));
    const retrieved = await readResponse(`${base}/models/${encodeURIComponent(model)}`, { method: 'GET' }, 30_000);
    checks.push(check(
      'model-get',
      false,
      retrieved.status === 200,
      `GET /v1/models/${model} HTTP ${retrieved.status}.`,
    ));
  }

  const missing = await readResponse(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: chatBody('flint-openai-live-missing', [{ role: 'user', content: 'ping' }], { max_tokens: 1 }),
  }, 30_000);
  const errorJudgment = judgeErrorEnvelope(missing.status, missing.json);
  checks.push(check(
    'error',
    true,
    errorJudgment.ok,
    errorJudgment.ok
      ? `Unknown model returned HTTP ${errorJudgment.status}: ${errorJudgment.message}`
      : `Unknown model HTTP ${missing.status}; body is not an OpenAI error envelope.`,
  ));

  if (!model) {
    report.requiredOk = checks.filter((item) => item.required).every((item) => item.ok);
    return report;
  }

  const chat = await readResponse(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: chatBody(model, [{ role: 'user', content: READY_PROMPT }]),
  }, timeoutMs);
  const chatJudgment = judgeChat(chat.status, chat.json);
  checks.push(check(
    'chat',
    true,
    chatJudgment.ok,
    chatJudgment.ok
      ? `Non-streaming completion returned text (${chatJudgment.text}).`
      : `Non-streaming chat HTTP ${chat.status}; no assistant text.`,
    { usage: chatJudgment.usage, finishReason: chatJudgment.finishReason, servedModel: chatJudgment.model },
  ));
  checks.push(check(
    'usage',
    false,
    Boolean(chatJudgment.usage && (chatJudgment.usage.promptTokens != null || chatJudgment.usage.completionTokens != null)),
    chatJudgment.usage ? 'Completion included usage.' : 'Completion omitted usage.',
    { usage: chatJudgment.usage },
  ));

  const stream = await readResponse(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: chatBody(model, [{ role: 'user', content: READY_PROMPT }], { stream: true }),
  }, timeoutMs);
  const parsedStream = parseSse(stream.text);
  const streamToken = Boolean(parsedStream.text.trim() || parsedStream.reasoning.trim());
  checks.push(check(
    'stream',
    true,
    stream.status === 200 && parsedStream.done && streamToken,
    `HTTP ${stream.status}; done=${parsedStream.done}; token=${streamToken}; events=${parsedStream.eventCount}.`,
    { contentType: stream.contentType, usage: parsedStream.usage, finishReason: parsedStream.finishReason },
  ));

  const toolStream = await readResponse(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: chatBody(
      model,
      [{ role: 'user', content: TOOL_PROMPT }],
      { stream: true, tools: COLOR_TOOL, tool_choice: 'auto' },
    ),
  }, timeoutMs);
  const parsedTools = parseSse(toolStream.text);
  const call = parsedTools.toolCalls[0] ?? null;
  const judgment = judgeToolCall(call);
  const toolHttpOk = toolStream.status === 200 && parsedTools.done;
  checks.push(check(
    'tools',
    true,
    toolHttpOk && (!requireTools || judgment.wellFormed),
    toolHttpOk
      ? (judgment.wellFormed
        ? `Streamed tool call ${judgment.name} color=${judgment.color}.`
        : 'Stream finished with no well-formed pick_color call.')
      : `Tool stream HTTP ${toolStream.status}; done=${parsedTools.done}.`,
    { judgment, finishReason: parsedTools.finishReason },
  ));

  const followUp = secondTurnMessages(call, judgment);
  if (followUp) {
    const second = await readResponse(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody(model, followUp),
    }, timeoutMs);
    const secondJudgment = judgeChat(second.status, second.json);
    checks.push(check(
      'tool-boundary',
      requireTools || toolHttpOk,
      second.status === 200 && (secondJudgment.ok || secondJudgment.finishReason),
      second.status === 200
        ? `Second turn finished (${secondJudgment.finishReason ?? 'no finish_reason'}): ${secondJudgment.text}`
        : `Second turn HTTP ${second.status}.`,
      { finishReason: secondJudgment.finishReason, usage: secondJudgment.usage },
    ));
  } else {
    checks.push(check('tool-boundary', false, false, call ? 'Tool call had no id.' : 'No tool call to continue.'));
  }

  const disconnected = await disconnectStream(base, model, timeoutMs);
  checks.push(check('disconnect', true, disconnected.ok, disconnected.detail));

  if (options.embedModel) {
    const embedded = await readResponse(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: options.embedModel, input: 'ping' }),
    }, timeoutMs);
    const embeddedJudgment = judgeEmbeddings(embedded.status, embedded.json);
    checks.push(check(
      'embeddings',
      true,
      embeddedJudgment.ok,
      embeddedJudgment.ok
        ? `POST /v1/embeddings returned a ${embeddedJudgment.dimensions}-d vector.`
        : `POST /v1/embeddings HTTP ${embedded.status}; no numeric vector.`,
    ));
  }

  if (options.speechModel) {
    const form = new FormData();
    form.set('model', options.speechModel);
    form.set('file', new Blob([silentWav()], { type: 'audio/wav' }), 'ping.wav');
    const speech = await readResponse(`${base}/audio/transcriptions`, { method: 'POST', body: form }, timeoutMs);
    const speechJudgment = judgeTranscript(speech.status, speech.json);
    checks.push(check(
      'speech',
      true,
      speechJudgment.ok,
      speechJudgment.ok
        ? 'POST /v1/audio/transcriptions returned text.'
        : `POST /v1/audio/transcriptions HTTP ${speech.status}; no text field.`,
    ));
  }

  const responses = await readResponse(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: READY_PROMPT }),
  }, timeoutMs);
  checks.push(check(
    'responses',
    false,
    responses.status === 200 && responses.json && typeof responses.json === 'object',
    `POST /v1/responses HTTP ${responses.status}.`,
  ));

  report.requiredOk = checks.filter((item) => item.required).every((item) => item.ok);
  return report;
}

function parseArgs(argv) {
  const out = {
    selfTest: false,
    base: '',
    model: '',
    embedModel: '',
    speechModel: '',
    requireTools: false,
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--self-test') out.selfTest = true;
    else if (arg === '--require-tools') out.requireTools = true;
    else if (arg === '--base') out.base = argv[++i] ?? '';
    else if (arg === '--model') out.model = argv[++i] ?? '';
    else if (arg === '--embed-model') out.embedModel = argv[++i] ?? '';
    else if (arg === '--speech-model') out.speechModel = argv[++i] ?? '';
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1000) {
    throw new Error('--timeout-ms must be an integer of at least 1000');
  }
  return out;
}

function runSelfTest() {
  assert.equal(v1Base('http://127.0.0.1:5272/v1/'), 'http://127.0.0.1:5272/v1');
  assert.equal(v1Base('http://127.0.0.1:5272'), 'http://127.0.0.1:5272/v1');
  const merged = mergeToolDeltas([
    { index: 0, id: 'call_1', function: { name: 'pick_', arguments: '' } },
    { index: 0, function: { name: 'color', arguments: '{"color":' } },
    { index: 0, function: { arguments: '"blue"}' } },
  ]);
  const judgment = judgeToolCall(merged[0]);
  assert.equal(judgment.wellFormed, true);
  assert.equal(judgment.color, 'blue');
  const sse = [
    'data: {"choices":[{"delta":{"content":"rea"}}]}',
    'data: {"choices":[{"delta":{"content":"dy"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
    'data: [DONE]',
    '',
  ].join('\n');
  const parsed = parseSse(sse);
  assert.equal(parsed.done, true);
  assert.equal(parsed.text, 'ready');
  assert.equal(parsed.usage.promptTokens, 3);
  assert.equal(judgeModels(200, { object: 'list', data: [{ id: 'm' }] }).ok, true);
  assert.equal(judgeModels(200, { error: { message: 'nope' } }).ok, false);
  assert.equal(listedModel({ data: [{ id: 'Qwen', parent: 'alias' }] }, 'alias'), true);
  assert.equal(judgeChat(200, { choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] }).ok, true);
  assert.equal(judgeChat(200, { choices: [{ message: { content: '' } }] }).ok, false);
  assert.equal(judgeErrorEnvelope(404, { error: { message: 'missing', type: 'invalid_request_error' } }).ok, true);
  assert.equal(judgeErrorEnvelope(200, { error: { message: 'missing' } }).ok, false);
  assert.equal(judgeEmbeddings(200, { data: [{ embedding: [0.25, 1] }] }).dimensions, 2);
  assert.equal(judgeTranscript(200, { text: '' }).ok, true);
  assert.equal(silentWav().subarray(0, 4).toString(), 'RIFF');
  const messages = secondTurnMessages(merged[0], judgment);
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].content, '{"color":"blue"}');
  console.log('openai-live self-test ok');
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    if (process.argv.slice(2).length !== 1) {
      console.error('--self-test takes no other arguments');
      process.exit(1);
    }
    try {
      runSelfTest();
    } catch (error) {
      console.error(error?.stack ?? error?.message ?? error);
      process.exit(1);
    }
  } else {
    runOpenAiLive({
      base: args.base,
      model: args.model,
      embedModel: args.embedModel,
      speechModel: args.speechModel,
      requireTools: args.requireTools,
      timeoutMs: args.timeoutMs,
    }).then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.requiredOk) process.exit(2);
    }).catch((error) => {
      console.error(error?.stack ?? error?.message ?? error);
      process.exit(1);
    });
  }
}
