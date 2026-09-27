import { describe, expect, it } from 'vitest';
import { extractNemotronPcm, parseWavHeader } from './wav-pcm.js';

function buildWav ({ sampleRate = 16000, channels = 1, bitsPerSample = 16, data = new Uint8Array([1, 2, 3, 4]) } = {}) {
  const extra = new Uint8Array(12);
  extra.set([...'JUNK'].map((char) => char.charCodeAt(0)), 0);
  new DataView(extra.buffer).setUint32(4, 4, true);
  extra.set([9, 8, 7, 6], 8);
  const dataOffset = 12 + 24 + extra.byteLength + 8;
  const bytes = new Uint8Array(dataOffset + data.length);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
  view.setUint16(32, channels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);
  bytes.set(extra, 36);
  ascii(dataOffset - 8, 'data');
  view.setUint32(dataOffset - 4, data.length, true);
  bytes.set(data, dataOffset);
  return bytes;
}

function buildShortFmtWav () {
  const bytes = new Uint8Array(54);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 2, true);
  view.setUint16(20, 1, true);

  // These bytes belong to the next unknown chunk, but the malformed fmt parser used to
  // borrow them as channels, sample rate, and bit depth.
  view.setUint16(22, 1, true);
  view.setUint16(24, 16000, true);
  view.setUint32(26, 0, true);

  ascii(30, 'data');
  view.setUint32(34, 16, true);
  bytes.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 38);
  return bytes;
}

function appendChunk (wav, id, body) {
  const paddedLength = body.length + (body.length % 2);
  const bytes = new Uint8Array(wav.length + 8 + paddedLength);
  bytes.set(wav);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < id.length; i += 1) view.setUint8(wav.length + i, id.charCodeAt(i));
  view.setUint32(wav.length + 4, body.length, true);
  bytes.set(body, wav.length + 8);
  view.setUint32(4, bytes.length - 8, true);
  return bytes;
}

function buildExtensibleWav ({
  cbSize = 22,
  subtype = 1,
  bitsPerSample = 16,
  guidTail = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113],
} = {}) {
  const fmtBodyLength = 40;
  const dataOffset = 12 + 8 + fmtBodyLength + 8;
  const bytes = new Uint8Array(dataOffset + 4);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, fmtBodyLength, true);
  const fmtBody = 20;
  view.setUint16(fmtBody, 0xfffe, true);
  view.setUint16(fmtBody + 2, 1, true);
  view.setUint32(fmtBody + 4, 16000, true);
  view.setUint32(fmtBody + 8, 16000 * bitsPerSample / 8, true);
  view.setUint16(fmtBody + 12, bitsPerSample / 8, true);
  view.setUint16(fmtBody + 14, bitsPerSample, true);
  view.setUint16(fmtBody + 16, cbSize, true);
  view.setUint16(fmtBody + 18, bitsPerSample, true);
  view.setUint32(fmtBody + 20, 0, true);
  view.setUint32(fmtBody + 24, subtype, true);
  bytes.set(guidTail, fmtBody + 28);
  ascii(dataOffset - 8, 'data');
  view.setUint32(dataOffset - 4, 4, true);
  bytes.set([1, 2, 3, 4], dataOffset);
  return bytes;
}

describe('shared WAV PCM parser', () => {
  it('extracts sample bytes after non-audio RIFF chunks', () => {
    const wav = buildWav();
    const pcm = extractNemotronPcm(wav);
    expect([...pcm]).toEqual([1, 2, 3, 4]);
    expect(parseWavHeader(wav).dataOffset).toBeGreaterThan(44);
  });

  it('honors a Uint8Array byte offset instead of parsing the surrounding buffer', () => {
    const wav = buildWav();
    const surrounded = new Uint8Array(wav.length + 6);
    surrounded.set(wav, 3);
    expect([...extractNemotronPcm(surrounded.subarray(3, 3 + wav.length))]).toEqual([1, 2, 3, 4]);
  });

  it.each([
    ['sample rate', buildWav({ sampleRate: 22000 })],
    ['channel count', buildWav({ channels: 2 })],
    ['sample depth', buildWav({ bitsPerSample: 32 })],
    ['partial sample', buildWav({ data: new Uint8Array([1, 2, 3]) })],
  ])('rejects unsupported Nemotron %s', (_label, wav) => {
    expect(() => extractNemotronPcm(wav)).toThrow(/Nemotron speech requires/);
  });

  it('rejects truncated sample payloads', () => {
    const wav = buildWav();
    new DataView(wav.buffer).setUint32(wav.length - 8, 100, true);
    expect(() => extractNemotronPcm(wav)).toThrow(/truncated/i);
  });

  it('rejects a fmt chunk shorter than the 16-byte PCM base header', () => {
    expect(() => extractNemotronPcm(buildShortFmtWav())).toThrow(/fmt chunk is too short/i);
  });

  it('rejects a truncated fmt chunk before reading its fields', () => {
    const wav = buildWav();
    const truncated = wav.subarray(0, 30);
    expect(() => parseWavHeader(truncated)).toThrow(/fmt chunk is truncated/i);
  });

  it('rejects a fmt chunk whose declared extension is truncated', () => {
    const wav = buildWav();
    new DataView(wav.buffer).setUint32(16, 40, true);
    expect(() => parseWavHeader(wav.subarray(0, 40))).toThrow(/fmt chunk is truncated/i);
  });

  it('uses the first fmt and data chunks when duplicates follow', () => {
    const secondFmt = new Uint8Array(16);
    const fmtView = new DataView(secondFmt.buffer);
    fmtView.setUint16(0, 1, true);
    fmtView.setUint16(2, 2, true);
    fmtView.setUint32(4, 48000, true);
    fmtView.setUint16(14, 32, true);
    const withSecondData = appendChunk(buildWav(), 'data', new Uint8Array([9, 10, 11, 12]));
    const duplicated = appendChunk(withSecondData, 'fmt ', secondFmt);
    expect([...extractNemotronPcm(duplicated)]).toEqual([1, 2, 3, 4]);
  });

  it('rejects an extensible format with an undersized declared extension', () => {
    expect(() => extractNemotronPcm(buildExtensibleWav({ cbSize: 0 }))).toThrow(/complete declared extension/i);
  });

  it('rejects an extensible format whose complete subtype GUID is not PCM', () => {
    expect(() => extractNemotronPcm(buildExtensibleWav({
      guidTail: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 9, 8],
    }))).toThrow(/subtype/i);
  });

  it('rejects an extensible format whose declared extension exceeds the fmt body', () => {
    expect(() => extractNemotronPcm(buildExtensibleWav({ cbSize: 30 }))).toThrow(/complete declared extension/i);
  });

  it('accepts a complete extensible PCM subtype GUID', () => {
    expect([...extractNemotronPcm(buildExtensibleWav())]).toEqual([1, 2, 3, 4]);
  });

  it('recognizes a complete extensible IEEE-float subtype GUID', () => {
    const header = parseWavHeader(buildExtensibleWav({ subtype: 3, bitsPerSample: 32 }));
    expect(header.formatCode).toBe(3);
    expect(header.isFloat).toBe(true);
  });
});
