import { describe, expect, it } from 'vitest';
import { KNOWN_COMMANDS } from './ipc-contracts';
import { COMMAND_EFFECTS } from './operation-outcome';
import { deadlineForCommand, IPC_COMMAND_DEADLINES_MS } from './ipc-deadlines';

describe('IPC command deadlines', () => {
  it('classifies every known command explicitly', () => {
    expect(Object.keys(IPC_COMMAND_DEADLINES_MS).sort()).toEqual([...KNOWN_COMMANDS].sort());
  });

  it('bounds only read-only commands', () => {
    for (const [cmd, deadline] of Object.entries(IPC_COMMAND_DEADLINES_MS)) {
      if (deadline !== null) {
        expect(COMMAND_EFFECTS[cmd as keyof typeof COMMAND_EFFECTS]).toBe('query');
        expect(Number.isFinite(deadline)).toBe(true);
        expect(deadline).toBeGreaterThan(0);
      }
    }
  });

  it('leaves model execution and mutations unbounded', () => {
    expect(deadlineForCommand('chatCompletion')).toBeNull();
    expect(deadlineForCommand('transcribeAudio')).toBeNull();
    expect(deadlineForCommand('download')).toBeNull();
    expect(deadlineForCommand('load')).toBeNull();
    expect(deadlineForCommand('startService')).toBeNull();
  });

  it('leaves headroom beyond nested control-plane probe budgets', () => {
    expect(deadlineForCommand('poolStatus')).toBeGreaterThan(10_000);
    expect(deadlineForCommand('wslStatus')).toBeGreaterThan(15_000);
  });

  it('treats an unknown future command as unbounded', () => {
    expect(deadlineForCommand('addedByANewerBuild')).toBeNull();
  });
});
