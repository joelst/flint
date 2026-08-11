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
  it('compares major/minor/patch against Node 22 floor', () => {
    expect(isNodeVersionAtLeast({ major: 22, minor: 0, patch: 0 })).toBe(true);
    expect(isNodeVersionAtLeast({ major: 22, minor: 1, patch: 0 })).toBe(true);
    expect(isNodeVersionAtLeast({ major: 24, minor: 0, patch: 0 })).toBe(true);
    expect(isNodeVersionAtLeast({ major: 20, minor: 20, patch: 2 })).toBe(false);
    expect(isNodeVersionAtLeast({ major: 18, minor: 19, patch: 0 })).toBe(false);
    expect(
      isNodeVersionAtLeast(
        { major: 22, minor: 0, patch: 0 },
        { major: 22, minor: 0, patch: 1 },
      ),
    ).toBe(false);
  });
});

describe('evaluateNodeProbe', () => {
  it('accepts Node 22+ (security-supported floor)', () => {
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

  it('rejects EOL and pre-22 versions', () => {
    for (const ver of ['v16.20.2', 'v18.19.0', 'v20.20.2']) {
      const r = evaluateNodeProbe({ stdout: ver });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('NODE_TOO_OLD');
        expect(r.message).toContain(ver);
        expect(r.message).toContain('winget');
      }
    }
  });

  it('handles unrecognized output', () => {
    const r = evaluateNodeProbe({ stdout: 'weird' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NODE_PROBE_FAILED');
  });
});

describe('guidance messages', () => {
  it('defaults to both-modes copy when no context', () => {
    const missing = buildNodeMissingMessage();
    expect(missing).toContain('Bundled runtime was not available');
    expect(missing).toContain('PATH');
    expect(missing).toContain('winget');
    expect(missing).toContain('brew');
    expect(missing).toContain('ensure:node');
  });

  it('uses bundled-only copy when only bundled was tried', () => {
    const viaFlag = buildNodeMissingMessage(undefined, { bundledOnly: true });
    expect(viaFlag).toContain('bundled Node');
    expect(viaFlag).toContain('reinstalling');
    expect(viaFlag).not.toContain('winget');
    expect(viaFlag).not.toContain('not found on PATH');

    const viaTried = buildNodeMissingMessage(undefined, { tried: ['bundled'] });
    expect(viaTried).toContain('bundled Node');
    expect(viaTried).not.toContain('winget');
  });

  it('uses PATH-only copy when only PATH was tried', () => {
    const pathOnly = buildNodeMissingMessage(undefined, { tried: ['path'] });
    expect(pathOnly).toContain('on your PATH');
    expect(pathOnly).toContain('Node.js was not found');
    expect(pathOnly).toContain('winget');
    expect(pathOnly).not.toContain('Bundled runtime was not available');
    expect(pathOnly).not.toContain('ensure:node');
  });

  it('mentions both when auto order failed', () => {
    const both = buildNodeMissingMessage(undefined, { tried: ['bundled', 'path'] });
    expect(both).toContain('Bundled runtime was not available');
    expect(both).toContain('PATH');
    expect(both).toContain('ensure:node');
  });

  it('too-old guidance still points at upgrade paths', () => {
    const old = buildNodeTooOldMessage({
      major: 16,
      minor: 0,
      patch: 0,
      raw: 'v16.0.0',
    });
    expect(old).toContain('too old');
    expect(old).toContain('nodejs.org');
    expect(old).toContain('ensure:node');
  });
});
