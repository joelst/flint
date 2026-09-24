// Manual WAV/PCM decoding for the browser, independent of `AudioContext.decodeAudioData`.
//
// Some WebView2/Chromium builds reject audio bytes that other players (and even a
// differently-versioned Edge/Chrome on the same machine) decode without complaint, throwing
// the opaque `EncodingError: Unable to decode audio data`. A canonical WAV file is just a
// RIFF container around raw PCM samples — nothing about it requires a real codec, so parsing
// it ourselves sidesteps whatever the platform decoder's strictness (or a codec-pack gap)
// rejected, and never regresses a file `decodeAudioData` already handles fine, because callers
// only reach this parser as a fallback (or exclusively for files already sniffed as WAV).

/** A parsed PCM waveform: one Float32Array of samples in [-1, 1] per channel. */
export interface DecodedPcm {
  sampleRate: number;
  channelData: Float32Array[];
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

interface WavHeader {
  view: DataView;
  formatCode: number;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  bytesPerSample: number;
  frameSize: number;
  frameCount: number;
  dataOffset: number;
  isFloat: boolean;
  isInt: boolean;
}

/**
 * Walk a RIFF/WAVE buffer's chunks and validate its `fmt `/`data` chunks, without reading or
 * allocating any sample data. Shared by {@link decodeWavPcm} (which also materializes samples)
 * and {@link getWavDurationSeconds} (which only needs the frame count and sample rate).
 *
 * @throws {Error} if the buffer is not RIFF/WAVE, the format is unsupported, the `data` chunk
 *   is truncated (declares more bytes than the buffer actually has), or no `data` chunk is
 *   present.
 */
function parseWavHeader(buffer: ArrayBuffer): WavHeader {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE buffer.');
  }

  let formatCode = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let dataDeclaredSize = 0;
  let dataAvailable = 0;

  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const declaredSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    // A truncated/misreported trailing chunk still lets us read what actually fits. This is
    // acceptable for chunks we merely skip (e.g. a mis-sized `LIST`), but the `data` chunk is
    // checked separately below: silently clamping it would decode a truncated upload as if it
    // were a complete, shorter file, with no indication anything was cut off.
    const chunkSize = Math.min(declaredSize, Math.max(0, buffer.byteLength - bodyOffset));

    if (chunkId === 'fmt ') {
      formatCode = view.getUint16(bodyOffset, true);
      numChannels = view.getUint16(bodyOffset + 2, true);
      sampleRate = view.getUint32(bodyOffset + 4, true);
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
      // WAVE_FORMAT_EXTENSIBLE (0xFFFE): the real sample type lives in the sub-format GUID's
      // first two bytes, which reuse the same codes as `formatCode` (1 = PCM, 3 = float). The
      // GUID starts at body offset 24 (18-byte WAVEFORMATEX + 2-byte validBits + 4-byte
      // channelMask), so reading its first uint16 needs the chunk to extend through offset 25,
      // not merely up to 24 — a chunk that stops exactly at 24 has no sub-format bytes at all.
      if (formatCode === 0xfffe && chunkSize >= 26) {
        formatCode = view.getUint16(bodyOffset + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = bodyOffset;
      dataLength = chunkSize;
      dataDeclaredSize = declaredSize;
      dataAvailable = Math.max(0, buffer.byteLength - bodyOffset);
    }

    // Chunks are word-aligned; an odd declared size has one pad byte after it.
    offset = bodyOffset + declaredSize + (declaredSize % 2);
  }

  if (dataOffset >= 0 && dataDeclaredSize > dataAvailable) {
    throw new Error(
      `WAV data chunk is truncated: declared ${dataDeclaredSize} bytes but only ${dataAvailable} are present.`,
    );
  }

  if (!numChannels || !sampleRate || !bitsPerSample) {
    throw new Error('WAV file is missing a usable fmt chunk.');
  }
  if (dataOffset < 0 || dataLength <= 0) {
    throw new Error('WAV file has no data chunk.');
  }

  const isFloat = formatCode === 3;
  const isInt = formatCode === 1;
  if (!isFloat && !isInt) {
    throw new Error(`Unsupported WAV sample format code ${formatCode}.`);
  }
  // Validate the bit depth — and reject anything not byte-aligned (e.g. 1-bit/4-bit ADPCM-style
  // depths) — before computing frameSize/frameCount, so a crafted header can't make bytesPerSample
  // shrink toward zero and inflate frameCount into a runaway allocation.
  const supportedIntDepths = [8, 16, 24, 32];
  const supportedFloatDepths = [32];
  const supportedDepths = isFloat ? supportedFloatDepths : supportedIntDepths;
  if (bitsPerSample % 8 !== 0 || !supportedDepths.includes(bitsPerSample)) {
    throw new Error(`Unsupported WAV bit depth ${bitsPerSample} for format code ${formatCode}.`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameSize = bytesPerSample * numChannels;
  const frameCount = Math.floor(dataLength / frameSize);

  return {
    view,
    formatCode,
    numChannels,
    sampleRate,
    bitsPerSample,
    bytesPerSample,
    frameSize,
    frameCount,
    dataOffset,
    isFloat,
    isInt,
  };
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
