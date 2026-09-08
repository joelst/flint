import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMMAND_EFFECTS,
  certaintyFor,
  describeOutcome,
  effectOf,
  isUncertainOutcome,
  SidecarOperationError,
  type OperationEffect,
} from './operation-outcome';
import { KNOWN_COMMANDS } from './ipc-contracts';

describe('command classification', () => {
  it('classifies every command the frontend knows about', () => {
    const classified = new Set(Object.keys(COMMAND_EFFECTS));
    const known = new Set<string>(KNOWN_COMMANDS);
    expect([...known].filter((c) => !classified.has(c))).toEqual([]);
    expect([...classified].filter((c) => !known.has(c))).toEqual([]);
  });

  it('agrees with the command list the sidecar actually accepts', () => {
    // The sidecar is CommonJS and opens log files at module scope, so it is read rather than
    // imported. Without this, a command could be added to one side only and the mismatch would
    // not appear until a user hit it: the sidecar would reject a command the frontend sends, or
    // the frontend would classify one that does not exist.
    const source = readFileSync(join(process.cwd(), 'sidecar', 'foundry-sidecar.js'), 'utf8');
    const marker = 'const KNOWN_COMMANDS = new Set([';
    const start = source.indexOf(marker);
    expect(start, 'sidecar KNOWN_COMMANDS declaration not found').toBeGreaterThan(-1);
    const end = source.indexOf(']);', start);
    expect(end, 'sidecar KNOWN_COMMANDS is not terminated').toBeGreaterThan(start);
    const body = source.slice(start + marker.length, end);
    // Only a list of plain string literals is understood. Anything else means the declaration
    // grew a construct this test cannot read, and it should fail rather than silently pass.
    expect(body.replace(/'[^']*'|[\s,]|\/\/[^\n]*/g, '')).toBe('');
    const sidecarCommands = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(sidecarCommands.length).toBeGreaterThan(0);
    expect([...sidecarCommands].sort()).toEqual([...KNOWN_COMMANDS].sort());
  });

  it('treats an unrecognised command as able to change something', () => {
    // The unsafe direction is claiming a mutation did not happen.
    expect(effectOf('somethingAddedLater')).toBe('effectful');
    expect(certaintyFor('somethingAddedLater', 'connection-lost')).toBe('unknown');
  });

  it('classifies reaching a third-party server as effectful', () => {
    // The request may have been billed, consumed a single-use URL, or acted on. Flint cannot see.
    expect(COMMAND_EFFECTS.fetchUrl).toBe('effectful');
  });

  it('separates discovering execution providers from registering them', () => {
    expect(COMMAND_EFFECTS.getEps).toBe('query');
    expect(COMMAND_EFFECTS.ensureAccelerators).toBe('effectful');
  });

  it('classifies commands that reach outside the sidecar as effectful', () => {
    expect(COMMAND_EFFECTS.wslStatus).toBe('query');
    expect(COMMAND_EFFECTS.wslShutdown).toBe('effectful');
    expect(COMMAND_EFFECTS.wslEnableMirrored).toBe('effectful');
  });
});

describe('certaintyFor', () => {
  it('reports a query interrupted by connection loss as simply failed', () => {
    expect(certaintyFor('listModels', 'connection-lost')).toBe('failed');
    expect(certaintyFor('getStatus', 'write-failed')).toBe('failed');
  });

  it('reports a mutation interrupted by connection loss as unknown', () => {
    expect(certaintyFor('deleteModel', 'connection-lost')).toBe('unknown');
    expect(certaintyFor('startService', 'connection-lost')).toBe('unknown');
  });

  it('reports a mutation whose write rejected as unknown', () => {
    // A resolved write means the bytes reached the pipe; a rejected one does not prove they
    // failed to, so it is not evidence that the child never read them.
    expect(certaintyFor('deleteModel', 'write-failed')).toBe('unknown');
  });

  it('reports anything that was never dispatched as failed, whatever it would have done', () => {
    // This is the one case that proves a negative: the request demonstrably never left.
    for (const cmd of Object.keys(COMMAND_EFFECTS)) {
      expect(certaintyFor(cmd, 'not-dispatched')).toBe('failed');
    }
  });
});

describe('describeOutcome', () => {
  it('says plainly that an unknown outcome may have taken effect', () => {
    const text = describeOutcome('deleteModel', 'unknown');
    expect(text).toContain('cannot tell whether it took effect');
    expect(text).toContain('partly completed');
  });

  it('tells the user to check the variant rather than the alias after a delete', () => {
    // A model staying in the list says nothing about whether its files are still on disk:
    // the list is the catalog, and cached state is a separate flag per variant.
    expect(describeOutcome('deleteModel', 'unknown')).toContain('still downloaded');
  });

  it('gives runtime commands runtime advice', () => {
    expect(describeOutcome('startService', 'unknown')).toContain('Diagnostics');
  });

  it('warns that a WSL change may have affected other programs', () => {
    expect(describeOutcome('wslShutdown', 'unknown')).toContain('outside Flint');
  });

  it('does not promise a rollback when an effectful command fails outright', () => {
    // Deleting several variants removes them one at a time, so an error can follow removals
    // that already succeeded.
    expect(describeOutcome('deleteModel', 'failed')).toContain('was not undone');
  });

  it('says a failed query changed nothing', () => {
    expect(describeOutcome('listModels', 'failed')).toContain('safe to try again');
  });

  it('says a cancelled operation never ran', () => {
    expect(describeOutcome('chatCompletion', 'cancelled')).toContain('did not run');
  });
});

describe('SidecarOperationError', () => {
  it('carries the certainty rather than making callers read the message', () => {
    const err = new SidecarOperationError('deleteModel', 'unknown');
    expect(err.certainty).toBe('unknown');
    expect(err.cmd).toBe('deleteModel');
    expect(err).toBeInstanceOf(Error);
  });

  it('appends the underlying detail to the explanation', () => {
    const err = new SidecarOperationError('listModels', 'failed', 'pipe closed');
    expect(err.message).toContain('pipe closed');
    expect(err.message).toContain('safe to try again');
  });

  it('still has a message when there is no detail', () => {
    expect(new SidecarOperationError('listModels', 'failed').message.length).toBeGreaterThan(0);
  });

  it('identifies only genuinely uncertain outcomes', () => {
    expect(isUncertainOutcome(new SidecarOperationError('deleteModel', 'unknown'))).toBe(true);
    expect(isUncertainOutcome(new SidecarOperationError('deleteModel', 'failed'))).toBe(false);
    expect(isUncertainOutcome(new Error('deleteModel failed'))).toBe(false);
    expect(isUncertainOutcome(undefined)).toBe(false);
  });
});

describe('classification table', () => {
  it('uses only the two known effects', () => {
    const allowed: OperationEffect[] = ['query', 'effectful'];
    for (const [cmd, effect] of Object.entries(COMMAND_EFFECTS)) {
      expect(allowed, `${cmd} has an unexpected effect`).toContain(effect);
    }
  });
});
