#!/usr/bin/env node
/**
 * Example sidecar wrapper for Foundry Local SDK.
 * Run with: node sidecar/foundry-sidecar.js
 *
 * Communicates over stdio with JSON lines for Tauri shell plugin.
 *
 * In real use:
 * - Bundle this as sidecar binary? (use pkg or vercel/pkg for portable node)
 * - Or better: port to Rust SDK in src-tauri and use invoke.
 *
 * Commands:
 * { "cmd": "init", "appName": "flint" }
 * { "cmd": "listModels" }
 * { "cmd": "download", "alias": "..." }
 * etc.
 */

import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// --- Command allowlist and schema (mirrors src/lib/ipc-contracts.ts) ---
const KNOWN_COMMANDS = new Set([
  'init', 'setLogLevel', 'startService', 'stopService', 'getStatus',
  'listModels', 'download', 'load', 'unload', 'deleteModel', 'getEndpoint',
  'chatCompletion', 'cancelChatRequest', 'transcribeAudio',
  'getEps', 'ensureAccelerators', 'getVisionModels', 'getSTTModels',
]);

// Per-command type requirements. Keys are required or optional field names; values are:
// 'number', 'string' (any string), 'non-empty-string', 'array'.
const FIELD_TYPES = {
  init:              { appName: 'non-empty-string', logLevel: 'non-empty-string' },
  setLogLevel:       { level: 'non-empty-string' },
  startService:      { port: 'number' },
  download:          { alias: 'non-empty-string' },
  load:              { alias: 'non-empty-string' },
  unload:            { alias: 'non-empty-string' },
  deleteModel:       { alias: 'non-empty-string' },
  chatCompletion:    { model: 'non-empty-string', messages: 'array' },
  cancelChatRequest: { requestId: 'number' },
  transcribeAudio:   { audioBase64: 'string', mimeType: 'non-empty-string', fileName: 'non-empty-string', model: 'non-empty-string', language: 'non-empty-string' },
};

// Commands that accept a lane field; validated to 'chat' | 'audio'.
const LANE_CMDS = new Set(['load', 'unload']);
const VALID_LANES = new Set(['chat', 'audio']);

// Each entry lists required fields and all allowed optional fields.
// Payloads with unknown fields are rejected to prevent injection attacks.
const COMMAND_SCHEMA = {
  init:               { required: ['appName', 'logLevel'], optional: [] },
  setLogLevel:        { required: ['level'], optional: [] },
  startService:       { required: ['port'], optional: ['alias', 'preferredEp'] },
  stopService:        { required: [], optional: [] },
  getStatus:          { required: [], optional: [] },
  listModels:         { required: [], optional: [] },
  download:           { required: ['alias'], optional: [] },
  load:               { required: ['alias'], optional: ['lane'] },
  unload:             { required: ['alias'], optional: ['lane'] },
  deleteModel:        { required: ['alias'], optional: [] },
  getEndpoint:        { required: [], optional: [] },
  chatCompletion:     { required: ['model', 'messages'], optional: ['maxTokens', 'temperature', 'preferredEp', 'stream'] },
  cancelChatRequest:  { required: ['requestId'], optional: [] },
  transcribeAudio:    { required: ['audioBase64', 'mimeType', 'fileName', 'model', 'language'], optional: ['temperature', 'preferredEp'] },
  getEps:             { required: [], optional: [] },
  ensureAccelerators: { required: [], optional: [] },
  getVisionModels:    { required: [], optional: [] },
  getSTTModels:       { required: [], optional: [] },
};

// Base64 character limit for transcribeAudio. Base64 inflates by ~33%, so 50 M chars ≈ 37.5 MB decoded audio.
const AUDIO_BASE64_MAX_CHARS = 50 * 1024 * 1024;

/**
 * Validates a command name and its payload fields.
 * Returns an error string if invalid, or null if the command is well-formed.
 */
function validateCommand(cmd, payload) {
  if (!KNOWN_COMMANDS.has(cmd)) {
    return `Unknown command: ${cmd}`;
  }
  const schema = COMMAND_SCHEMA[cmd];
  for (const field of schema.required) {
    if (payload[field] === undefined) {
      return `Command "${cmd}" missing required field: ${field}`;
    }
  }
  const knownFields = new Set([...schema.required, ...schema.optional]);
  for (const field of Object.keys(payload)) {
    if (!knownFields.has(field)) {
      return `Command "${cmd}" has unknown field: ${field}`;
    }
  }
  // Type/value validation (required + selected optional fields)
  const typeRules = FIELD_TYPES[cmd];
  if (typeRules) {
    for (const [field, expected] of Object.entries(typeRules)) {
      const value = payload[field];
      if (value === undefined) continue; // already caught by required check above
      if (expected === 'number' && typeof value !== 'number') return `Command "${cmd}" field "${field}" must be a number`;
      if (expected === 'non-empty-string' && (typeof value !== 'string' || !value.trim())) return `Command "${cmd}" field "${field}" must be a non-empty string`;
      if (expected === 'string' && typeof value !== 'string') return `Command "${cmd}" field "${field}" must be a string`;
      if (expected === 'array' && !Array.isArray(value)) return `Command "${cmd}" field "${field}" must be an array`;
    }
  }
  if (payload.preferredEp !== undefined && typeof payload.preferredEp !== 'string') return `Command "${cmd}" field "preferredEp" must be a string`;
  if (cmd === 'startService' && payload.alias !== undefined && (typeof payload.alias !== 'string' || !payload.alias.trim())) return `Command "startService" field "alias" must be a non-empty string`;
  if ((cmd === 'chatCompletion' || cmd === 'transcribeAudio') && payload.temperature !== undefined && typeof payload.temperature !== 'number') return `Command "${cmd}" field "temperature" must be a number`;
  if (cmd === 'chatCompletion') {
    if (payload.stream !== undefined && typeof payload.stream !== 'boolean') return `Command "chatCompletion" field "stream" must be a boolean`;
    if (payload.maxTokens !== undefined && typeof payload.maxTokens !== 'number') return `Command "chatCompletion" field "maxTokens" must be a number`;
  }
  // Lane validation for commands that accept a lane field
  if (LANE_CMDS.has(cmd) && payload.lane !== undefined && !VALID_LANES.has(payload.lane)) {
    return `Command "${cmd}" invalid lane "${payload.lane}": must be "chat" or "audio"`;
  }
  if (cmd === 'transcribeAudio' && payload.audioBase64.length > AUDIO_BASE64_MAX_CHARS) {
    return `Command "transcribeAudio" audioBase64 exceeds maximum allowed size`;
  }
  return null;
}
// --- end allowlist ---

let manager = null;
let FoundryLocalManager = null;
const canceledRequests = new Set();

// Per-lane model and endpoint state.
// Each lane tracks its own loaded model independently, preventing chat/audio thrash.
// sharedEndpoint is set by startService and used by both lanes as the default HTTP endpoint.
const lane = {
  chat:  { model: null, endpoint: null },
  audio: { model: null, endpoint: null },
};
let sharedEndpoint = null;

function resolveLaneEndpoint(which) {
  return lane[which].endpoint || sharedEndpoint;
}

async function ensureLaneModel(which, alias) {
  const existing = lane[which].model;
  if (!existing || existing.alias !== alias) {
    lane[which].model = await manager.catalog.getModel(alias);
    await lane[which].model.load();
    log('info', `Model ${alias} loaded in ${which} lane`);
  } else if (typeof existing.isLoaded === 'boolean' && !existing.isLoaded) {
    await existing.load();
    log('info', `Model ${alias} reloaded (runtime eviction) in ${which} lane`);
  }
  return lane[which].model;
}

async function applyPreferredExecutionProvider (preferredEp, model) {
  const value = String(preferredEp || '').trim();
  if (!value || !manager) {
    return { requested: value || null, applied: null, method: null };
  }

  const candidateTargets = [manager, model].filter(Boolean);
  const candidateMethods = [
    'setPreferredExecutionProvider',
    'setPreferredEp',
    'setExecutionProviderPreference',
    'setEpPreference'
  ];

  for (const target of candidateTargets) {
    for (const methodName of candidateMethods) {
      const method = target?.[methodName];
      if (typeof method === 'function') {
        try {
          await method.call(target, value);
          log('info', `Applied preferred execution provider "${value}" via ${methodName}`);
          return { requested: value, applied: value, method: methodName };
        } catch (err) {
          log('warn', `Failed applying preferred EP via ${methodName}: ${err?.message || err}`);
        }
      }
    }
  }

  log('warn', `Preferred execution provider "${value}" is not supported by this runtime API`);
  return { requested: value, applied: null, method: null };
}

async function detectActiveExecutionProvider (model) {
  if (!model) return null;

  const directProps = ['executionProvider', 'activeExecutionProvider', 'currentExecutionProvider', 'provider'];
  for (const prop of directProps) {
    const value = model[prop];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const methodCandidates = ['getExecutionProvider', 'getCurrentExecutionProvider', 'getProvider'];
  for (const methodName of methodCandidates) {
    const method = model?.[methodName];
    if (typeof method !== 'function') continue;
    try {
      const value = await method.call(model);
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    } catch (err) {
      log('warn', `Execution provider probe failed via ${methodName}: ${err?.message || err}`);
    }
  }

  return null;
}

function getOpenAiApiBase (endpoint) {
  const trimmed = String(endpoint || '').replace(/\/+$/, '');
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

async function readErrorBody (resp) {
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const json = await resp.json();
      return JSON.stringify(json);
    } catch {
      // fall back to text
    }
  }
  const text = await resp.text();
  return text || '';
}

function toSdkMessages (messages) {
  return (messages || [])
    .filter((m) => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content ?? '') }));
}

function normalizeText (value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function segmentTextsFromValue (segments) {
  if (!Array.isArray(segments)) return [];
  const values = [];
  for (const segment of segments) {
    const text = normalizeText(segment?.text ?? segment?.transcript ?? '');
    if (!text) continue;
    values.push(text);
  }
  return values;
}

function extractTranscriptCandidate (value) {
  const text = normalizeText(value?.text ?? '');
  const segmentTexts = segmentTextsFromValue(value?.segments);
  const segmentText = normalizeText(segmentTexts.join(' '));
  const combined = text && segmentText
    ? (text.length >= segmentText.length ? text : segmentText)
    : (text || segmentText);
  return {
    text: combined,
    segmentTexts
  };
}

function dedupeAdjacentSegments (segmentTexts) {
  const cleaned = [];
  for (const text of segmentTexts) {
    const normalized = normalizeText(text);
    if (!normalized) continue;
    const last = cleaned[cleaned.length - 1];
    if (last === normalized) continue;
    cleaned.push(normalized);
  }
  return cleaned;
}

function scoreTranscriptCandidate (candidate) {
  const text = normalizeText(candidate?.text ?? '');
  const segmentTexts = dedupeAdjacentSegments(candidate?.segmentTexts || []);
  const charCount = text.length;
  const wordCount = text ? text.split(/\s+/).length : 0;
  const avgWordLen = wordCount ? charCount / wordCount : 0;
  let score = charCount + (wordCount * 4);
  if (segmentTexts.length > 0) score += segmentTexts.length * 2;
  if (wordCount <= 3) score -= 100;
  if (avgWordLen > 12) score -= 40;
  if (avgWordLen < 2 && wordCount > 3) score -= 20;
  return {
    text,
    segmentTexts,
    charCount,
    wordCount,
    score
  };
}

function isLikelyIncompleteTranscript (candidate) {
  const stats = scoreTranscriptCandidate(candidate);
  return stats.wordCount <= 3 || stats.charCount < 24;
}

function pickBetterTranscript (a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;

  const scoreA = scoreTranscriptCandidate(a);
  const scoreB = scoreTranscriptCandidate(b);
  if (scoreB.score > scoreA.score) return b;
  return a;
}

function buildTranscriptResult (candidate, extras = {}) {
  const stats = scoreTranscriptCandidate(candidate || {});
  const base = {
    text: stats.text,
    segments: stats.segmentTexts.map((text) => ({ text }))
  };
  return { ...base, ...extras };
}

function send (msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log (level, message) {
  // At least enabling logging (sent to stdout for now; UI can consume later)
  send({ type: 'log', level, message, timestamp: Date.now() });
}

async function getFoundryManager () {
  if (FoundryLocalManager) return FoundryLocalManager;
  try {
    // Try normal module resolution (works in dev when node_modules is present)
    const mod = await import('foundry-local-sdk');
    FoundryLocalManager = mod.FoundryLocalManager;
    return FoundryLocalManager;
  } catch (err) {
    log('warn', `Normal SDK import failed (${err?.message || err}), trying bundled resource path`);
    // In prod bundle: we ship ../node_modules/foundry-local-sdk via tauri resources
    // sidecar is at <res>/sidecar/..., SDK at <res>/foundry-local-sdk/dist/index.js
    const base = path.resolve(__dirname, '..');
    const sdkEntry = path.join(base, 'foundry-local-sdk', 'dist', 'index.js').replace(/\\/g, '/');
    const fileUrl = 'file:///' + (sdkEntry.startsWith('/') ? sdkEntry.slice(1) : sdkEntry);
    const mod = await import(fileUrl);
    FoundryLocalManager = mod.FoundryLocalManager;
    return FoundryLocalManager;
  }
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    send({ id: null, error: 'Invalid JSON' });
    return;
  }

  const { id, cmd, ...payload } = msg;

  const reply = (result) => {
    send({ id, ...result });
  };

  const validationError = validateCommand(cmd, payload);
  if (validationError) {
    reply({ error: validationError });
    return;
  }

  try {
    if (cmd === 'init') {
      const FManager = await getFoundryManager();
      const appName = payload.appName || 'flint';
      manager = FManager.create({ appName, logLevel: payload.logLevel || 'info' });
      log('info', `SDK initialized for ${appName}`);
      reply({ ok: true, result: 'initialized' });
    } else if (cmd === 'listModels') {
      const models = await manager.catalog.getModels();
      reply({
        ok: true, result: models.map(m => ({
          alias: m.alias,
          cached: m.isCached,
          size: m.info?.fileSizeMb,
          task: m.info?.task,
          capabilities: m.info?.capabilities,
          // Context length is very useful for trimming decisions
          contextLength: m.info?.contextLength ?? m.info?.maxContext ?? null,
          family: m.info?.family || null,
          info: m.info || {}
        }))
      });
    } else if (cmd === 'getSTTModels') {
      const all = await manager.catalog.getModels();
      const stt = all.filter(m => {
        const t = (m.info?.task || '').toLowerCase();
        const caps = (m.info?.capabilities || '').toLowerCase();
        return t.includes('automatic-speech-recognition') || t.includes('stt') || caps.includes('automatic-speech-recognition');
      });
      reply({ ok: true, result: stt.map(m => ({ alias: m.alias, cached: m.isCached })) });
    } else if (cmd === 'getVisionModels') {
      const all = await manager.catalog.getModels();
      const vision = all.filter(m => {
        const t = (m.info?.task || '').toLowerCase();
        const caps = (m.info?.capabilities || '').toLowerCase();
        const alias = (m.alias || '').toLowerCase();
        return t.includes('vision') || caps.includes('vision') || caps.includes('image') || alias.includes('vision') || alias.includes('multimodal');
      });
      reply({ ok: true, result: vision.map(m => ({ alias: m.alias, cached: m.isCached })) });
    } else if (cmd === 'download') {
      const model = await manager.catalog.getModel(payload.alias);
      await model.download((p) => send({ id, progress: p, alias: payload.alias }));
      reply({ ok: true });
    } else if (cmd === 'load') {
      const which = payload.lane || 'chat';
      log('info', `Loading model ${payload.alias} into ${which} lane`);
      const loaded = await ensureLaneModel(which, payload.alias);
      const acceleration = {
        requested: null,
        active: await detectActiveExecutionProvider(loaded)
      };
      log('info', `Model ${payload.alias} ready in ${which} lane (accel: ${acceleration.active || 'cpu'})`);
      reply({ ok: true, result: { acceleration, lane: which } });
    } else if (cmd === 'unload') {
      const alias = payload.alias;
      const which = payload.lane ||
        (lane.chat.model?.alias === alias ? 'chat' :
         lane.audio.model?.alias === alias ? 'audio' : null);
      if (which && lane[which].model) {
        await lane[which].model.unload();
        lane[which].model = null;
        log('info', `Model ${alias} unloaded from ${which} lane`);
      }
      reply({ ok: true });
    } else if (cmd === 'deleteModel') {
      if (!payload.alias) {
        throw new Error('deleteModel requires alias');
      }
      const model = await manager.catalog.getModel(payload.alias);
      if (!model) {
        throw new Error(`Model not found: ${payload.alias}`);
      }
      for (const which of ['chat', 'audio']) {
        if (lane[which].model?.alias === payload.alias && typeof lane[which].model.unload === 'function') {
          await lane[which].model.unload();
          lane[which].model = null;
        }
      }
      const deleteMethods = ['delete', 'remove', 'removeFromDisk', 'purgeCache', 'uninstall'];
      let deleted = false;
      for (const methodName of deleteMethods) {
        const method = model?.[methodName];
        if (typeof method === 'function') {
          await method.call(model);
          deleted = true;
          log('info', `Model ${payload.alias} deleted via ${methodName}`);
          break;
        }
      }
      if (!deleted) {
        throw new Error('Runtime does not expose a model deletion API');
      }
      reply({ ok: true });
    } else if (cmd === 'startService') {
      const desired = payload.alias;
      if (desired) {
        await ensureLaneModel('chat', desired);
      }
      const preferred = await applyPreferredExecutionProvider(payload.preferredEp, lane.chat.model);
      if (!lane.chat.model) {
        throw new Error('No model loaded in chat lane (pass alias or load first)');
      }
      // Use the SDK's web service if available
      if (typeof manager.startWebService === 'function') {
        const info = await manager.startWebService({ port: payload.port || 5272 });
        sharedEndpoint = info?.endpoint || info?.url || `http://localhost:${payload.port || 5272}/v1`;
      } else {
        sharedEndpoint = `http://localhost:${payload.port || 5272}/v1`;
      }
      log('info', `Service started at ${sharedEndpoint}`);
      reply({
        ok: true,
        endpoint: sharedEndpoint,
        result: {
          acceleration: {
            requested: preferred?.requested ?? null,
            preferredApplied: preferred?.applied ?? null,
            active: await detectActiveExecutionProvider(lane.chat.model)
          }
        }
      });
    } else if (cmd === 'stopService') {
      sharedEndpoint = null;
      lane.chat.endpoint = null;
      lane.audio.endpoint = null;
      log('info', 'Service stop requested');
      reply({ ok: true });
    } else if (cmd === 'getEndpoint') {
      reply({ ok: true, endpoint: sharedEndpoint });
    } else if (cmd === 'getStatus') {
      reply({
        ok: true,
        result: {
          initialized: !!manager,
          modelLoaded: !!(lane.chat.model || lane.audio.model),
          currentModel: lane.chat.model?.alias,
          endpoint: sharedEndpoint,
          serviceRunning: !!sharedEndpoint,
          chatLane: { model: lane.chat.model?.alias || null, endpoint: lane.chat.endpoint || sharedEndpoint || null },
          audioLane: { model: lane.audio.model?.alias || null, endpoint: lane.audio.endpoint || sharedEndpoint || null },
        }
      });
    } else if (cmd === 'chatCompletion') {
      const modelAlias = payload.model || lane.chat.model?.alias;
      const shouldStream = !!payload.stream;
      canceledRequests.delete(id);
      if (!modelAlias) {
        throw new Error('No model selected for chat completion.');
      }
      log('debug', `Chat completion: model=${modelAlias} msgs=${payload.messages?.length ?? 0} stream=${shouldStream}`);
      const chatModel = await ensureLaneModel('chat', modelAlias);
      const apiBase = getOpenAiApiBase(resolveLaneEndpoint('chat'));
      const preferred = await applyPreferredExecutionProvider(payload.preferredEp, chatModel);

      const sdkMessages = toSdkMessages(payload.messages);
      if (!sdkMessages.length) {
        throw new Error('No valid messages supplied');
      }

      // Prefer direct SDK inference to avoid web-service schema/version mismatch issues.
      if (typeof chatModel?.createChatClient === 'function') {
        const client = chatModel.createChatClient();
        if (shouldStream && typeof client?.completeStreamingChat === 'function') {
          let content = '';
          for await (const chunk of client.completeStreamingChat(sdkMessages)) {
            if (canceledRequests.has(id)) {
              log('info', `Chat stream canceled for request ${id}`);
              break;
            }
            const deltaText = chunk?.choices?.[0]?.delta?.content;
            const messageText = chunk?.choices?.[0]?.message?.content ?? chunk?.message?.content;
            let delta = '';
            if (typeof deltaText === 'string' && deltaText) {
              delta = deltaText;
            } else if (typeof messageText === 'string' && messageText) {
              // Some runtimes emit cumulative message text instead of token deltas.
              delta = messageText.startsWith(content)
                ? messageText.slice(content.length)
                : messageText;
            }
            if (delta) {
              content += delta;
              send({
                id,
                stream: true,
                delta,
                chunk: {
                  choices: [{ delta: { role: 'assistant', content: delta } }]
                }
              });
            }
          }
          reply({
            ok: true,
            result: {
              choices: [{ message: { role: 'assistant', content } }],
              acceleration: {
                requested: preferred?.requested ?? null,
                preferredApplied: preferred?.applied ?? null,
                active: await detectActiveExecutionProvider(chatModel)
              }
            }
          });
        } else if (typeof client?.completeChat === 'function') {
          const result = await client.completeChat(sdkMessages);
          if (shouldStream) {
            const content = result?.choices?.[0]?.message?.content || '';
            if (content) {
              send({
                id,
                stream: true,
                delta: content,
                chunk: {
                  choices: [{ delta: { role: 'assistant', content } }]
                }
              });
            }
          }
          reply({
            ok: true,
            result: {
              ...result,
              acceleration: {
                requested: preferred?.requested ?? null,
                preferredApplied: preferred?.applied ?? null,
                active: await detectActiveExecutionProvider(chatModel)
              }
            }
          });
        } else if (typeof client?.completeStreamingChat === 'function') {
          let content = '';
          for await (const chunk of client.completeStreamingChat(sdkMessages)) {
            if (canceledRequests.has(id)) {
              log('info', `Chat stream canceled for request ${id}`);
              break;
            }
            const delta = chunk?.choices?.[0]?.delta?.content || '';
            if (delta) content += delta;
          }
          reply({
            ok: true,
            result: {
              choices: [{ message: { role: 'assistant', content } }],
              acceleration: {
                requested: preferred?.requested ?? null,
                preferredApplied: preferred?.applied ?? null,
                active: await detectActiveExecutionProvider(chatModel)
              }
            }
          });
        } else {
          throw new Error('Model chat client does not expose completion methods');
        }
      } else {
        if (!resolveLaneEndpoint('chat')) {
          throw new Error('Service endpoint unavailable and direct chat client is unsupported.');
        }
        const resp = await fetch(`${apiBase}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelAlias,
            messages: sdkMessages,
            stream: false,
            max_tokens: payload.maxTokens,
            temperature: payload.temperature
          })
        });
        if (!resp.ok) {
          const details = await readErrorBody(resp);
          throw new Error(`Chat completion failed (${resp.status} ${resp.statusText}): ${details}`);
        }
        const httpResult = await resp.json();
        reply({
          ok: true,
          result: {
            ...httpResult,
            acceleration: {
              requested: preferred?.requested ?? null,
              preferredApplied: preferred?.applied ?? null,
              active: await detectActiveExecutionProvider(chatModel)
            }
          }
        });
      }
      canceledRequests.delete(id);
    } else if (cmd === 'cancelChatRequest') {
      const requestId = Number(payload.requestId);
      if (Number.isFinite(requestId)) {
        canceledRequests.add(requestId);
        reply({ ok: true });
      } else {
        throw new Error('cancelChatRequest requires numeric requestId');
      }
    } else if (cmd === 'transcribeAudio') {
      if (!payload.audioBase64) {
        throw new Error('audioBase64 is required');
      }
      log('debug', `Transcription: model=${payload.model} file=${payload.fileName} lang=${payload.language || 'auto'}`);

      const requestedAlias = payload.model;
      if (requestedAlias) {
        await ensureLaneModel('audio', requestedAlias);
      }
      const audioModel = lane.audio.model;
      const preferred = await applyPreferredExecutionProvider(payload.preferredEp, audioModel);

      if (!audioModel) {
        throw new Error('No model loaded in audio lane. Select an STT model on the Audio page first.');
      }

      const bytes = Buffer.from(payload.audioBase64, 'base64');
      // Force .wav extension — the models use a strict AudioDecoder that often
      // cannot detect WebM/Opus/MP3 etc. We normalize on the client too.
      let baseName = (payload.fileName || 'audio').replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!/\.wav$/i.test(baseName)) baseName += '.wav';
      const tempFileName = `flint-audio-${Date.now()}-${baseName}`;
      const tempPath = path.join(os.tmpdir(), tempFileName);
      await fs.promises.writeFile(tempPath, bytes);

      try {
        // Prefer direct AudioClient (like we do for chat) — this avoids relying on the web service HTTP route
        // which may return 404 for /audio/transcriptions even for Whisper models.
        if (typeof audioModel.createAudioClient === 'function') {
          const audioClient = audioModel.createAudioClient();
          if (payload.language && payload.language !== 'auto') {
            audioClient.settings.language = payload.language;
          }
          if (typeof payload.temperature === 'number') {
            audioClient.settings.temperature = payload.temperature;
          }

          const debugEnabled = process.env.FLINT_TRANSCRIBE_DEBUG === '1';
          let streamingCandidate = null;
          let streamingError = null;
          let streamingChunkCount = 0;

          try {
            const chunkCandidates = [];
            let aggregatedSegments = [];
            for await (const chunk of audioClient.transcribeStreaming(tempPath)) {
              streamingChunkCount += 1;
              const candidate = extractTranscriptCandidate(chunk);
              if (candidate.text || candidate.segmentTexts.length) {
                chunkCandidates.push(candidate);
              }
              if (candidate.segmentTexts.length > 0) {
                aggregatedSegments = dedupeAdjacentSegments(aggregatedSegments.concat(candidate.segmentTexts));
              }

              if (debugEnabled && streamingChunkCount <= 8) {
                log('debug', `[transcribe] stream chunk ${streamingChunkCount} text=${candidate.text.length} chars segments=${candidate.segmentTexts.length}`);
              }
            }
            const segmentAggregateCandidate = {
              text: normalizeText(aggregatedSegments.join(' ')),
              segmentTexts: aggregatedSegments
            };
            let bestStream = segmentAggregateCandidate;
            for (const candidate of chunkCandidates) {
              bestStream = pickBetterTranscript(bestStream, candidate);
            }
            streamingCandidate = bestStream;
          } catch (streamErr) {
            streamingError = streamErr;
            console.error('[sidecar] streaming transcribe failed, evaluating sync fallback:', streamErr);
          }

          let syncCandidate = null;
          const needsSyncFallback = !streamingCandidate || isLikelyIncompleteTranscript(streamingCandidate);
          if (needsSyncFallback) {
            const syncResult = await audioClient.transcribe(tempPath);
            syncCandidate = extractTranscriptCandidate(syncResult);
          }

          let chosen = pickBetterTranscript(streamingCandidate, syncCandidate);
          let transcriptPath = 'streaming';
          if (chosen === syncCandidate && syncCandidate) transcriptPath = 'sync';
          if (streamingCandidate && syncCandidate) transcriptPath = 'hybrid';

          if (!chosen || !normalizeText(chosen.text)) {
            if (streamingError) throw streamingError;
            throw new Error('Transcription produced an empty result');
          }

          const result = buildTranscriptResult(chosen, {
            transcriptionPath: transcriptPath,
            diagnostics: {
              streamingChunks: streamingChunkCount,
              fallbackSyncUsed: needsSyncFallback
            }
          });

          reply({
            ok: true,
            result: {
              ...result,
              acceleration: {
                requested: preferred?.requested ?? null,
                preferredApplied: preferred?.applied ?? null,
                active: await detectActiveExecutionProvider(audioModel)
              }
            }
          });
          return;
        }

        // Fallback to OpenAI-compatible HTTP if direct client not available for this model
        const audioEndpoint = resolveLaneEndpoint('audio');
        if (!audioEndpoint) {
          throw new Error('Service endpoint unavailable and model has no direct audio client.');
        }
        const apiBase = getOpenAiApiBase(audioEndpoint);
        const blob = new Blob([bytes], { type: payload.mimeType || 'application/octet-stream' });
        const form = new FormData();
        form.append('file', blob, payload.fileName || 'audio.webm');
        form.append('model', payload.model || audioModel.alias);
        if (payload.language && payload.language !== 'auto') {
          form.append('language', payload.language);
        }
        const resp = await fetch(`${apiBase}/audio/transcriptions`, {
          method: 'POST',
          body: form
        });
        if (!resp.ok) {
          const details = await readErrorBody(resp);
          throw new Error(`Transcription failed (${resp.status} ${resp.statusText}): ${details}`);
        }
        const transcriptionResult = await resp.json();
        reply({
          ok: true,
          result: {
            ...transcriptionResult,
            acceleration: {
              requested: preferred?.requested ?? null,
              preferredApplied: preferred?.applied ?? null,
              active: await detectActiveExecutionProvider(audioModel)
            }
          }
        });
      } finally {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    } else if (cmd === 'getEps') {
      const eps = typeof manager.discoverEps === 'function' ? manager.discoverEps() : [];
      reply({ ok: true, result: eps });
    } else if (cmd === 'ensureAccelerators') {
      if (typeof manager.downloadAndRegisterEps === 'function') {
        await manager.downloadAndRegisterEps((name, pct) => {
          send({ id, progress: pct, ep: name });
        });
      }
      reply({ ok: true });
    } else if (cmd === 'setLogLevel') {
      // Enable logging at requested level (SDK supports via config or we just log here)
      log('info', `Log level set to ${payload.level}`);
      reply({ ok: true });
    } else {
      reply({ error: `Unknown command: ${cmd}` });
    }
  } catch (e) {
    reply({ error: e.message || String(e) });
  }
});

// Send ready as early as possible (after readline setup) so the host does not time out.
// We lazy-load the heavy Foundry SDK only on first 'init' command.
const readyMsg = { ready: true, pid: process.pid, version: '0.1.0' };
send(readyMsg);
send({ type: 'log', level: 'info', message: `Sidecar process started (pid ${process.pid}) and listening` });

// Also write to stderr for better visibility in dev mode
console.error(`[foundry-sidecar] Ready: ${JSON.stringify(readyMsg)}`);