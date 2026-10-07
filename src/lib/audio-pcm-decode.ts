// Manual WAV/PCM decoding for the browser, independent of `AudioContext.decodeAudioData`.
//
// Some WebView2/Chromium builds reject audio bytes that other players (and even a
// differently-versioned Edge/Chrome on the same machine) decode without complaint, throwing
// the opaque `EncodingError: Unable to decode audio data`. A canonical WAV file is just a
// RIFF container around raw PCM samples — nothing about it requires a real codec, so parsing
// it ourselves sidesteps whatever the platform decoder's strictness (or a codec-pack gap)
// rejected, and never regresses a file `decodeAudioData` already handles fine, because callers
// only reach this parser as a fallback (or exclusively for files already sniffed as WAV).

import { parseWavHeader } from '../../sidecar/wav-pcm.js';

/** A parsed PCM waveform: one Float32Array of samples in [-1, 1] per channel. */
export interface DecodedPcm {
  sampleRate: number;
  channelData: Float32Array[];
}

type HostScheduler = { yield?: () => Promise<void> };

/**
 * Gives the UI thread a turn during a long sample walk.
 *
 * `scheduler.yield` paints without the 4ms timer clamp. A host without it gets a macrotask.
 */
export function yieldToMainThread(): Promise<void> {
  const host = globalThis as typeof globalThis & { scheduler?: HostScheduler };
  const yieldNow = host.scheduler?.yield;
  if (typeof yieldNow === 'function') return yieldNow.call(host.scheduler);
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** One hour of 16 kHz audio is tens of millions of frames. Yield a few times a second of audio. */
const PCM_FRAMES_PER_YIELD = 32_768;

function readPcmSample(
  view: DataView,
  sampleOffset: number,
  bitsPerSample: number,
  formatCode: number,
  isFloat: boolean,
  isInt: boolean,
): number {
  if (isFloat && bitsPerSample === 32) {
    return view.getFloat32(sampleOffset, true);
  }
  if (isInt && bitsPerSample === 8) {
    // 8-bit PCM is the one unsigned case (silence sits at 128, not 0).
    return (view.getUint8(sampleOffset) - 128) / 128;
  }
  if (isInt && bitsPerSample === 16) {
    return view.getInt16(sampleOffset, true) / 32768;
  }
  if (isInt && bitsPerSample === 24) {
    const b0 = view.getUint8(sampleOffset);
    const b1 = view.getUint8(sampleOffset + 1);
    const b2 = view.getUint8(sampleOffset + 2);
    let raw = b0 | (b1 << 8) | (b2 << 16);
    if (raw & 0x800000) raw -= 0x1000000;
    return raw / 8388608;
  }
  if (isInt && bitsPerSample === 32) {
    return view.getInt32(sampleOffset, true) / 2147483648;
  }
  throw new Error(`Unsupported WAV bit depth ${bitsPerSample} for format code ${formatCode}.`);
}

function fillPcmChannels(
  view: DataView,
  channelData: Float32Array[],
  startFrame: number,
  endFrame: number,
  dataOffset: number,
  frameSize: number,
  bytesPerSample: number,
  bitsPerSample: number,
  formatCode: number,
  isFloat: boolean,
  isInt: boolean,
): void {
  const numChannels = channelData.length;
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const frameOffset = dataOffset + frame * frameSize;
    for (let channel = 0; channel < numChannels; channel += 1) {
      const sampleOffset = frameOffset + channel * bytesPerSample;
      channelData[channel][frame] = readPcmSample(
        view,
        sampleOffset,
        bitsPerSample,
        formatCode,
        isFloat,
        isInt,
      );
    }
  }
}

function allocatePcm(buffer: ArrayBuffer): DecodedPcm & {
  view: DataView;
  formatCode: number;
  bitsPerSample: number;
  bytesPerSample: number;
  frameSize: number;
  frameCount: number;
  dataOffset: number;
  isFloat: boolean;
  isInt: boolean;
} {
  const header = parseWavHeader(buffer);
  const channelData: Float32Array[] = Array.from(
    { length: header.numChannels },
    () => new Float32Array(header.frameCount),
  );
  return { ...header, sampleRate: header.sampleRate, channelData };
}

/**
 * Parse a canonical RIFF/WAVE buffer into per-channel Float32 PCM.
 *
 * Supports the common `fmt ` layouts written by real encoders (ffmpeg included):
 * 8/16/24/32-bit signed integer PCM, 32-bit IEEE float, and WAVE_FORMAT_EXTENSIBLE wrapping
 * either of those. Unknown chunks (e.g. ffmpeg's `LIST`/`fact`) are skipped rather than
 * rejected, since they carry no sample data.
 *
 * @throws {Error} if the buffer is not RIFF/WAVE, the format is unsupported, the `data` chunk
 *   is truncated, or no `data` chunk is present.
 */
export function decodeWavPcm(buffer: ArrayBuffer): DecodedPcm {
  const decoded = allocatePcm(buffer);
  fillPcmChannels(
    decoded.view,
    decoded.channelData,
    0,
    decoded.frameCount,
    decoded.dataOffset,
    decoded.frameSize,
    decoded.bytesPerSample,
    decoded.bitsPerSample,
    decoded.formatCode,
    decoded.isFloat,
    decoded.isInt,
  );
  return { sampleRate: decoded.sampleRate, channelData: decoded.channelData };
}

/**
 * Same samples as `decodeWavPcm`, but returns to the event loop between frame chunks.
 *
 * The synchronous decoder stays for callers that already hold the result in one turn (tests,
 * short files). A long recording walked sample-by-sample on the UI thread never paints.
 */
export async function decodeWavPcmYielding(
  buffer: ArrayBuffer,
  options?: { framesPerYield?: number; yield?: () => Promise<void> },
): Promise<DecodedPcm> {
  const decoded = allocatePcm(buffer);
  const framesPerYield = Math.max(1, options?.framesPerYield ?? PCM_FRAMES_PER_YIELD);
  const yieldNow = options?.yield ?? yieldToMainThread;
  for (let start = 0; start < decoded.frameCount; start += framesPerYield) {
    const end = Math.min(decoded.frameCount, start + framesPerYield);
    fillPcmChannels(
      decoded.view,
      decoded.channelData,
      start,
      end,
      decoded.dataOffset,
      decoded.frameSize,
      decoded.bytesPerSample,
      decoded.bitsPerSample,
      decoded.formatCode,
      decoded.isFloat,
      decoded.isInt,
    );
    if (end < decoded.frameCount) await yieldNow();
  }
  return { sampleRate: decoded.sampleRate, channelData: decoded.channelData };
}

/**
 * Compute a WAV file's duration in seconds from its header alone, without decoding or
 * allocating any sample data. Prefer this over `decodeWavPcm(...).channelData[0].length /
 * sampleRate` when only the duration is needed — a large file's full per-channel Float32
 * decode is otherwise unnecessary memory/CPU work just to divide two header fields.
 *
 * @throws {Error} if the buffer is not RIFF/WAVE, the format is unsupported, the `data` chunk
 *   is truncated, or no `data` chunk is present.
 */
export function getWavDurationSeconds(buffer: ArrayBuffer): number {
  const { frameCount, sampleRate } = parseWavHeader(buffer);
  return frameCount / sampleRate;
}
