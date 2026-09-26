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
});
