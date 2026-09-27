// Builds ChatSession/EmbeddingsSession-backed replacements for the deprecated,
// OpenAI-shaped `createChatClient()`/`createEmbeddingClient()` wrappers removed end of
// 2026. Kept as its own module (like chat-transport.js and model-classification.js) so
// the resource-disposal contract below can be exercised directly in tests without
// spawning the full sidecar process. Receives the resolved SDK classes via `sdkModule`
// instead of importing 'foundry-local-sdk' itself, so this file has no dependency on
// Node or the native runtime, matching its siblings.

// Model output is untrusted for logging purposes: it carries generated text, tool-call
// arguments and echoed prompt content. V8's JSON.parse errors quote an excerpt of the
// input ("Unexpected token 'S', \"SENSITIVE_\"... is not valid JSON"), and the wrappers
// below copy `err.message` into the error that the sidecar forwards over IPC and into the
// app log. Parsing therefore reports only a size, matching the IPC layer's payload-free
// convention. The size is measured in real UTF-8 bytes rather than `String.length`, which
// counts UTF-16 code units and understates any non-ASCII output.
const utf8Encoder = new TextEncoder();
const CLEANUP_FAILURE_AGGREGATE = Symbol('cleanupFailureAggregate');

function parseOpenAiJson (text, description) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${description} returned output that is not valid JSON (${utf8Encoder.encode(text).length} bytes).`,
    );
  }
}

// Cleanup must never erase why the primary operation failed. If disposal itself throws,
// combine ordinary failures into one error that still exposes the primary failure as
// `cause`. AbortError identity is preserved because cancellation classification may
// depend on the exact object; its cleanup failure is reported through a safe diagnostic.
export function mergeCleanupFailure (primaryFailure, cleanupFailure, description = 'cleanup') {
  if (!primaryFailure) return cleanupFailure;
  const isPriorCleanupMerge = primaryFailure?.[CLEANUP_FAILURE_AGGREGATE] === true;
  const rootCause = isPriorCleanupMerge
    ? primaryFailure.cause
    : primaryFailure;
  const priorFailures = isPriorCleanupMerge
    ? Array.from(primaryFailure.errors)
    : [primaryFailure];
  const primaryMessage = primaryFailure?.message || String(primaryFailure);
  const cleanupMessage = cleanupFailure?.message || String(cleanupFailure);
  const aggregate = new AggregateError(
    [...priorFailures, cleanupFailure],
    `${primaryMessage}; ${description} failed: ${cleanupMessage}`,
    { cause: rootCause },
  );
  Object.defineProperty(aggregate, CLEANUP_FAILURE_AGGREGATE, { value: true });
  if (typeof rootCause?.code === 'string') aggregate.code = rootCause.code;
  return aggregate;
}

export function mergeSessionCleanupFailure (primaryFailure, cleanupFailure) {
  return mergeCleanupFailure(primaryFailure, cleanupFailure, 'session disposal');
}

function reportCleanupDiagnostic (onDiagnostic, diagnostic) {
  if (typeof onDiagnostic !== 'function') return;
  try {
    onDiagnostic(diagnostic);
  } catch {}
}

export function disposeSession (session, primaryFailure = null, {
  onDiagnostic,
  abortDiagnosticCode = 'session-dispose-after-abort',
  abortDiagnosticMessage = 'Session disposal failed after cancellation.',
} = {}) {
  if (!session) return primaryFailure;
  try {
    session.dispose();
    return primaryFailure;
  } catch (cleanupFailure) {
    if (primaryFailure?.name === 'AbortError') {
      reportCleanupDiagnostic(onDiagnostic, {
        code: abortDiagnosticCode,
        message: abortDiagnosticMessage,
      });
      return primaryFailure;
    }
    return mergeSessionCleanupFailure(primaryFailure, cleanupFailure);
  }
}

// Builds a ChatSession-backed replacement for `chatModel.createChatClient()` (the
// deprecated OpenAI-shaped wrapper, removed end of 2026). Preserves the SDK's
// OpenAI-shaped request/response bridge: each call serializes an OpenAI Chat Completion
// request into a single `Item.text(json, "openai-json")`, runs it through a
// fresh ChatSession, and recovers the response by JSON-parsing the first
// "openai-json" text item in the output. This keeps the wire shape (and every
// downstream consumer of it) byte-identical to the deprecated client while
// dropping the dependency on the class itself. Returns null if this SDK build
// does not export ChatSession/Request/Item (falls back to createChatClient()).
export function createSessionChatClient (chatModel, sdkModule, { onDiagnostic } = {}) {
  const { ChatSession, Request, Item } = sdkModule || {};
  if (typeof ChatSession !== 'function' || typeof Request !== 'function' || typeof Item?.text !== 'function') {
    return null;
  }
  const settings = {};
  const serializeSettings = () => {
    const out = {};
    if (Number.isFinite(settings.frequencyPenalty)) out.frequency_penalty = settings.frequencyPenalty;
    if (Number.isFinite(settings.maxTokens)) out.max_tokens = settings.maxTokens;
    if (Number.isFinite(settings.presencePenalty)) out.presence_penalty = settings.presencePenalty;
    if (Number.isFinite(settings.temperature)) out.temperature = settings.temperature;
    if (Number.isFinite(settings.topP)) out.top_p = settings.topP;
    const metadata = {};
    if (Number.isFinite(settings.topK)) metadata.top_k = String(settings.topK);
    if (Number.isFinite(settings.randomSeed)) metadata.random_seed = String(settings.randomSeed);
    if (Object.keys(metadata).length > 0) out.metadata = metadata;
    return out;
  };
  const findOpenAiJsonText = (output) => {
    for (const item of output || []) {
      if (item?.type === 'text' && item.textType === 'openai-json') return item.text;
    }
    return undefined;
  };
  return {
    settings,
    async completeChat (messages, tools, options = {}) {
      const requestJson = {
        model: chatModel.id,
        messages,
        ...(tools ? { tools } : {}),
        ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
        ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
        ...serializeSettings(),
      };
      let session;
      let result;
      let failure = null;
      try {
        const request = new Request();
        request.addItem(Item.text(JSON.stringify(requestJson), 'openai-json'));
        session = new ChatSession(chatModel);
        const response = await session.processRequest(request);
        const text = findOpenAiJsonText(response?.output);
        if (text === undefined) {
          throw new Error(`Chat completion for model '${chatModel.id}' returned no openai-json text item.`);
        }
        result = parseOpenAiJson(text, `Chat completion for model '${chatModel.id}'`);
      } catch (err) {
        failure = new Error(
          `Chat completion failed for model '${chatModel.id}': ${err?.message || err}`,
          { cause: err },
        );
      }
      failure = disposeSession(session, failure);
      if (failure) throw failure;
      return result;
    },
    completeStreamingChat (messages, tools, options = {}) {
      const requestJson = {
        model: chatModel.id,
        messages,
        ...(tools ? { tools } : {}),
        ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
        ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
        stream: true,
        ...serializeSettings(),
      };
      return {
        async * [Symbol.asyncIterator] () {
          let session;
          let failure = null;
          let receivedOutput = false;
          try {
            const request = new Request();
            request.addItem(Item.text(JSON.stringify(requestJson), 'openai-json'));
            session = new ChatSession(chatModel);
            for await (const item of session.processStreamingRequest(request)) {
              if (item?.type !== 'text' || item.textType !== 'openai-json' || !item.text) continue;
              receivedOutput = true;
              yield parseOpenAiJson(item.text, `Streaming chat completion for model '${chatModel.id}'`);
            }
            if (!receivedOutput) {
              throw new Error(`Chat completion for model '${chatModel.id}' returned no openai-json text item.`);
            }
          } catch (err) {
            failure = err?.name === 'AbortError'
              ? err
              : new Error(
                  `Streaming chat completion failed for model '${chatModel.id}': ${err?.message || err}`,
                  { cause: err },
                );
          } finally {
            // Disposal (and the resulting throw) must live in `finally`, not after the
            // try/catch: if the consumer stops iterating early (`break`, or an explicit
            // `.return()`), the runtime resumes this generator with a synthetic return
            // completion at the suspended `yield`. That skips everything after the
            // try/catch but still runs `finally`, so cleanup - and surfacing a cleanup
            // failure - only happens reliably from inside it, not just on normal
            // completion or a thrown error.
            failure = disposeSession(session, failure, {
              onDiagnostic,
              abortDiagnosticCode: 'chat-session-dispose-after-abort',
              abortDiagnosticMessage: 'ChatSession disposal failed after streaming cancellation.',
            });
            if (failure) throw failure;
          }
        }
      };
    },
  };
}

// Builds an EmbeddingsSession-backed replacement for `embedModel.createEmbeddingClient()`
// (the deprecated OpenAI-shaped wrapper, removed end of 2026). Mirrors the SDK's own
// EmbeddingClient wire format: serializes {model, input} into a single
// `Item.text(json, "openai-json")`, runs it through a fresh EmbeddingsSession, and
// recovers the response from the first "openai-json" text item in the output — keeping
// the wire shape identical to the deprecated client. Returns null if this SDK build does
// not export EmbeddingsSession/Request/Item (falls back to createEmbeddingClient()).
export function createSessionEmbeddingClient (embedModel, sdkModule) {
  const { EmbeddingsSession, Request, Item } = sdkModule || {};
  if (typeof EmbeddingsSession !== 'function' || typeof Request !== 'function' || typeof Item?.text !== 'function') {
    return null;
  }
  const findOpenAiJsonText = (output) => {
    for (const item of output || []) {
      if (item?.type === 'text' && item.textType === 'openai-json') return item.text;
    }
    return undefined;
  };
  return {
    async generateEmbeddings (inputs) {
      const requestJson = { model: embedModel.id, input: inputs };
      let session;
      let result;
      let failure = null;
      try {
        const request = new Request();
        request.addItem(Item.text(JSON.stringify(requestJson), 'openai-json'));
        session = new EmbeddingsSession(embedModel);
        const response = await session.processRequest(request);
        const text = findOpenAiJsonText(response?.output);
        if (text === undefined) {
          throw new Error(`Embedding generation for model '${embedModel.id}' returned no openai-json text item.`);
        }
        result = parseOpenAiJson(text, `Embedding generation for model '${embedModel.id}'`);
      } catch (err) {
        failure = new Error(
          `Embedding generation failed for model '${embedModel.id}': ${err?.message || err}`,
          { cause: err },
        );
      }
      failure = disposeSession(session, failure);
      if (failure) throw failure;
      return result;
    },
  };
}
