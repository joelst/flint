import { describe, expect, it } from 'vitest';
import {
  extractFieldsByCommand,
  extractObjectKeys,
  extractQuotedValues,
  splitTopLevelEntries,
  verifyIpcContractSources,
} from './verify-ipc-contracts.cjs';

/** Minimal, valid fixture set mirroring the real files' shape for one command. */
function fixtures() {
  return {
    typed: `
      export const KNOWN_COMMANDS = new Set<SidecarCommandName>([
        'getStatus', 'unload',
      ]);
    `,
    sidecar: `
      const KNOWN_COMMANDS = new Set([
        'getStatus', 'unload',
      ]);
      const COMMAND_SCHEMA = {
        getStatus: { required: [], optional: [] },
        unload:    { required: ['alias'], optional: ['lane'] },
      };
      const FIELD_TYPES = {
        unload: { alias: 'non-empty-string' },
      };
    `,
    outcomes: `
      export const COMMAND_EFFECTS: Record<SidecarCommandName, OperationEffect> = {
        getStatus: 'query',
        unload: 'effectful',
      };
    `,
    deadlines: `
      export const IPC_COMMAND_DEADLINES_MS: Record<SidecarCommandName, number | null> = {
        getStatus: 10_000,
        unload: null,
      };
    `,
  };
}

describe('verify-ipc-contracts fixture parsing', () => {
  it('extracts quoted command literals', () => {
    const values = extractQuotedValues(
      "new Set([\n  'a', 'b',\n]);",
      'new Set([',
      ']);',
    );
    expect(values).toEqual(['a', 'b']);
  });

  it('rejects a non-literal token between markers', () => {
    expect(() =>
      extractQuotedValues("new Set([\n  ...spread, 'a',\n]);", 'new Set([', ']);'),
    ).toThrow(/Unsupported syntax/);
  });

  it('extracts top-level object keys, ignoring nested object keys', () => {
    const keys = extractObjectKeys(
      'const X = {\n  a: { nested: 1 },\n  b: 2,\n};',
      'const X =',
    );
    expect(keys).toEqual(['a', 'b']);
  });

  it('splits top-level entries without breaking on nested commas', () => {
    const entries = splitTopLevelEntries("a: { required: ['x', 'y'], optional: [] },\nb: 2");
    expect(entries).toEqual([
      ['a', "{ required: ['x', 'y'], optional: [] }"],
      ['b', '2'],
    ]);
  });

  it('ignores line comments when splitting entries', () => {
    const entries = splitTopLevelEntries("// a comment\na: 'query',\nb: 'effectful',");
    expect(entries).toEqual([
      ['a', "'query'"],
      ['b', "'effectful'"],
    ]);
  });

  it('extracts quoted-literal fields for COMMAND_SCHEMA and object-key fields for FIELD_TYPES', () => {
    const schema = extractFieldsByCommand(fixtures().sidecar, 'const COMMAND_SCHEMA =', {
      fieldsAsQuotedLiterals: true,
    });
    expect(schema.get('unload')).toEqual(['alias', 'lane']);

    const fieldTypes = extractFieldsByCommand(fixtures().sidecar, 'const FIELD_TYPES =', {
      fieldsAsQuotedLiterals: false,
    });
    expect(fieldTypes.get('unload')).toEqual(['alias']);
  });
});

describe('verifyIpcContractSources', () => {
  it('passes on a consistent fixture set', () => {
    expect(verifyIpcContractSources(fixtures(), { log: () => {} })).toBe(2);
  });

  it('detects a command missing from the sidecar allowlist', () => {
    const broken = fixtures();
    broken.sidecar = broken.sidecar.replace("'getStatus', 'unload',", "'unload',");
    expect(() => verifyIpcContractSources(broken, { log: () => {} })).toThrow(
      /sidecar command allowlist drifted/,
    );
  });

  it('detects a command missing from COMMAND_SCHEMA', () => {
    const broken = fixtures();
    broken.sidecar = broken.sidecar.replace('getStatus: { required: [], optional: [] },\n', '');
    expect(() => verifyIpcContractSources(broken, { log: () => {} })).toThrow(
      /sidecar command schema drifted/,
    );
  });

  it('detects a command missing from COMMAND_EFFECTS', () => {
    const broken = fixtures();
    broken.outcomes = broken.outcomes.replace("getStatus: 'query',\n", '');
    expect(() => verifyIpcContractSources(broken, { log: () => {} })).toThrow(
      /operation effect classification drifted/,
    );
  });

  it('detects a command missing from IPC_COMMAND_DEADLINES_MS', () => {
    const broken = fixtures();
    broken.deadlines = broken.deadlines.replace('getStatus: 10_000,\n', '');
    expect(() => verifyIpcContractSources(broken, { log: () => {} })).toThrow(
      /IPC deadline classification drifted/,
    );
  });

  it('detects a FIELD_TYPES field name absent from COMMAND_SCHEMA', () => {
    const broken = fixtures();
    broken.sidecar = broken.sidecar.replace(
      "unload: { alias: 'non-empty-string' },",
      "unload: { aliass: 'non-empty-string' },",
    );
    expect(() => verifyIpcContractSources(broken, { log: () => {} })).toThrow(
      /FIELD_TYPES\.unload declares field "aliass"/,
    );
  });

  it('detects FIELD_TYPES declaring an unknown command', () => {
    const broken = fixtures();
    broken.sidecar = broken.sidecar.replace(
      "const FIELD_TYPES = {\n        unload: { alias: 'non-empty-string' },\n      };",
      "const FIELD_TYPES = {\n        unload: { alias: 'non-empty-string' },\n        ghost: { x: 'string' },\n      };",
    );
    expect(() => verifyIpcContractSources(broken, { log: () => {} })).toThrow(
      /FIELD_TYPES declares an unknown command: ghost/,
    );
  });
});
