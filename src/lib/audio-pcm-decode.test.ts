import { describe, expect, it } from 'vitest';
import { decodeWavPcm, getWavDurationSeconds } from './audio-pcm-decode.js';

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function buildWav({
  formatCode = 1,
  numChannels = 1,
  sampleRate = 22000,
  bitsPerSample = 16,
  data,
  extraChunk,
}: {
  formatCode?: number;
  numChannels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  data: ArrayBuffer;
  extraChunk?: { id: string; body: ArrayBuffer };
}): ArrayBuffer {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const extraLen = extraChunk ? 8 + extraChunk.body.byteLength + (extraChunk.body.byteLength % 2) : 0;
  const totalLen = 12 + 24 + extraLen + 8 + data.byteLength + (data.byteLength % 2);
  const buffer = new ArrayBuffer(totalLen);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, totalLen - 8, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, formatCode, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  let offset = 36;
  if (extraChunk) {
    writeAscii(view, offset, extraChunk.id);
    view.setUint32(offset + 4, extraChunk.body.byteLength, true);
    new Uint8Array(buffer, offset + 8, extraChunk.body.byteLength).set(new Uint8Array(extraChunk.body));
    offset += 8 + extraChunk.body.byteLength + (extraChunk.body.byteLength % 2);
  }

  writeAscii(view, offset, 'data');
  view.setUint32(offset + 4, data.byteLength, true);
  new Uint8Array(buffer, offset + 8, data.byteLength).set(new Uint8Array(data));

  return buffer;
}

describe('decodeWavPcm', () => {
  it('decodes 16-bit PCM mono', () => {
    const samples = new Int16Array([0, 16384, -16384, 32767, -32768]);
    const wav = buildWav({ bitsPerSample: 16, data: samples.buffer });
    const decoded = decodeWavPcm(wav);
    expect(decoded.sampleRate).toBe(22000);
    expect(decoded.channelData).toHaveLength(1);
    expect(decoded.channelData[0][0]).toBeCloseTo(0, 5);
    expect(decoded.channelData[0][1]).toBeCloseTo(0.5, 3);
    expect(decoded.channelData[0][3]).toBeCloseTo(0.99997, 3);
  });

  it('decodes 8-bit unsigned PCM (silence at 128)', () => {
    const samples = new Uint8Array([128, 255, 0]);
    const wav = buildWav({ bitsPerSample: 8, data: samples.buffer });
    const decoded = decodeWavPcm(wav);
    expect(decoded.channelData[0][0]).toBeCloseTo(0, 5);
    expect(decoded.channelData[0][1]).toBeCloseTo(0.9922, 3);
    expect(decoded.channelData[0][2]).toBeCloseTo(-1, 3);
  });

  it('decodes 32-bit IEEE float PCM', () => {
    const samples = new Float32Array([0, 0.5, -0.75]);
    const wav = buildWav({ formatCode: 3, bitsPerSample: 32, data: samples.buffer });
    const decoded = decodeWavPcm(wav);
    expect(decoded.channelData[0][1]).toBeCloseTo(0.5, 6);
    expect(decoded.channelData[0][2]).toBeCloseTo(-0.75, 6);
  });

  it('decodes 24-bit signed PCM', () => {
    // -8388608 (24-bit min, i.e. -1.0 normalized) as little-endian: 0x00 0x00 0x80
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x80]);
    const wav = buildWav({ bitsPerSample: 24, data: data.buffer });
    const decoded = decodeWavPcm(wav);
    expect(decoded.channelData[0][0]).toBeCloseTo(0, 5);
    expect(decoded.channelData[0][1]).toBeCloseTo(-1, 5);
  });

  it('decodes 32-bit signed integer PCM', () => {
    const samples = new Int32Array([0, 1073741824, -2147483648, 2147483647]);
    const wav = buildWav({ bitsPerSample: 32, data: samples.buffer });
    const decoded = decodeWavPcm(wav);
    expect(decoded.channelData[0][0]).toBeCloseTo(0, 6);
    expect(decoded.channelData[0][1]).toBeCloseTo(0.5, 6);
    expect(decoded.channelData[0][2]).toBeCloseTo(-1, 6);
    expect(decoded.channelData[0][3]).toBeCloseTo(1, 6);
  });

  it('deinterleaves stereo frames per channel', () => {
    const samples = new Int16Array([100, -100, 200, -200]);
    const wav = buildWav({ numChannels: 2, data: samples.buffer });
    const decoded = decodeWavPcm(wav);
    expect(decoded.channelData).toHaveLength(2);
    expect(decoded.channelData[0][0]).toBeCloseTo(100 / 32768, 5);
    expect(decoded.channelData[1][0]).toBeCloseTo(-100 / 32768, 5);
    expect(decoded.channelData[0][1]).toBeCloseTo(200 / 32768, 5);
    expect(decoded.channelData[1][1]).toBeCloseTo(-200 / 32768, 5);
  });

  it('skips an unrelated chunk (e.g. ffmpeg LIST/INFO) before the data chunk', () => {
    const samples = new Int16Array([1000]);
    const wav = buildWav({
      data: samples.buffer,
      extraChunk: { id: 'LIST', body: new TextEncoder().encode('INFOISFTLavf').buffer as ArrayBuffer },
    });
    const decoded = decodeWavPcm(wav);
    expect(decoded.channelData[0][0]).toBeCloseTo(1000 / 32768, 4);
  });

  it('resolves WAVE_FORMAT_EXTENSIBLE PCM via the sub-format code', () => {
    const samples = new Int16Array([500]);
    // fmt chunk needs cbSize + a 22-byte extension for a valid EXTENSIBLE header; the parser
    // only reads the sub-format code at offset 24 within the chunk body.
    const fmtBodyLen = 40;
    const dataOffset = 12 + 8 + fmtBodyLen + 8;
    const buffer = new ArrayBuffer(dataOffset + samples.byteLength);
    const view = new DataView(buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, buffer.byteLength - 8, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, fmtBodyLen, true);
    const fmtBody = 20;
    view.setUint16(fmtBody, 0xfffe, true);
    view.setUint16(fmtBody + 2, 1, true);
    view.setUint32(fmtBody + 4, 22000, true);
    view.setUint32(fmtBody + 8, 22000 * 2, true);
    view.setUint16(fmtBody + 12, 2, true);
    view.setUint16(fmtBody + 14, 16, true);
    view.setUint16(fmtBody + 16, 22, true); // cbSize
    view.setUint16(fmtBody + 18, 16, true); // valid bits per sample
    view.setUint32(fmtBody + 20, 0, true); // channel mask
    view.setUint16(fmtBody + 24, 1, true); // sub-format code: PCM
    writeAscii(view, 12 + 8 + fmtBodyLen, 'data');
    view.setUint32(12 + 8 + fmtBodyLen + 4, samples.byteLength, true);
    new Uint8Array(buffer, dataOffset, samples.byteLength).set(new Uint8Array(samples.buffer));
    const decoded = decodeWavPcm(buffer);
    expect(decoded.channelData[0][0]).toBeCloseTo(500 / 32768, 4);
  });

  it('falls through to the base format code when an EXTENSIBLE fmt chunk is truncated before the sub-format bytes', () => {
    // A 24-byte fmt body (16-byte base + cbSize + validBits + channelMask, but no sub-format
    // GUID at all) must not be treated as having a readable sub-format code.
    const samples = new Int16Array([500]);
    const fmtBodyLen = 24;
    const dataOffset = 12 + 8 + fmtBodyLen + 8;
    const buffer = new ArrayBuffer(dataOffset + samples.byteLength);
    const view = new DataView(buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, buffer.byteLength - 8, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, fmtBodyLen, true);
    const fmtBody = 20;
    view.setUint16(fmtBody, 0xfffe, true);
    view.setUint16(fmtBody + 2, 1, true);
    view.setUint32(fmtBody + 4, 22000, true);
    view.setUint32(fmtBody + 8, 22000 * 2, true);
    view.setUint16(fmtBody + 12, 2, true);
    view.setUint16(fmtBody + 14, 16, true);
    view.setUint16(fmtBody + 16, 22, true); // cbSize (claims 22, but the chunk itself is truncated)
    view.setUint16(fmtBody + 18, 16, true); // valid bits per sample
    view.setUint32(fmtBody + 20, 0, true); // channel mask — chunk ends here, no GUID bytes follow
    writeAscii(view, 12 + 8 + fmtBodyLen, 'data');
    view.setUint32(12 + 8 + fmtBodyLen + 4, samples.byteLength, true);
    new Uint8Array(buffer, dataOffset, samples.byteLength).set(new Uint8Array(samples.buffer));
    // formatCode stays 0xfffe (unsupported), since there is no sub-format code to read.
    expect(() => decodeWavPcm(buffer)).toThrow(/Unsupported WAV sample format/);
  });

  it('rejects an unsupported bit depth before allocating channel buffers', () => {
    // A non-byte-aligned bit depth (4 here) would make bytesPerSample 0 and frameCount
    // effectively infinite if allocation happened before validation; assert it throws instead
    // of attempting a runaway Float32Array allocation.
    const dataLength = 8;
    const fmtBodyLen = 16;
    const dataOffset = 12 + 8 + fmtBodyLen + 8;
    const buffer = new ArrayBuffer(dataOffset + dataLength);
    const view = new DataView(buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, buffer.byteLength - 8, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, fmtBodyLen, true);
    const fmtBody = 20;
    view.setUint16(fmtBody, 1, true); // PCM
    view.setUint16(fmtBody + 2, 1, true); // mono
    view.setUint32(fmtBody + 4, 22000, true);
    view.setUint32(fmtBody + 8, 22000, true);
    view.setUint16(fmtBody + 12, 1, true);
    view.setUint16(fmtBody + 14, 4, true); // bitsPerSample: unsupported, non-byte-aligned
    writeAscii(view, 12 + 8 + fmtBodyLen, 'data');
    view.setUint32(12 + 8 + fmtBodyLen + 4, dataLength, true);
    expect(() => decodeWavPcm(buffer)).toThrow(/Unsupported WAV bit depth/);
  });

  it('throws for a non-RIFF buffer', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer;
    expect(() => decodeWavPcm(buffer)).toThrow(/RIFF\/WAVE/);
  });

  it('throws when there is no data chunk', () => {
    const buffer = new ArrayBuffer(12 + 24);
    const view = new DataView(buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, buffer.byteLength - 8, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 22000, true);
    view.setUint32(28, 44000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    expect(() => decodeWavPcm(buffer)).toThrow(/data chunk/);
  });

  it('throws for an unsupported format code', () => {
    const samples = new Int16Array([1]);
    const wav = buildWav({ formatCode: 6, bitsPerSample: 16, data: samples.buffer });
    expect(() => decodeWavPcm(wav)).toThrow(/Unsupported WAV sample format/);
  });
});

describe('getWavDurationSeconds', () => {
  it('computes duration from the header without decoding samples', () => {
    const samples = new Int16Array(22000 * 2); // 2 seconds at 22000 Hz, mono, 16-bit
    const wav = buildWav({ bitsPerSample: 16, sampleRate: 22000, data: samples.buffer });
    expect(getWavDurationSeconds(wav)).toBeCloseTo(2, 5);
  });

  it('accounts for channel count and bit depth when computing frame count', () => {
    const frameCount = 1000;
    const samples = new Int32Array(frameCount * 2); // stereo, 32-bit
    const wav = buildWav({ bitsPerSample: 32, numChannels: 2, sampleRate: 8000, data: samples.buffer });
    expect(getWavDurationSeconds(wav)).toBeCloseTo(frameCount / 8000, 5);
  });

  it('throws for a non-RIFF buffer, same as decodeWavPcm', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer;
    expect(() => getWavDurationSeconds(buffer)).toThrow(/RIFF\/WAVE/);
  });
});
