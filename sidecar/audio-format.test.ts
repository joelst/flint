import { describe, it, expect } from 'vitest';
import { sniffAudioFormat, assertWavBuffer } from './audio-format.js';

/** Minimal but structurally real 16-bit PCM WAV header + n sample bytes. */
function makeWav(dataBytes = 4) {
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function withMagic(bytes) {
  const buf = Buffer.alloc(32);
  Buffer.from(bytes).copy(buf, 0);
  return buf;
}

describe('sniffAudioFormat', () => {
  it('identifies a real WAV header', () => {
    expect(sniffAudioFormat(makeWav())).toBe('wav');
  });

  it('does not accept RIFF containers that are not WAVE', () => {
    const buf = makeWav();
    buf.write('AVI ', 8, 'ascii');
    expect(sniffAudioFormat(buf)).not.toBe('wav');
  });

  it('identifies WebM/Matroska, the format MediaRecorder produces by default', () => {
    expect(sniffAudioFormat(withMagic([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm');
  });

  it('identifies Ogg', () => {
    expect(sniffAudioFormat(withMagic([0x4f, 0x67, 0x67, 0x53]))).toBe('ogg');
  });

  it('identifies FLAC', () => {
    expect(sniffAudioFormat(withMagic([0x66, 0x4c, 0x61, 0x43]))).toBe('flac');
  });

  it('identifies MP4/M4A by the ftyp box at offset 4', () => {
    expect(sniffAudioFormat(withMagic([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe('mp4');
  });

  it('identifies MP3 via an ID3 tag and via a bare frame sync', () => {
    expect(sniffAudioFormat(withMagic([0x49, 0x44, 0x33, 0x04]))).toBe('mp3');
    expect(sniffAudioFormat(withMagic([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
  });

  it('reports empty and too-short payloads distinctly', () => {
    expect(sniffAudioFormat(Buffer.alloc(0))).toBe('empty');
    expect(sniffAudioFormat(Buffer.from([0x52, 0x49]))).toBe('unknown');
  });

  it('reports unrecognized bytes as unknown', () => {
    expect(sniffAudioFormat(withMagic([0x00, 0x01, 0x02, 0x03]))).toBe('unknown');
  });
});

describe('assertWavBuffer', () => {
  it('accepts a WAV payload', () => {
    expect(() => assertWavBuffer(makeWav())).not.toThrow();
  });

  it('names the offending format so the user knows what to convert', () => {
    expect(() => assertWavBuffer(withMagic([0x1a, 0x45, 0xdf, 0xa3]), 'note.webm')).toThrow(
      /WebM/,
    );
    expect(() => assertWavBuffer(withMagic([0x1a, 0x45, 0xdf, 0xa3]), 'note.webm')).toThrow(
      /note\.webm/,
    );
  });

  it('rejects a non-WAV payload that was merely renamed to .wav', () => {
    // The exact regression: the handler renames by filename and trusts it.
    expect(() => assertWavBuffer(withMagic([0x1a, 0x45, 0xdf, 0xa3]), 'recording.wav')).toThrow(
      /not WAV/,
    );
  });

  it('reports an empty payload clearly', () => {
    expect(() => assertWavBuffer(Buffer.alloc(0), 'x.wav')).toThrow(/empty/i);
  });

  it('reports unidentifiable bytes without guessing', () => {
    expect(() => assertWavBuffer(withMagic([0x00, 0x01, 0x02, 0x03]), 'x.wav')).toThrow(
      /could not be identified/,
    );
  });
});
