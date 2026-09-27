import { describe, expect, it } from 'vitest';
import {
  createStoredZip,
  crc32,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_NAME_BYTES,
} from './zip-archive';

/**
 * A deliberately naive bitwise CRC-32, so the checksums in the archive are checked
 * against an implementation that shares no code with the one under test. `node:zlib`
 * exposes `crc32`, but only from Node 22.2, and this package supports all of Node 22.
 */
function nodeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A deliberately independent reader: it walks the central directory (the record a real
 * extractor trusts) rather than the local headers the writer emits first, so a writer
 * that keeps the two in sync by accident does not pass.
 */
function readCentralDirectory(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  expect(end).toBeGreaterThanOrEqual(0);

  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  expect(start + size).toBe(end);

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = [];
  let cursor = start;
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const declaredCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const fileName = decoder.decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));

    // Follow the offset the directory advertises into the local header.
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const body = Uint8Array.from(zip.subarray(dataStart, dataStart + compressedSize));

    entries.push({
      fileName,
      method,
      flags,
      declaredCrc,
      uncompressedSize,
      body: decoder.decode(body),
      bytes: body,
    });
    cursor += 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  expect(cursor).toBe(end);
  return entries;
}

const pair = [
  { fileName: 'flint.srt', body: '1\n00:00:00,000 --> 00:00:02,000\nhello\n' },
  { fileName: 'flint.timing.txt', body: 'Times are derived by Flint.\n' },
];

describe('createStoredZip', () => {
  it('stores every entry so an extractor recovers the exact text', () => {
    const entries = readCentralDirectory(createStoredZip(pair, new Date('2026-09-27T01:02:04Z')));
    expect(entries.map((entry) => entry.fileName)).toEqual(['flint.srt', 'flint.timing.txt']);
    expect(entries.map((entry) => entry.body)).toEqual(pair.map((file) => file.body));
    for (const entry of entries) {
      expect(entry.method).toBe(0); // STORE
      expect(entry.flags & 0x0800).toBe(0x0800); // UTF-8 names
    }
  });

  it.each([
    { name: 'ascii', body: 'plain text' },
    { name: 'accented', body: 'Héllo wörld' },
    { name: 'astral', body: 'emoji 🙂 and 𝔘𝔫𝔦𝔠𝔬𝔡𝔢' },
    { name: 'empty', body: '' },
  ])('records a checksum and byte length that match the stored $name bytes', ({ body }) => {
    const [entry] = readCentralDirectory(createStoredZip([{ fileName: 'note.txt', body }]));
    const expected = new TextEncoder().encode(body);
    expect(Array.from(entry.bytes)).toEqual(Array.from(expected));
    // Byte count, not character count: these differ for everything above ASCII.
    expect(entry.uncompressedSize).toBe(expected.length);
    // Checked against Node's own CRC-32 rather than this module's table.
    expect(entry.declaredCrc).toBe(nodeCrc32(Buffer.from(body, 'utf8')) >>> 0);
    expect(entry.body).toBe(body);
  });

  it('matches a known CRC-32 so the table itself cannot drift', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it.each([
    { name: 'no entries', entries: [], message: /at least one file/i },
    { name: 'a missing name', entries: [{ fileName: '', body: 'x' }], message: /file name/i },
    {
      name: 'a path separator',
      entries: [{ fileName: 'nested/note.txt', body: 'x' }],
      message: /must not contain a path/i,
    },
    {
      name: 'a duplicate name',
      entries: [
        { fileName: 'note.txt', body: 'a' },
        { fileName: 'note.txt', body: 'b' },
      ],
      message: /more than once/i,
    },
  ])('refuses to build an archive with $name', ({ entries, message }) => {
    expect(() => createStoredZip(entries as any)).toThrow(message);
  });

  it('refuses an entry larger than the supported size instead of truncating it', () => {
    const oversized = { fileName: 'big.txt', body: 'x'.repeat(MAX_ZIP_ENTRY_BYTES + 1) };
    expect(() => createStoredZip([oversized])).toThrow(/too large/i);
  });

  it('clamps a pre-1980 timestamp rather than emitting an impossible DOS date', () => {
    const zip = createStoredZip([{ fileName: 'note.txt', body: 'x' }], new Date('1970-01-01Z'));
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // The DOS date epoch is 1980, so a 1970 timestamp must clamp to exactly year 0.
    expect(view.getUint16(12, true) >>> 9).toBe(0);
    expect((view.getUint16(12, true) >>> 5) & 0x0f).toBe(1); // month 1, never the invalid 0
    expect(view.getUint16(12, true) & 0x1f).toBe(1); // day 1, never the invalid 0
    expect(view.getUint16(10, true)).toBe(0);
  });

  it('clamps a post-2107 timestamp to the last representable DOS date', () => {
    const zip = createStoredZip([{ fileName: 'note.txt', body: 'x' }], new Date('2200-06-15Z'));
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const encoded = view.getUint16(12, true);
    expect(encoded >>> 9).toBe(127); // 2107
    expect((encoded >>> 5) & 0x0f).toBe(12);
    expect(encoded & 0x1f).toBe(31);
  });
});

describe('ZIP32 field limits', () => {
  it('refuses more entries than the end record can count', () => {
    const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
      fileName: `f${i}.txt`,
      body: '',
    }));
    expect(() => createStoredZip(entries)).toThrow(/at most/);
    expect(() => createStoredZip(entries.slice(0, MAX_ZIP_ENTRIES))).not.toThrow();
  });

  it('refuses a file name longer than its 16-bit length field', () => {
    const tooLong = 'a'.repeat(MAX_ZIP_NAME_BYTES + 1);
    expect(() => createStoredZip([{ fileName: tooLong, body: 'x' }])).toThrow(/file name/);
  });

  it('measures the name limit in bytes rather than characters', () => {
    // A multi-byte name that is well under the limit by character count still overruns it.
    const name = 'é'.repeat(MAX_ZIP_NAME_BYTES);
    expect(() => createStoredZip([{ fileName: name, body: 'x' }])).toThrow(/file name/);
  });
});
