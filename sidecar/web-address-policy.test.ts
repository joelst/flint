import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalHostname,
  ipLiteralFamily,
  isDeniedAddress,
  isLocalHostname,
  isPotentiallyPublicHostname,
} from './web-address-policy.js';

describe('web address policy', () => {
  it('imports nothing so the browser and the helper share it', () => {
    const source = readFileSync(join(process.cwd(), 'sidecar', 'web-address-policy.js'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it.each([
    '1.2.3.4', '255.255.255.255', '01.2.3.4', '1.2.3', '256.1.1.1', '::', '::1', '2001:db8::1',
    'fe80::1%eth0', '::ffff:127.0.0.1', '::ffff:01.2.3.4', '1::2::3', 'example.com', '', '[::1]',
  ])('classifies %s like net.isIP', (value) => {
    expect(ipLiteralFamily(value)).toBe(net.isIP(value));
  });

  it('denies special ranges and allows public addresses', () => {
    for (const denied of ['127.0.0.1', '10.1.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '::10.0.0.1', '2002::1', 'host']) {
      expect(isDeniedAddress(denied)).toBe(true);
    }
    for (const allowed of ['1.1.1.1', '2606:4700:4700::1111', '::ffff:1.1.1.1']) {
      expect(isDeniedAddress(allowed)).toBe(false);
    }
  });

  it('recognizes local names, including trailing root dots', () => {
    expect(canonicalHostname('LocalHost..')).toBe('localhost');
    expect(canonicalHostname(undefined as any)).toBe('');
    for (const local of ['', 'localhost', 'a.localhost.', 'local', 'printer.local']) {
      expect(isLocalHostname(local)).toBe(true);
    }
    expect(isLocalHostname('localhost.example.com')).toBe(false);
  });

  it('screens URL hostnames without DNS', () => {
    expect(isPotentiallyPublicHostname('example.com')).toBe(true);
    expect(isPotentiallyPublicHostname('[2606:4700:4700::1111]')).toBe(true);
    expect(isPotentiallyPublicHostname('[::1]')).toBe(false);
    expect(isPotentiallyPublicHostname('127.0.0.1')).toBe(false);
    expect(isPotentiallyPublicHostname('[not-an-ip]')).toBe(false);
    expect(isPotentiallyPublicHostname('[1.1.1.1]')).toBe(false);
    expect(isPotentiallyPublicHostname('1.1.1.1')).toBe(true);
  });
});
