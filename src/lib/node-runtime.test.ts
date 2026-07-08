import { describe, it, expect } from 'vitest';
import {
  parseNodeVersion,
  isNodeVersionAtLeast,
  evaluateNodeProbe,
  formatNodeVersion,
  MIN_NODE_VERSION,
  buildNodeMissingMessage,
  buildNodeTooOldMessage,
} from './node-runtime';

describe('parseNodeVersion', () => {
  it('parses v-prefixed and plain versions', () => {
    expect(parseNodeVersion('v18.19.0')).toEqual({
      major: 18,
      minor: 19,
      patch: 0,
      raw: 'v18.19.0',
    });
    expect(parseNodeVersion('20.11.1\n')).toEqual({
      major: 20,
      minor: 11,
      patch: 1,
      raw: 'v20.11.1',
    });
  });

  it('returns null for garbage', () => {
    expect(parseNodeVersion('')).toBeNull();
    expect(parseNodeVersion('not a version')).toBeNull();
  });
});

describe('isNodeVersionAtLeast', () => {
  it('compares major/minor/patch', () => {
    expect(isNodeVersionAtLeast({ major: 18, minor: 0, patch: 0 })).toBe(true);
    expect(isNodeVersionAtLeast({ major: 18, minor: 1, patch: 0 })).toBe(true);
    expect(isNodeVersionAtLeast({ major: 20, minor: 0, patch: 0 })).toBe(true);
    expect(isNodeVersionAtLeast({ major: 17, minor: 9, patch: 9 })).toBe(false);
    expect(
      isNodeVersionAtLeast(
        { major: 18, minor: 0, patch: 0 },
        { major: 18, minor: 0, patch: 1 },
      ),
    ).toBe(false);
  });
});

describe('evaluateNodeProbe', () => {
  it('accepts current LTS-class versions', () => {
    const r = evaluateNodeProbe({ stdout: 'v22.11.0' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version.major).toBe(22);
  });

  it('rejects missing node (enoent)', () => {
    const r = evaluateNodeProbe({
      probeError: "Error: spawn node ENOENT",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NODE_MISSING');
      expect(r.message).toContain('nodejs.org');
      expect(r.message).toContain(formatNodeVersion(MIN_NODE_VERSION));
    }
  });

  it('rejects too-old versions', () => {
    const r = evaluateNodeProbe({ stdout: 'v16.20.2' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NODE_TOO_OLD');
      expect(r.message).toContain('v16.20.2');
      expect(r.message).toContain('winget');
    }
  });

  it('handles unrecognized output', () => {
    const r = evaluateNodeProbe({ stdout: 'weird' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NODE_PROBE_FAILED');
  });
});

describe('guidance messages', () => {
  it('mention bundled Foundry and install paths', () => {
    const missing = buildNodeMissingMessage();
    expect(missing).toContain('bundled');
    expect(missing).toContain('winget');
    expect(missing).toContain('brew');

    const old = buildNodeTooOldMessage({
      major: 16,
      minor: 0,
      patch: 0,
      raw: 'v16.0.0',
    });
    expect(old).toContain('too old');
    expect(old).toContain('nodejs.org');
  });
});
