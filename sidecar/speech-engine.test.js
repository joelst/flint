import { describe, expect, it, vi } from 'vitest';
import { assertSpeechModelSupported, transcribeSpeech } from './speech-engine.js';

function buildWav ({ sampleRate = 16000, channels = 1, bitsPerSample = 16, extraChunk = false } = {}) {
  const data = new Uint8Array(6400);
  const fmtSize = 16;
  const extraSize = extraChunk ? 12 : 0;
  const dataOffset = 12 + 8 + fmtSize + extraSize + 8;
  const bytes = new Uint8Array(dataOffset + data.length);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
  view.setUint16(32, channels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);
  if (extraChunk) {
    ascii(36, 'JUNK');
    view.setUint32(40, 4, true);
    bytes.set([1, 2, 3, 4], 44);
  }
  ascii(dataOffset - 8, 'data');
  view.setUint32(dataOffset - 4, data.length, true);
  bytes.set(data, dataOffset);
  return bytes;
}

function fakeSdk ({
  response,
  streamingError,
  stalledIterator = false,
  streamingResponse,
  sessionDisposeError,
  queueDisposeError,
  markFinishedError,
  queuePushError,
  finishedGetterError,
} = {}) {
  const state = { request: null, queued: [], queueFinished: false, queueDisposed: false, sessionDisposed: false };
  class Request {
    items = [];
    addItem (item) { this.items.push(item); return this; }
    setOptions (options) { this.options = options; return this; }
  }
  class ItemQueue {
    push (item) {
      if (queuePushError) throw queuePushError;
      state.queued.push(item.data);
    }
    markFinished () {
      state.queueFinished = true;
      if (markFinishedError) throw markFinishedError;
    }
    get finished () {
      if (finishedGetterError) throw finishedGetterError;
      return state.queueFinished;
    }
    dispose () {
      state.queueDisposed = true;
      if (queueDisposeError) throw queueDisposeError;
    }
  }
  class AudioSession {
    constructor () {}
    async processRequest (request) {
      state.request = request;
      if (streamingError) throw streamingError;
      return response;
    }
    processStreamingRequest (request) {
      state.request = request;
      const result = response ?? { output: [{ type: 'speechResult', text: '<en-US>hello there', segments: [{ text: '<en-US>hello there' }] }] };
      return {
        [Symbol.asyncIterator]: stalledIterator
          ? () => ({ next: () => new Promise(() => {}) })
          : async function * () {},
        response: streamingResponse ?? Promise.resolve(result),
      };
    }
    dispose () {
      state.sessionDisposed = true;
      if (sessionDisposeError) throw sessionDisposeError;
    }
  }
  return {
    state,
    module: {
      AudioSession,
      Request,
      ItemQueue,
      Item: {
        audioFromUri: (uri) => ({ type: 'audio', uri }),
        audioDescriptor: (format, sampleRate, channels) => ({ type: 'audio-descriptor', format, sampleRate, channels }),
        bytes: (data) => ({ type: 'bytes', data }),
      },
    },
  };
}

describe('transcribeSpeech', () => {
  it('uses exactly one URI inference and takes the canonical Whisper text', async () => {
    const { module, state } = fakeSdk({
      response: {
        output: [{
          type: 'speechResult',
          text: 'dog.',
          segments: [{ text: 'dog' }, { text: '.' }],
        }],
      },
    });
    const processRequest = vi.spyOn(module.AudioSession.prototype, 'processRequest');
    const result = await transcribeSpeech({
      sdkModule: module,
      model: {},
      modelAlias: 'whisper-tiny',
      variantId: 'whisper-tiny-generic-cpu:1',
      filePath: 'audio.wav',
      audioBytes: buildWav(),
    });
    expect(result).toMatchObject({ text: 'dog.', transcriptionPath: 'audioSession' });
    expect(processRequest).toHaveBeenCalledOnce();
    expect(state.request.items).toEqual([{ type: 'audio', uri: 'audio.wav' }]);
    expect(state.sessionDisposed).toBe(true);
  });

  it('streams raw 16 kHz mono PCM through ItemQueue and strips Nemotron language tags', async () => {
    const { module, state } = fakeSdk();
    const audio = buildWav({ extraChunk: true });
    const result = await transcribeSpeech({
      sdkModule: module,
      model: {},
      modelAlias: 'nemotron-speech-streaming-es-0.6b',
      variantId: 'nemotron-speech-es-0.6b-ft-generic-cpu:1',
      filePath: '',
      audioBytes: audio,
      language: 'es',
      temperature: 0.2,
    });
    expect(result).toEqual({
      text: 'hello there',
      segments: [{ text: 'hello there' }],
      transcriptionPath: 'itemQueue',
    });
    expect(state.request.items[0]).toEqual({
      type: 'audio-descriptor', format: 'pcm', sampleRate: 16000, channels: 1,
    });
    expect(state.request.options).toEqual({
      search: { temperature: 0.2 },
      additionalOptions: { language: 'es' },
    });
    expect(state.queued.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(6400);
    expect(state.queueFinished).toBe(true);
    expect(state.queueDisposed).toBe(true);
    expect(state.sessionDisposed).toBe(true);
  });

  it('rejects unsupported audio before creating an inference session', async () => {
    const { module } = fakeSdk();
    const createSession = vi.spyOn(module, 'AudioSession');
    expect(() => assertSpeechModelSupported('parakeet-tdt-0.6b-v2'))
      .toThrow(/Parakeet transcription is not supported/);
    await expect(transcribeSpeech({
      sdkModule: module,
      model: {},
      modelAlias: 'parakeet-tdt-0.6b-v2',
      filePath: 'audio.wav',
      audioBytes: buildWav(),
    })).rejects.toMatchObject({ code: 'unsupported-by-runtime' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    ['sample rate', buildWav({ sampleRate: 22000 })],
    ['channel count', buildWav({ channels: 2 })],
    ['sample format', buildWav({ bitsPerSample: 32 })],
  ])('rejects Nemotron %s mismatches', async (_label, audioBytes) => {
    const { module } = fakeSdk();
    await expect(transcribeSpeech({
      sdkModule: module,
      model: {},
      modelAlias: 'nemotron-speech-en-0.6b',
      filePath: '',
      audioBytes,
    })).rejects.toThrow(/16 kHz, mono, 16-bit PCM WAV/);
  });

  it('maps unsupported URI processing to a typed SDK error without trying another path', async () => {
    const { module, state } = fakeSdk({ streamingError: new Error('Model does not support audio processing') });
    const createAudioClient = vi.fn();
    await expect(transcribeSpeech({
      sdkModule: module,
      model: { createAudioClient },
      modelAlias: 'local-asr',
      filePath: 'audio.wav',
      audioBytes: buildWav(),
    })).rejects.toMatchObject({
      name: 'SpeechEngineError',
      code: 'unsupported-by-runtime',
      message: expect.stringContaining('Foundry Local SDK 2.0.1'),
    });
    expect(createAudioClient).not.toHaveBeenCalled();
    expect(state.sessionDisposed).toBe(true);
  });

  it('surfaces an early Nemotron response failure even when the stream iterator never finishes', async () => {
    const nativeFailure = new Error('native streaming request failed');
    const { module, state } = fakeSdk({
      stalledIterator: true,
      streamingResponse: Promise.reject(nativeFailure),
    });
    await expect(transcribeSpeech({
      sdkModule: module,
      model: {},
      modelAlias: 'nemotron-speech-en-0.6b',
      filePath: '',
      audioBytes: buildWav(),
    })).rejects.toBe(nativeFailure);
    expect(state.queueFinished).toBe(true);
    expect(state.queueDisposed).toBe(true);
    expect(state.sessionDisposed).toBe(true);
  });

  it('preserves a URI inference failure when session disposal also fails', async () => {
    const inferenceFailure = new Error('native URI inference failed');
    const disposalFailure = new Error('native AudioSession disposal failed');
    const { module } = fakeSdk({
      streamingError: inferenceFailure,
      sessionDisposeError: disposalFailure,
    });
    await expect(transcribeSpeech({
      sdkModule: module,
      model: {},
      modelAlias: 'whisper-tiny',
      filePath: 'audio.wav',
      audioBytes: buildWav(),
    })).rejects.toMatchObject({
      cause: inferenceFailure,
      message: expect.stringContaining('native URI inference failed'),
      errors: [inferenceFailure, disposalFailure],
    });
  });

  it('preserves a Nemotron queue failure and every cleanup failure', async () => {
    const inferenceFailure = new Error('native queue push failed');
    const markFailure = new Error('markFinished cleanup failed');
    const queueFailure = new Error('queue disposal failed');
    const sessionFailure = new Error('session disposal failed');
    const { module } = fakeSdk({
      queuePushError: inferenceFailure,
      markFinishedError: markFailure,
      queueDisposeError: queueFailure,
      sessionDisposeError: sessionFailure,
    });
    await expect(transcribeSpeech({
      sdkModule: module,
      model: {},
      modelAlias: 'nemotron-speech-en-0.6b',
      filePath: '',
      audioBytes: buildWav(),
    })).rejects.toSatisfy((error) => {
      expect(error.cause).toBe(inferenceFailure);
      expect(error.message).toContain('native queue push failed');
      const serialized = String(error);
      expect(serialized).toContain('markFinished cleanup failed');
      expect(serialized).toContain('queue disposal failed');
      expect(serialized).toContain('session disposal failed');
      return true;
    });
  });

  it('preserves the primary failure and continues cleanup when reading queue.finished fails', async () => {
    const primaryFailure = new Error('native queue push failed');
    const getterFailure = new Error('native finished getter failed');
    const queueFailure = new Error('queue disposal failed');
    const sessionFailure = new Error('session disposal failed');
    const { module, state } = fakeSdk({
      queuePushError: primaryFailure,
      finishedGetterError: getterFailure,
      queueDisposeError: queueFailure,
      sessionDisposeError: sessionFailure,
    });
    await expect(transcribeSpeech({
      sdkModule: module,
      model: {},
      modelAlias: 'nemotron-speech-en-0.6b',
      filePath: '',
      audioBytes: buildWav(),
    })).rejects.toSatisfy((error) => {
      expect(error.cause).toBe(primaryFailure);
      expect(error.errors).toEqual([primaryFailure, getterFailure, queueFailure, sessionFailure]);
      return true;
    });
    expect(state.queueDisposed).toBe(true);
    expect(state.sessionDisposed).toBe(true);
  });

});
