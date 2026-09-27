import {
  getSpeechModelStrategy,
  getSpeechModelStrategyForVariants,
  SPEECH_SDK_VERSION,
} from './speech-models.js';
import { extractNemotronPcm } from './wav-pcm.js';

export class SpeechEngineError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor (code, message) {
    super(message);
    this.name = 'SpeechEngineError';
    this.code = code;
  }
}

function normalizeText (value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripLanguageTags (value) {
  return normalizeText(String(value || '').replace(/<[a-z]{2}-[a-z]{2}>/gi, ' '));
}

function requestOptions (language, temperature) {
  const options = {};
  if (typeof temperature === 'number') options.search = { temperature };
  if (language && language !== 'auto') options.additionalOptions = { language };
  return options;
}

function speechResultFrom (response, family) {
  const result = response?.output?.find((item) => item?.type === 'speechResult');
  const text = family === 'nemotron' ? stripLanguageTags(result?.text) : normalizeText(result?.text);
  if (!text) throw new Error('Transcription produced an empty speechResult.');
  const segments = Array.isArray(result?.segments)
    ? result.segments
      .map((segment) => normalizeText(family === 'nemotron' ? stripLanguageTags(segment?.text) : segment?.text))
      .filter(Boolean)
      .map((segmentText) => ({ text: segmentText }))
    : [];
  return { text, segments };
}

function unsupportedRuntimeError (modelName) {
  return new SpeechEngineError(
    'unsupported-by-runtime',
    `Model "${modelName}" does not support audio processing in Foundry Local SDK ${SPEECH_SDK_VERSION}.`,
  );
}

export function assertSpeechModelSupported (modelAlias, variantId = '', candidateVariantIds = []) {
  const selected = variantId
    ? getSpeechModelStrategy(modelAlias, variantId)
    : getSpeechModelStrategyForVariants(modelAlias, candidateVariantIds);
  if (!selected.supported) {
    throw new SpeechEngineError('unsupported-by-runtime', selected.reason);
  }
  return selected;
}

async function transcribeWithUri ({ sdkModule, model, filePath, language, temperature, modelName }) {
  const { AudioSession, Request, Item } = sdkModule;
  let session;
  try {
    session = new AudioSession(model);
    const request = new Request().addItem(Item.audioFromUri(filePath));
    request.setOptions(requestOptions(language, temperature));
    const response = await session.processRequest(request);
    return {
      ...speechResultFrom(response, 'whisper'),
      transcriptionPath: 'audioSession',
    };
  } catch (error) {
    if (/does not support audio processing/i.test(String(error?.message || error))) {
      throw unsupportedRuntimeError(modelName);
    }
    throw error;
  } finally {
    session?.dispose();
  }
}

async function transcribeWithItemQueue ({
  sdkModule,
  model,
  audioBytes,
  language,
  temperature,
  modelName,
}) {
  const { AudioSession, Item, ItemQueue, Request } = sdkModule;
  if (typeof ItemQueue !== 'function' || typeof Item?.audioDescriptor !== 'function') {
    throw new SpeechEngineError(
      'unsupported-by-runtime',
      `Nemotron transcription requires ItemQueue support in Foundry Local SDK ${SPEECH_SDK_VERSION}.`,
    );
  }
  const pcm = extractNemotronPcm(audioBytes);
  const queue = new ItemQueue();
  let session;
  try {
    session = new AudioSession(model);
    const request = new Request()
      .addItem(Item.audioDescriptor('pcm', 16000, 1))
      .addItem(queue);
    request.setOptions(requestOptions(language, temperature));
    const stream = session.processStreamingRequest(request);
    const response = stream.response;
    // Mark early native failures handled while input is queued; the await below still propagates them.
    response.catch(() => {});
    const consume = (async () => {
      for await (const _item of stream) {
        // Drain stream items; the terminal response contains the canonical transcript.
      }
    })();
    consume.catch(() => {});
    const chunkBytes = 16000 * 2 / 10;
    for (let offset = 0; offset < pcm.byteLength; offset += chunkBytes) {
      const end = Math.min(offset + chunkBytes, pcm.byteLength);
      queue.push(Item.bytes(new Uint8Array(pcm.buffer, pcm.byteOffset + offset, end - offset)));
    }
    queue.markFinished();
    const [, terminalResponse] = await Promise.all([consume, response]);
    return {
      ...speechResultFrom(terminalResponse, 'nemotron'),
      transcriptionPath: 'itemQueue',
    };
  } catch (error) {
    if (/does not support audio processing/i.test(String(error?.message || error))) {
      throw unsupportedRuntimeError(modelName);
    }
    throw error;
  } finally {
    if (!queue.finished) queue.markFinished();
    queue.dispose();
    session?.dispose();
  }
}

/**
 * Execute exactly one SDK transcription strategy selected from the model's canonical names.
 *
 * @param {{
 *   sdkModule: object,
 *   model: object,
 *   modelAlias: string,
 *   variantId?: string,
 *   filePath: string,
 *   audioBytes: Uint8Array,
 *   language?: string,
 *   temperature?: number,
 * }} options
 */
export async function transcribeSpeech (options) {
  const modelName = options.variantId || options.modelAlias;
  const selected = assertSpeechModelSupported(options.modelAlias, options.variantId);
  if (!options.sdkModule || typeof options.sdkModule.AudioSession !== 'function') {
    throw new SpeechEngineError(
      'unsupported-by-runtime',
      `AudioSession is unavailable in Foundry Local SDK ${SPEECH_SDK_VERSION}.`,
    );
  }
  const params = { ...options, modelName };
  if (selected.strategy === 'itemQueue') return transcribeWithItemQueue(params);
  if (!options.filePath) throw new Error(`A WAV file path is required for ${modelName}.`);
  return transcribeWithUri(params);
}
