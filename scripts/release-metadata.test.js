import { describe, expect, it } from 'vitest';
import {
  CANONICAL_UPDATER_ENDPOINT,
  isCanonicalUpdaterEndpoint,
  isStrictSemver,
  normalizeVersion,
  parseSemver,
  validateReleaseInputs,
} from './release-metadata.cjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReleaseMetadata } from './verify-release-metadata.cjs';

describe('release metadata validation', () => {
  it('accepts the release versions used by the workflow', () => {
    expect(isStrictSemver('0.7.0')).toBe(true);
    expect(isStrictSemver('0.3.0-rc.1')).toBe(true);
    expect(parseSemver('0.3.0-rc.1')).toEqual({ prerelease: ['rc', '1'] });
  });

  it('normalizes partial release tags like the version sync script', () => {
    expect(normalizeVersion('0.4-mvp')).toBe('0.4.0-mvp');
    expect(normalizeVersion('0.7.0')).toBe('0.7.0');
  });

  it('rejects versions outside the sync script grammar', () => {
    for (const version of ['01.2.3', '0.7.0-01', '0.7.0-a..b', '0.7.0+', '0.7.0+build']) {
      expect(isStrictSemver(version), version).toBe(false);
    }
  });

  it('keeps prereleases out of the stable channel', () => {
    expect(validateReleaseInputs('0.7.0-rc.1', 'stable')).toContain('prerelease');
    expect(validateReleaseInputs('0.7.0-rc.1', 'evaluation')).toBeNull();
    expect(validateReleaseInputs('0.7.0', 'evaluation')).toBeNull();
  });

  it('requires the exact Flint updater endpoint', () => {
    expect(isCanonicalUpdaterEndpoint(CANONICAL_UPDATER_ENDPOINT)).toBe(true);
    expect(isCanonicalUpdaterEndpoint('https://github.com/other/project/releases/latest/download/latest.json')).toBe(false);
    expect(isCanonicalUpdaterEndpoint(`${CANONICAL_UPDATER_ENDPOINT}?wrong=true`)).toBe(false);
  });

  it('covers the checker filesystem and failure paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'flint-release-'));
    const tauriDir = join(root, 'src-tauri');
    mkdirSync(tauriDir);
    const writeFixture = (versions, endpoints) => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: versions.package }));
      writeFileSync(join(tauriDir, 'tauri.conf.json'), JSON.stringify({
        version: versions.tauri,
        plugins: { updater: { endpoints } },
      }));
      writeFileSync(join(tauriDir, 'Cargo.toml'), `[package]\nversion = "${versions.cargo}"\n`);
    };
    const log = { log: () => {}, error: () => {} };
    try {
      writeFixture(
        { package: '0.7.0', tauri: '0.7.0', cargo: '0.7.0' },
        [CANONICAL_UPDATER_ENDPOINT],
      );
      expect(verifyReleaseMetadata(root, '0.7.0', 'evaluation', log)).toBe(true);
      writeFixture(
        { package: '0.6.0', tauri: '0.7.0', cargo: '0.7.0' },
        [CANONICAL_UPDATER_ENDPOINT],
      );
      expect(verifyReleaseMetadata(root, '0.7.0', 'evaluation', log)).toBe(false);
      writeFixture(
        { package: '0.7.0', tauri: '0.7.0', cargo: '0.7.0' },
        [CANONICAL_UPDATER_ENDPOINT, 'https://example.com/updates.json'],
      );
      expect(verifyReleaseMetadata(root, '0.7.0', 'evaluation', log)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
