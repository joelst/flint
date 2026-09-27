/**
 * Minimal ZIP writer for bundling a handful of small generated text files into one
 * download.
 *
 * Deliberately narrow: STORE (no compression), no encryption, no ZIP64, and only
 * filenames this app generates. It exists so an export whose parts must stay together
 * can be delivered as a single request, because a page cannot observe whether a second
 * download was accepted. It is not a general-purpose archiver — reject anything outside
 * the supported range rather than emitting a file a real extractor would mis-read.
 */

export interface ZipEntry {
  fileName: string;
  /** File contents. Encoded as UTF-8. */
  body: string;
}

/** ZIP32 stores sizes and offsets as unsigned 32-bit values. */
const MAX_ZIP32_BYTES = 0xffffffff;
/** Well beyond any transcript, and keeps the whole archive comfortably in memory. */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * MS-DOS timestamps have two-second resolution and cannot represent a year before 1980.
 * Out-of-range dates are clamped rather than rejected: an odd mtime is never a reason to
 * fail an export.
 */
function dosDateTime(date: Date): { time: number; date: number } {
  const valid = Number.isFinite(date?.getTime?.()) ? date : new Date(0);
  const year = Math.min(Math.max(valid.getFullYear(), 1980), 2107);
  return {
    time:
      (valid.getHours() << 11) | (valid.getMinutes() << 5) | (Math.floor(valid.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((valid.getMonth() + 1) << 5) | valid.getDate(),
  };
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  /** Little-endian, which is the only byte order the ZIP format uses. */
  pushUint16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  pushUint32(value: number): void {
    this.push(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    );
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** Bit 11 marks the filename as UTF-8, which every modern extractor honours. */
const UTF8_NAME_FLAG = 0x0800;
const STORE_METHOD = 0;
const VERSION_NEEDED = 20;

export function createStoredZip(
  entries: readonly ZipEntry[],
  now: Date = new Date(),
): Uint8Array {
  if (entries.length === 0) throw new Error('A zip archive needs at least one file');

  const seen = new Set<string>();
  for (const entry of entries) {
    const name = String(entry?.fileName ?? '');
    if (!name) throw new Error('Zip entries need a file name');
    // A path separator would make the archive expand somewhere unexpected, and a
    // duplicate name silently loses one of the files on extraction.
    if (/[\\/]/.test(name)) throw new Error(`Zip entry "${name}" must not contain a path`);
    if (seen.has(name)) throw new Error(`Zip entry "${name}" is listed more than once`);
    seen.add(name);
  }

  const { time, date } = dosDateTime(now);
  const local = new ByteWriter();
  const central = new ByteWriter();

  for (const entry of entries) {
    const nameBytes = utf8(entry.fileName);
    const bodyBytes = utf8(String(entry.body ?? ''));
    if (bodyBytes.length > MAX_ZIP_ENTRY_BYTES) {
      throw new Error(`Zip entry "${entry.fileName}" is too large to archive`);
    }
    const checksum = crc32(bodyBytes);
    const offset = local.length;

    local.pushUint32(0x04034b50);
    local.pushUint16(VERSION_NEEDED);
    local.pushUint16(UTF8_NAME_FLAG);
    local.pushUint16(STORE_METHOD);
    local.pushUint16(time);
    local.pushUint16(date);
    local.pushUint32(checksum);
    local.pushUint32(bodyBytes.length); // compressed == uncompressed for STORE
    local.pushUint32(bodyBytes.length);
    local.pushUint16(nameBytes.length);
    local.pushUint16(0); // no extra field
    local.push(nameBytes);
    local.push(bodyBytes);

    central.pushUint32(0x02014b50);
    central.pushUint16(VERSION_NEEDED); // version made by
    central.pushUint16(VERSION_NEEDED);
    central.pushUint16(UTF8_NAME_FLAG);
    central.pushUint16(STORE_METHOD);
    central.pushUint16(time);
    central.pushUint16(date);
    central.pushUint32(checksum);
    central.pushUint32(bodyBytes.length);
    central.pushUint32(bodyBytes.length);
    central.pushUint16(nameBytes.length);
    central.pushUint16(0); // extra
    central.pushUint16(0); // comment
    central.pushUint16(0); // disk number
    central.pushUint16(0); // internal attributes
    central.pushUint32(0); // external attributes
    central.pushUint32(offset);
    central.push(nameBytes);
  }

  if (local.length + central.length > MAX_ZIP32_BYTES) {
    throw new Error('Archive is too large to write without ZIP64');
  }

  const end = new ByteWriter();
  end.pushUint32(0x06054b50);
  end.pushUint16(0); // this disk
  end.pushUint16(0); // disk with central directory
  end.pushUint16(entries.length);
  end.pushUint16(entries.length);
  end.pushUint32(central.length);
  end.pushUint32(local.length);
  end.pushUint16(0); // no archive comment

  const out = new ByteWriter();
  out.push(local.concat());
  out.push(central.concat());
  out.push(end.concat());
  return out.concat();
}
