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

// Zero is the OpenAI-defined neutral value for both penalties, so omitting it preserves
// semantics. Foundry Local 2.0.1 misapplies an explicitly serialized frequency_penalty of 0
// for some models (notably Gemma 4 E2B), causing otherwise normal replies to degenerate.
export function normalizeChatPenalty (value) {
  return Number.isFinite(value) && value !== 0 ? value : undefined;
}

function hasMultipartMessages (messages) {
  return Array.isArray(messages) && messages.some((message) =>
    Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'image_url'),
  );
}

function nativeFinishReason (finishReason) {
  if (finishReason === 'toolCalls') return 'tool_calls';
  if (finishReason === 'none') return null;
  return finishReason ?? null;
}

function nativeUsage (usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

function nativeText (output) {
  let text = '';
  for (const item of output || []) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      text += item.text;
      continue;
    }
    if (item?.type !== 'message') continue;
    if (typeof item.content === 'string') {
      text += item.content;
      continue;
    }
    for (const part of item.parts || []) {
      if (part?.type === 'text' && typeof part.text === 'string') text += part.text;
    }
  }
  return text;
}

const NATIVE_IMAGE_FORMATS = new Set(['bmp', 'gif', 'jpeg', 'jpg', 'png', 'webp']);
const MAX_NATIVE_IMAGE_DATA_URL_CHARS = 350_000;

function decodeImageDataUrl (url) {
  if (typeof url !== 'string' || url.length > MAX_NATIVE_IMAGE_DATA_URL_CHARS) {
    throw new Error('Native image input exceeds the supported size limit.');
  }
  const match = /^data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i.exec(url);
  const rawFormat = match?.[1]?.toLowerCase();
  if (!match || !NATIVE_IMAGE_FORMATS.has(rawFormat)) {
    throw new Error('Native image input must be a supported base64 data URL.');
  }
  let decoded;
  try {
    decoded = atob(match[2]);
  } catch {
    throw new Error('Native image input contains invalid base64 data.');
  }
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return { format: rawFormat === 'jpg' ? 'jpeg' : rawFormat, bytes };
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
  const supportsMultipart = typeof Item.message === 'function'
    && typeof Item.imageFromData === 'function';
  const settings = {};
  const serializeSettings = () => {
    const out = {};
    const frequencyPenalty = normalizeChatPenalty(settings.frequencyPenalty);
    const presencePenalty = normalizeChatPenalty(settings.presencePenalty);
    if (frequencyPenalty !== undefined) out.frequency_penalty = frequencyPenalty;
    if (Number.isFinite(settings.maxTokens)) out.max_tokens = settings.maxTokens;
    if (presencePenalty !== undefined) out.presence_penalty = presencePenalty;
    if (Number.isFinite(settings.temperature)) out.temperature = settings.temperature;
    if (Number.isFinite(settings.topP)) out.top_p = settings.topP;
    const metadata = {};
    if (Number.isFinite(settings.topK)) metadata.top_k = String(settings.topK);
    if (Number.isFinite(settings.randomSeed)) metadata.random_seed = String(settings.randomSeed);
    if (Object.keys(metadata).length > 0) out.metadata = metadata;
    return out;
  };
  const serializeNativeSettings = () => {
    const search = {};
    const frequencyPenalty = normalizeChatPenalty(settings.frequencyPenalty);
    const presencePenalty = normalizeChatPenalty(settings.presencePenalty);
    if (frequencyPenalty !== undefined) search.frequencyPenalty = frequencyPenalty;
    if (Number.isFinite(settings.maxTokens)) search.maxOutputTokens = settings.maxTokens;
    if (presencePenalty !== undefined) search.presencePenalty = presencePenalty;
    if (Number.isFinite(settings.temperature)) search.temperature = settings.temperature;
    if (Number.isFinite(settings.topP)) search.topP = settings.topP;
    if (Number.isFinite(settings.topK)) search.topK = settings.topK;
    if (Number.isFinite(settings.randomSeed)) search.seed = settings.randomSeed;
    return search;
  };
  const assertNativeMultimodalOptions = (messages, tools, options) => {
    if (!supportsMultipart) {
      throw new Error('This Foundry Local SDK does not expose native multimodal items.');
    }
    if ((Array.isArray(tools) ? tools.length > 0 : tools != null)
      || options.toolChoice !== undefined
      || options.responseFormat !== undefined) {
      throw new Error('Native image input cannot be combined with tools or structured response options.');
    }
    if (messages.some((message) =>
      message?.role === 'tool'
      || message?.tool_calls !== undefined
      || message?.name !== undefined
    )) {
      throw new Error('Native image input cannot be combined with named or tool-loop messages.');
    }
  };
  const toNativeMessage = (message) => {
    if (!['system', 'user', 'assistant'].includes(message?.role)) {
      throw new Error(`Native image input does not support message role '${message?.role}'.`);
    }
    if (typeof message.content === 'string') {
      return Item.message(message.role, message.content);
    }
    if (!Array.isArray(message.content)) {
      throw new Error(`Native image input requires string or multipart content for role '${message.role}'.`);
    }
    const parts = message.content.map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        return Item.text(part.text);
      }
      if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
        const { format, bytes } = decodeImageDataUrl(part.image_url.url);
        return Item.imageFromData(format, bytes);
      }
      throw new Error('Native image input contains an unsupported content part.');
    });
    return Item.message(message.role, parts);
  };
  const buildNativeRequest = (messages, tools, options) => {
    assertNativeMultimodalOptions(messages, tools, options);
    const request = new Request();
    const search = serializeNativeSettings();
    if (Object.keys(search).length > 0) request.setOptions({ search });
    for (const message of messages) request.addItem(toNativeMessage(message));
    return request;
  };
  const nativeResult = (response) => {
    const content = nativeText(response?.output);
    if (!content) {
      throw new Error(`Chat completion for model '${chatModel.id}' returned no text output.`);
    }
    const usage = nativeUsage(response?.usage);
    return {
      choices: [{
        index: 0,
        finish_reason: nativeFinishReason(response?.finishReason),
        message: { role: 'assistant', content },
      }],
      ...(usage ? { usage } : {}),
    };
  };
  const findOpenAiJsonText = (output) => {
    for (const item of output || []) {
      if (item?.type === 'text' && item.textType === 'openai-json') return item.text;
    }
    return undefined;
  };
  return {
    settings,
    supportsMultipart,
    async completeChat (messages, tools, options = {}) {
      const multipart = hasMultipartMessages(messages);
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
        const request = multipart
          ? buildNativeRequest(messages, tools, options)
          : new Request().addItem(Item.text(JSON.stringify(requestJson), 'openai-json'));
        session = new ChatSession(chatModel);
        const response = await session.processRequest(request);
        if (multipart) {
          result = nativeResult(response);
        } else {
          const text = findOpenAiJsonText(response?.output);
          if (text === undefined) {
            throw new Error(`Chat completion for model '${chatModel.id}' returned no openai-json text item.`);
          }
          result = parseOpenAiJson(text, `Chat completion for model '${chatModel.id}'`);
        }
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
      const multipart = hasMultipartMessages(messages);
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
            const request = multipart
              ? buildNativeRequest(messages, tools, options)
              : new Request().addItem(Item.text(JSON.stringify(requestJson), 'openai-json'));
            session = new ChatSession(chatModel);
            const stream = session.processStreamingRequest(request);
            const responsePromise = multipart ? Promise.resolve(stream.response) : null;
            // A consumer may stop iteration at a yield. Attach a rejection handler immediately
            // so the SDK's terminal response cannot become an unhandled rejection while the
            // generator unwinds and disposes the session.
            responsePromise?.catch(() => {});
            for await (const item of stream) {
              if (item?.type !== 'text' || !item.text) continue;
              if (multipart) {
                receivedOutput = true;
                yield {
                  choices: [{
                    index: 0,
                    delta: { role: 'assistant', content: item.text },
                    finish_reason: null,
                  }],
                };
              } else if (item.textType === 'openai-json') {
                receivedOutput = true;
                yield parseOpenAiJson(item.text, `Streaming chat completion for model '${chatModel.id}'`);
              }
            }
            if (!receivedOutput) {
              throw new Error(
                multipart
                  ? `Chat completion for model '${chatModel.id}' returned no text output.`
                  : `Chat completion for model '${chatModel.id}' returned no openai-json text item.`,
              );
            }
            if (multipart) {
              const response = await responsePromise;
              const usage = nativeUsage(response?.usage);
              yield {
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: nativeFinishReason(response?.finishReason),
                }],
                ...(usage ? { usage } : {}),
              };
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
