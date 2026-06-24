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

let manager = null;
let currentEndpoint = null;
let currentModel = null;
let FoundryLocalManager = null;
const canceledRequests = new Set();

async function applyPreferredExecutionProvider (preferredEp) {
  const value = String(preferredEp || '').trim();
  if (!value || !manager) {
    return { requested: value || null, applied: null, method: null };
  }

  const candidateTargets = [manager, currentModel].filter(Boolean);
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
      currentModel = await manager.catalog.getModel(payload.alias);
      await currentModel.load();
      const acceleration = {
        requested: payload.preferredEp ? String(payload.preferredEp).trim() : null,
        active: await detectActiveExecutionProvider(currentModel)
      };
      log('info', `Model ${payload.alias} loaded`);
      reply({ ok: true, result: { acceleration } });
    } else if (cmd === 'unload') {
      if (currentModel) {
        await currentModel.unload();
        log('info', `Model unloaded`);
      }
      currentModel = null;
      reply({ ok: true });
    } else if (cmd === 'deleteModel') {
      if (!payload.alias) {
        throw new Error('deleteModel requires alias');
      }
      const model = await manager.catalog.getModel(payload.alias);
      if (!model) {
        throw new Error(`Model not found: ${payload.alias}`);
      }
      if (currentModel && currentModel.alias === payload.alias && typeof currentModel.unload === 'function') {
        await currentModel.unload();
        currentModel = null;
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
        if (!currentModel || currentModel.alias !== desired) {
          currentModel = await manager.catalog.getModel(desired);
          await currentModel.load();
          log('info', `Model ${desired} loaded during service start`);
        }
      }
      const preferred = await applyPreferredExecutionProvider(payload.preferredEp);
      if (!currentModel) {
        throw new Error('No model loaded (pass alias or load first)');
      }
      // Use the SDK's web service if available
      if (typeof manager.startWebService === 'function') {
        const info = await manager.startWebService({ port: payload.port || 5272 });
        currentEndpoint = info?.endpoint || info?.url || `http://localhost:${payload.port || 5272}/v1`;
      } else {
        // Fallback - the sidecar itself can't easily serve, but we can report default
        // In practice the main app or another mechanism would use the endpoint
        currentEndpoint = `http://localhost:${payload.port || 5272}/v1`;
      }
      log('info', `Service started at ${currentEndpoint}`);
      reply({
        ok: true,
        endpoint: currentEndpoint,
        result: {
          acceleration: {
            requested: preferred?.requested ?? null,
            preferredApplied: preferred?.applied ?? null,
            active: await detectActiveExecutionProvider(currentModel)
          }
        }
      });
    } else if (cmd === 'stopService') {
      // Best effort
      currentEndpoint = null;
      log('info', 'Service stop requested');
      reply({ ok: true });
    } else if (cmd === 'getEndpoint') {
      reply({ ok: true, endpoint: currentEndpoint });
    } else if (cmd === 'getStatus') {
      reply({
        ok: true,
        result: {
          initialized: !!manager,
          modelLoaded: !!currentModel,
          currentModel: currentModel?.alias,
          endpoint: currentEndpoint,
          serviceRunning: !!currentEndpoint
        }
      });
    } else if (cmd === 'chatCompletion') {
      const apiBase = getOpenAiApiBase(currentEndpoint);
      const modelAlias = payload.model || currentModel?.alias;
      const shouldStream = !!payload.stream;
      canceledRequests.delete(id);
      if (!modelAlias) {
        throw new Error('No model selected for chat completion.');
      }
      if (!currentModel || currentModel.alias !== modelAlias) {
        currentModel = await manager.catalog.getModel(modelAlias);
        await currentModel.load();
        log('info', `Model ${modelAlias} loaded during chat completion`);
      }
      const preferred = await applyPreferredExecutionProvider(payload.preferredEp);

      const sdkMessages = toSdkMessages(payload.messages);
      if (!sdkMessages.length) {
        throw new Error('No valid messages supplied');
      }

      // Prefer direct SDK inference to avoid web-service schema/version mismatch issues.
      if (typeof currentModel?.createChatClient === 'function') {
        const client = currentModel.createChatClient();
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
                active: await detectActiveExecutionProvider(currentModel)
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
                active: await detectActiveExecutionProvider(currentModel)
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
                active: await detectActiveExecutionProvider(currentModel)
              }
            }
          });
        } else {
          throw new Error('Model chat client does not expose completion methods');
        }
      } else {
        if (!currentEndpoint) {
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
              active: await detectActiveExecutionProvider(currentModel)
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

      const requestedAlias = payload.model;
      if (requestedAlias && (!currentModel || currentModel.alias !== requestedAlias)) {
        currentModel = await manager.catalog.getModel(requestedAlias);
        await currentModel.load();
        log('info', `Model ${requestedAlias} loaded for transcription`);
      }
      const preferred = await applyPreferredExecutionProvider(payload.preferredEp);

      if (!currentModel) {
        throw new Error('No model loaded. Select an STT model on the Audio page first.');
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
        if (typeof currentModel.createAudioClient === 'function') {
          const audioClient = currentModel.createAudioClient();
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
                active: await detectActiveExecutionProvider(currentModel)
              }
            }
          });
          return;
        }

        // Fallback to OpenAI-compatible HTTP if direct client not available for this model
        if (!currentEndpoint) {
          throw new Error('Service endpoint unavailable and model has no direct audio client.');
        }
        const apiBase = getOpenAiApiBase(currentEndpoint);
        const blob = new Blob([bytes], { type: payload.mimeType || 'application/octet-stream' });
        const form = new FormData();
        form.append('file', blob, payload.fileName || 'audio.webm');
        form.append('model', payload.model || currentModel.alias);
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
              active: await detectActiveExecutionProvider(currentModel)
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