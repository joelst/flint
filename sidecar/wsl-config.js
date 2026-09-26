// Helpers for reading and editing %UserProfile%\.wslconfig so Flint can offer
// one-click WSL "mirrored" networking. WSL2's default NAT mode gives the VM its
// own loopback, so a client inside WSL cannot reach Flint on 127.0.0.1;
// mirrored mode (WSL >= 2.0 on Windows 11 22H2+) shares the host's interfaces,
// loopback included, which keeps Flint bound to 127.0.0.1 and keeps the
// gateway's loopback-only autoload working for WSL clients.
//
// Pure functions only — no fs or child_process — so they stay unit-testable;
// the sidecar owns the I/O.

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;

/**
 * Encodings .wslconfig shows up in: Notepad and PowerShell redirects produce
 * BOM'd UTF-8 or UTF-16LE. Detected so an edit writes back what the user's
 * other tools expect to read.
 */
export function detectConfigEncoding (buf) {
  if (!buf || buf.length === 0) return 'utf8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8-bom';
  return 'utf8';
}

/** Decode a .wslconfig buffer using its BOM (see detectConfigEncoding). */
export function decodeConfig (buf) {
  const enc = detectConfigEncoding(buf);
  if (enc === 'utf16le') return buf.subarray(2).toString('utf16le');
  if (enc === 'utf8-bom') return buf.subarray(3).toString('utf8');
  return (buf ?? Buffer.alloc(0)).toString('utf8');
}

/** Encode config text back to the encoding the file originally had. */
export function encodeConfig (text, encoding) {
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

/**
 * Value of `key` in the [wsl2] section, or null. Section and key names are
 * matched case-insensitively; comment lines (# or ;) are skipped.
 */
export function getWsl2Setting (text, key) {
  const keyLower = String(key).toLowerCase();
  let inWsl2 = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(SECTION_RE);
    if (section) { inWsl2 = section[1].trim().toLowerCase() === 'wsl2'; continue; }
    if (!inWsl2 || !line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim().toLowerCase() === keyLower) return line.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Returns the config text with `key=value` set in the [wsl2] section, touching
 * nothing else. Preserves the file's newline style; other sections, keys, and
 * comments pass through verbatim. If the key already exists (any casing) its
 * line is replaced in place; otherwise it is inserted right under the [wsl2]
 * header; a missing section is appended at the end.
 */
export function upsertWsl2Setting (text, key, value) {
  const src = String(text ?? '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.length ? src.split(/\r?\n/) : [];
  const keyLower = String(key).toLowerCase();

  let wsl2Header = -1;
  let inWsl2 = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const section = line.match(SECTION_RE);
    if (section) {
      inWsl2 = section[1].trim().toLowerCase() === 'wsl2';
      if (inWsl2 && wsl2Header < 0) wsl2Header = i;
      continue;
    }
    if (!inWsl2 || !line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq >= 0 && line.slice(0, eq).trim().toLowerCase() === keyLower) {
      lines[i] = `${key}=${value}`;
      return lines.join(eol);
    }
  }

  if (wsl2Header >= 0) {
    lines.splice(wsl2Header + 1, 0, `${key}=${value}`);
    return lines.join(eol);
  }

  const out = [...lines];
  if (out.length && out[out.length - 1].trim() !== '') out.push('');
  out.push('[wsl2]', `${key}=${value}`, '');
  return out.join(eol);
}

/**
 * First version number in `wsl --version` output. The label text is localized
 * ("WSL version:", "WSL-Version:", …) but the WSL version itself is always the
 * numeric tail of the first non-empty line.
 */
export function parseWslVersionOutput (text) {
  const firstLine = String(text ?? '').split(/\r?\n/).find(l => l.trim());
  const m = firstLine ? firstLine.match(/(\d+(?:\.\d+)+)/) : null;
  return m ? m[1] : null;
}

/** Mirrored networking needs store WSL >= 2.0 and Windows 11 22H2 (build 22621). */
export function supportsMirrored (wslVersion, windowsBuild) {
  const major = Number(String(wslVersion ?? '').split('.')[0]);
  return Number.isFinite(major) && major >= 2 && Number(windowsBuild) >= 22621;
}

/**
 * wsl.exe writes UTF-16LE to stdout, and `--version` output carries no BOM, so
 * detect the interleaved NUL bytes instead. Plain-ASCII UTF-8 output (or a
 * string from a non-buffer exec) passes through unchanged.
 */
export function decodeWslOutput (data) {
  if (typeof data === 'string') return data;
  const buf = Buffer.from(data ?? []);
  // A BOM settles it outright — and its 0xFF 0xFE bytes would defeat the
  // NUL-interleave heuristic below on short output.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2) {
    let nulEven = 0;
    let samples = 0;
    for (let i = 1; i < Math.min(buf.length, 256); i += 2) {
      samples++;
      if (buf[i] === 0) nulEven++;
    }
    if (samples > 0 && nulEven / samples > 0.5) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}
