// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encodeEmbedding } from './embedding-encoding.js';

describe('local gateway embedding encoding', () => {
  it('preserves numeric vectors for omitted or float encoding', () => {
    const vector = [0.125, -0.5];
    expect(encodeEmbedding(vector)).toBe(vector);
    expect(encodeEmbedding(vector, 'float')).toBe(vector);
  });

  it('encodes a float32 little-endian vector as OpenAI base64', () => {
    const bytes = Buffer.from(encodeEmbedding([0.125, -0.5, 1 / 3], 'base64'), 'base64');
    expect(bytes.length).toBe(12);
    expect(bytes.readFloatLE(0)).toBe(0.125);
    expect(bytes.readFloatLE(4)).toBe(-0.5);
    expect(bytes.readFloatLE(8)).toBeCloseTo(1 / 3, 6);
  });

  it('rejects encodings or components that cannot be represented', () => {
    expect(() => encodeEmbedding([1], 'hex')).toThrow(/encoding/);
    expect(() => encodeEmbedding([1e100], 'base64')).toThrow(/float32/);
  });
});
