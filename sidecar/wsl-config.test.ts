import { describe, it, expect } from 'vitest';
import {
  detectConfigEncoding,
  decodeConfig,
  encodeConfig,
  getWsl2Setting,
  upsertWsl2Setting,
  parseWslVersionOutput,
  supportsMirrored,
  decodeWslOutput,
} from './wsl-config.js';

describe('detectConfigEncoding / decodeConfig / encodeConfig', () => {
  it('detects plain utf8', () => {
    expect(detectConfigEncoding(Buffer.from('[wsl2]\n'))).toBe('utf8');
  });

  it('detects utf8 BOM and round-trips it', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[wsl2]\nmemory=4GB\n')]);
    expect(detectConfigEncoding(buf)).toBe('utf8-bom');
    const text = decodeConfig(buf);
    expect(text).toBe('[wsl2]\nmemory=4GB\n');
    expect(encodeConfig(text, 'utf8-bom').equals(buf)).toBe(true);
  });

  it('detects utf16le BOM and round-trips it', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[wsl2]\r\n', 'utf16le')]);
    expect(detectConfigEncoding(buf)).toBe('utf16le');
    const text = decodeConfig(buf);
    expect(text).toBe('[wsl2]\r\n');
    expect(encodeConfig(text, 'utf16le').equals(buf)).toBe(true);
  });

  it('treats an empty buffer as utf8', () => {
    expect(detectConfigEncoding(Buffer.alloc(0))).toBe('utf8');
    expect(decodeConfig(Buffer.alloc(0))).toBe('');
  });
});

describe('getWsl2Setting', () => {
  it('reads a key from the [wsl2] section', () => {
    expect(getWsl2Setting('[wsl2]\nnetworkingMode=mirrored\n', 'networkingMode')).toBe('mirrored');
  });

  it('is case-insensitive on section and key names', () => {
    expect(getWsl2Setting('[WSL2]\nNetworkingMode = NAT\n', 'networkingmode')).toBe('NAT');
  });

  it('ignores keys in other sections', () => {
    expect(getWsl2Setting('[experimental]\nnetworkingMode=mirrored\n', 'networkingMode')).toBe(null);
  });

  it('ignores commented lines', () => {
    expect(getWsl2Setting('[wsl2]\n# networkingMode=mirrored\n; networkingMode=mirrored\n', 'networkingMode')).toBe(null);
  });

  it('returns null for empty or missing input', () => {
    expect(getWsl2Setting('', 'networkingMode')).toBe(null);
    expect(getWsl2Setting(null as any, 'networkingMode')).toBe(null);
  });

  it('tolerates whitespace around the separator', () => {
    expect(getWsl2Setting('[wsl2]\n  networkingMode   =   mirrored  \n', 'networkingMode')).toBe('mirrored');
  });
});

describe('upsertWsl2Setting', () => {
  it('creates the section in an empty file', () => {
    expect(upsertWsl2Setting('', 'networkingMode', 'mirrored')).toBe('[wsl2]\nnetworkingMode=mirrored\n');
  });

  it('replaces an existing key in place, preserving neighbors', () => {
    const src = '[wsl2]\nmemory=4GB\nnetworkingMode=NAT\nprocessors=2\n';
    expect(upsertWsl2Setting(src, 'networkingMode', 'mirrored'))
      .toBe('[wsl2]\nmemory=4GB\nnetworkingMode=mirrored\nprocessors=2\n');
  });

  it('replaces a key with different casing', () => {
    const src = '[WSL2]\nnetworkingmode=nat\n';
    expect(upsertWsl2Setting(src, 'networkingMode', 'mirrored')).toBe('[WSL2]\nnetworkingMode=mirrored\n');
  });

  it('inserts under an existing [wsl2] header when the key is absent', () => {
    const src = '# my config\n[wsl2]\nmemory=4GB\n\n[experimental]\nsparseVhd=true\n';
    expect(upsertWsl2Setting(src, 'networkingMode', 'mirrored'))
      .toBe('# my config\n[wsl2]\nnetworkingMode=mirrored\nmemory=4GB\n\n[experimental]\nsparseVhd=true\n');
  });

  it('appends a new section when [wsl2] is missing, keeping other sections', () => {
    const src = '[experimental]\nsparseVhd=true\n';
    expect(upsertWsl2Setting(src, 'networkingMode', 'mirrored'))
      .toBe('[experimental]\nsparseVhd=true\n\n[wsl2]\nnetworkingMode=mirrored\n');
  });

  it('does not touch a same-named key in another section', () => {
    const src = '[experimental]\nnetworkingMode=weird\n';
    const out = upsertWsl2Setting(src, 'networkingMode', 'mirrored');
    expect(out).toContain('[experimental]\nnetworkingMode=weird');
    expect(out).toContain('[wsl2]\nnetworkingMode=mirrored');
  });

  it('preserves CRLF line endings', () => {
    const src = '[wsl2]\r\nmemory=4GB\r\n';
    expect(upsertWsl2Setting(src, 'networkingMode', 'mirrored'))
      .toBe('[wsl2]\r\nnetworkingMode=mirrored\r\nmemory=4GB\r\n');
  });

  it('does not treat commented-out keys as existing', () => {
    const src = '[wsl2]\n# networkingMode=NAT\n';
    expect(upsertWsl2Setting(src, 'networkingMode', 'mirrored'))
      .toBe('[wsl2]\nnetworkingMode=mirrored\n# networkingMode=NAT\n');
  });
});

describe('parseWslVersionOutput', () => {
  it('parses the standard english output', () => {
    const out = 'WSL version: 2.3.26.0\nKernel version: 5.15.167.4-1\nWindows version: 10.0.26100.2033\n';
    expect(parseWslVersionOutput(out)).toBe('2.3.26.0');
  });

  it('parses localized labels (version is the numeric tail)', () => {
    expect(parseWslVersionOutput('WSL-Version: 2.0.9.0\n')).toBe('2.0.9.0');
  });

  it('returns null for garbage or empty output', () => {
    expect(parseWslVersionOutput('')).toBe(null);
    expect(parseWslVersionOutput('Usage: wsl.exe [options]')).toBe(null);
  });

  it('skips leading blank lines', () => {
    expect(parseWslVersionOutput('\n\nWSL version: 2.1.5.0\n')).toBe('2.1.5.0');
  });
});

describe('supportsMirrored', () => {
  it('true for WSL 2.x on Win11 22H2+', () => {
    expect(supportsMirrored('2.0.9.0', 22621)).toBe(true);
    expect(supportsMirrored('2.3.26.0', 26100)).toBe(true);
  });

  it('false for WSL 1.x or old Windows builds', () => {
    expect(supportsMirrored('1.2.5.0', 26100)).toBe(false);
    expect(supportsMirrored('2.0.9.0', 22000)).toBe(false);
  });

  it('false when version is unknown', () => {
    expect(supportsMirrored(null, 26100)).toBe(false);
    expect(supportsMirrored('', 26100)).toBe(false);
  });
});

describe('decodeWslOutput', () => {
  it('decodes utf16le output from wsl.exe', () => {
    const buf = Buffer.from('WSL version: 2.3.26.0\r\n', 'utf16le');
    expect(decodeWslOutput(buf)).toBe('WSL version: 2.3.26.0\r\n');
  });

  it('passes plain utf8 buffers through', () => {
    expect(decodeWslOutput(Buffer.from('hello\n'))).toBe('hello\n');
  });

  it('passes strings through unchanged', () => {
    expect(decodeWslOutput('already a string')).toBe('already a string');
  });

  it('strips a leading BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x', 'utf16le')]);
    expect(decodeWslOutput(buf)).toBe('x');
  });
});
