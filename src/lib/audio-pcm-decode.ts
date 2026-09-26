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
  const { view, formatCode, numChannels, sampleRate, bitsPerSample, bytesPerSample, frameSize, frameCount, dataOffset, isFloat, isInt } =
    parseWavHeader(buffer);
  const channelData: Float32Array[] = Array.from({ length: numChannels }, () => new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = dataOffset + frame * frameSize;
    for (let channel = 0; channel < numChannels; channel += 1) {
      const sampleOffset = frameOffset + channel * bytesPerSample;
      let value: number;
      if (isFloat && bitsPerSample === 32) {
        value = view.getFloat32(sampleOffset, true);
      } else if (isInt && bitsPerSample === 8) {
        // 8-bit PCM is the one unsigned case (silence sits at 128, not 0).
        value = (view.getUint8(sampleOffset) - 128) / 128;
      } else if (isInt && bitsPerSample === 16) {
        value = view.getInt16(sampleOffset, true) / 32768;
      } else if (isInt && bitsPerSample === 24) {
        const b0 = view.getUint8(sampleOffset);
        const b1 = view.getUint8(sampleOffset + 1);
        const b2 = view.getUint8(sampleOffset + 2);
        let raw = b0 | (b1 << 8) | (b2 << 16);
        if (raw & 0x800000) raw -= 0x1000000;
        value = raw / 8388608;
      } else if (isInt && bitsPerSample === 32) {
        value = view.getInt32(sampleOffset, true) / 2147483648;
      } else {
        throw new Error(`Unsupported WAV bit depth ${bitsPerSample} for format code ${formatCode}.`);
      }
      channelData[channel][frame] = value;
    }
  }

  return { sampleRate, channelData };
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
