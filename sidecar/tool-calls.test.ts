// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_TOOL_CALL_ARGUMENT_BYTES,
  createToolCallAccumulator,
  finalizeStreamingToolCalls,
  mergeStreamingToolCalls,
  sanitizeToolCalls,
  validateCompletedChatResponse,
} from './tool-calls.js';

const call = (argumentsText = '{}', overrides: Record<string, unknown> = {}) => ({
  id: 'call-1',
  type: 'function',
  function: { name: 'read_status', arguments: argumentsText },
  ...overrides,
});

describe('completed tool-call validation', () => {
  it('validates and allowlists every completed choice', () => {
    const response = {
      choices: [
        { finish_reason: 'tool_calls', message: { tool_calls: [call('{}', { ignored: 'drop' })] } },
        { finish_reason: 'tool_calls', message: { tool_calls: [call('{"two":true}', { id: 'call-2' })] } },
      ],
    };
    const validated = validateCompletedChatResponse(response);
    expect(validated.choices[0].message.tool_calls[0]).toEqual(call());
    expect(validated.choices[1].message.tool_calls[0].id).toBe('call-2');
  });

  it.each([
    ['missing id', { type: 'function', function: { name: 'secret_name', arguments: 'SECRET_ARGS' } }],
    ['wrong type', call('{}', { type: 'other' })],
    ['missing name', { id: 'call-1', type: 'function', function: { arguments: 'SECRET_ARGS' } }],
    ['non-string arguments', call({ secret: true } as any)],
  ])('rejects malformed calls in any choice without echoing payloads: %s', (_label, malformed) => {
    const response = {
      choices: [
        { finish_reason: 'stop', message: { content: 'safe' } },
        { finish_reason: 'tool_calls', message: { tool_calls: [malformed] } },
      ],
    };
    let caught: Error | undefined;
    try {
      validateCompletedChatResponse(response);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).not.toContain('secret_name');
    expect(caught?.message).not.toContain('SECRET_ARGS');
  });

  it('rejects a tool_calls finish reason without valid nonempty calls', () => {
    for (const message of [{}, { tool_calls: [] }, { tool_calls: null }]) {
      expect(() => validateCompletedChatResponse({
        choices: [{ finish_reason: 'tool_calls', message }],
      })).toThrow(/tool.calls/i);
    }
  });

  it('enforces the documented UTF-8 argument byte boundary for completed calls', () => {
    expect(() => sanitizeToolCalls([call('a'.repeat(MAX_TOOL_CALL_ARGUMENT_BYTES))])).not.toThrow();
    expect(() => sanitizeToolCalls([call('a'.repeat(MAX_TOOL_CALL_ARGUMENT_BYTES + 1))])).toThrow(/65536|64 KiB/i);
    expect(() => sanitizeToolCalls([call('😀'.repeat(MAX_TOOL_CALL_ARGUMENT_BYTES / 4))])).not.toThrow();
    expect(() => sanitizeToolCalls([call(`${'😀'.repeat(MAX_TOOL_CALL_ARGUMENT_BYTES / 4)}a`)])).toThrow(/65536|64 KiB/i);
  });
});

describe('streamed tool-call accumulation', () => {
  const delta = (fragment: object) => ({ deltas: [{ index: 0, ...fragment }] });

  it('accepts 65536 bytes but latches before retaining a 65537th byte', () => {
    const exact = createToolCallAccumulator();
    mergeStreamingToolCalls(exact, delta({
      id: 'call-1',
      type: 'function',
      function: { name: 'read_status', arguments: 'a'.repeat(MAX_TOOL_CALL_ARGUMENT_BYTES) },
    }));
    expect(finalizeStreamingToolCalls(exact)[0].function.arguments).toHaveLength(MAX_TOOL_CALL_ARGUMENT_BYTES);

    const overflow = createToolCallAccumulator();
    mergeStreamingToolCalls(overflow, delta({
      id: 'call-1',
      type: 'function',
      function: { name: 'read_status', arguments: 'a'.repeat(MAX_TOOL_CALL_ARGUMENT_BYTES) },
    }));
    mergeStreamingToolCalls(overflow, delta({ function: { arguments: 'SECRET_TAIL' } }));
    expect(overflow.failure).toBeInstanceOf(Error);
    expect(overflow.calls.get(0).function.arguments).toHaveLength(MAX_TOOL_CALL_ARGUMENT_BYTES);
    expect(overflow.failure.message).not.toContain('SECRET_TAIL');
  });

  it('counts multibyte arguments and split surrogate pairs exactly', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, delta({
      id: 'call-1',
      type: 'function',
      function: {
        name: 'read_status',
        arguments: `${'😀'.repeat((MAX_TOOL_CALL_ARGUMENT_BYTES - 4) / 4)}\uD83D`,
      },
    }));
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, delta({ function: { arguments: '\uDE00' } }));
    expect(target.failure).toBeNull();
    expect(new TextEncoder().encode(finalizeStreamingToolCalls(target)[0].function.arguments)).toHaveLength(MAX_TOOL_CALL_ARGUMENT_BYTES);
    mergeStreamingToolCalls(target, delta({ function: { arguments: 'x' } }));
    expect(target.failure).toBeInstanceOf(Error);
  });

  it('encodes only new argument fragments, including empty fragments and split surrogates', () => {
    const measured: string[] = [];
    const target = createToolCallAccumulator({
      utf8ByteLength: (value: string) => {
        measured.push(value);
        return new TextEncoder().encode(value).byteLength;
      },
    });
    mergeStreamingToolCalls(target, delta({
      id: 'call-1',
      type: 'function',
      function: { name: 'read_status', arguments: 'a'.repeat(20_000) },
    }));
    mergeStreamingToolCalls(target, delta({ function: { arguments: '' } }));
    mergeStreamingToolCalls(target, delta({ function: { arguments: '\uD83D' } }));
    mergeStreamingToolCalls(target, delta({ function: { arguments: '\uDE00' } }));
    mergeStreamingToolCalls(target, delta({ function: { arguments: 'b'.repeat(20_000) } }));
    expect(finalizeStreamingToolCalls(target)[0].function.arguments)
      .toBe(`${'a'.repeat(20_000)}😀${'b'.repeat(20_000)}`);
    expect(measured).toEqual(['a'.repeat(20_000), '', '\uD83D', '\uDE00', 'b'.repeat(20_000)]);
    expect(measured.reduce((total, value) => total + value.length, 0)).toBe(40_002);
  });

  it('latches ID and name overflow incrementally without retaining the rejected fragment', () => {
    const idTarget = createToolCallAccumulator();
    mergeStreamingToolCalls(idTarget, delta({
      id: 'i'.repeat(256),
      type: 'function',
      function: { name: 'ok', arguments: '{}' },
    }));
    mergeStreamingToolCalls(idTarget, delta({ id: 'SECRET_ID_TAIL' }));
    expect(idTarget.failure).toBeInstanceOf(Error);
    expect(idTarget.calls.get(0).id).toHaveLength(256);

    const nameTarget = createToolCallAccumulator();
    mergeStreamingToolCalls(nameTarget, delta({
      id: 'call-1',
      type: 'function',
      function: { name: 'n'.repeat(128), arguments: '{}' },
    }));
    mergeStreamingToolCalls(nameTarget, delta({ function: { name: 'SECRET_NAME_TAIL' } }));
    expect(nameTarget.failure).toBeInstanceOf(Error);
    expect(nameTarget.calls.get(0).function.name).toHaveLength(128);
  });

  it('supports message-only and repeated cumulative snapshots without duplicating arguments', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, { snapshot: [call('{"a":1}')] });
    mergeStreamingToolCalls(target, { snapshot: [call('{"a":1}')] });
    mergeStreamingToolCalls(target, { snapshot: [call('{"a":1,"b":2}')] });
    expect(finalizeStreamingToolCalls(target)).toEqual([call('{"a":1,"b":2}')]);
  });

  it('reconciles deltas followed by a full snapshot and both forms in one chunk', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, delta({
      id: 'call-',
      type: 'function',
      function: { name: 'read_', arguments: '{"a":' },
    }));
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: '1', function: { name: 'status', arguments: '1}' } }],
      snapshot: [call('{"a":1}')],
    });
    expect(finalizeStreamingToolCalls(target)).toEqual([call('{"a":1}')]);
  });

  it('reconciles snapshot-first, snapshot-between-deltas, and repeated argument fragments without losing provenance', () => {
    const snapshotFirst = createToolCallAccumulator();
    mergeStreamingToolCalls(snapshotFirst, { snapshot: [call('{"a":1}')] });
    mergeStreamingToolCalls(snapshotFirst, delta({
      id: 'call-',
      type: 'function',
      function: { name: 'read_', arguments: '{"a":' },
    }));
    mergeStreamingToolCalls(snapshotFirst, delta({
      id: '1',
      function: { name: 'status', arguments: '1}' },
    }));
    expect(finalizeStreamingToolCalls(snapshotFirst)).toEqual([call('{"a":1}')]);

    const between = createToolCallAccumulator();
    mergeStreamingToolCalls(between, delta({
      id: 'call-1',
      type: 'function',
      function: { name: 'read_status', arguments: '{"echo":"' },
    }));
    mergeStreamingToolCalls(between, { snapshot: [call('{"echo":"ha')] });
    mergeStreamingToolCalls(between, delta({ function: { arguments: 'ha' } }));
    mergeStreamingToolCalls(between, delta({ function: { arguments: 'ha"}' } }));
    expect(finalizeStreamingToolCalls(between)).toEqual([call('{"echo":"haha"}')]);
  });

  it('reconciles compact snapshots to sparse parallel deltas by identity rather than array offset', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      deltas: [
        { index: 9, id: 'call-b', type: 'function', function: { name: 'second', arguments: '{"b":2}' } },
        { index: 3, id: 'call-a', type: 'function', function: { name: 'first', arguments: '{"a":1}' } },
      ],
    });
    mergeStreamingToolCalls(target, {
      snapshot: [
        call('{"a":1}', { id: 'call-a', function: { name: 'first', arguments: '{"a":1}' } }),
        call('{"b":2}', { id: 'call-b', function: { name: 'second', arguments: '{"b":2}' } }),
      ],
    });
    expect(finalizeStreamingToolCalls(target)).toEqual([
      call('{"a":1}', { id: 'call-a', function: { name: 'first', arguments: '{"a":1}' } }),
      call('{"b":2}', { id: 'call-b', function: { name: 'second', arguments: '{"b":2}' } }),
    ]);
  });

  it('rejects ambiguous snapshot identities without exposing call values', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      deltas: [
        { index: 1, id: 'call-', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
      snapshot: [
        call('{}', { id: 'call-a', function: { name: 'lookup', arguments: '{}' } }),
        call('{}', { id: 'call-b', function: { name: 'lookup', arguments: '{}' } }),
      ],
    });
    expect(() => finalizeStreamingToolCalls(target)).toThrow(/ambiguous/i);
    try {
      finalizeStreamingToolCalls(target);
    } catch (error) {
      expect(String(error)).not.toContain('call-a');
      expect(String(error)).not.toContain('call-b');
      expect(String(error)).not.toContain('lookup');
    }
  });

  it('allows an initially ambiguous fragmented identity to become unambiguous', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [
        call('{}', { id: 'call-a', function: { name: 'lookup_a', arguments: '{}' } }),
        call('{}', { id: 'call-b', function: { name: 'lookup_b', arguments: '{}' } }),
      ],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{
        index: 4,
        id: 'call-',
        type: 'function',
        function: { name: 'lookup_', arguments: '{}' },
      }],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 4, id: 'a', function: { name: 'a' } }],
    });
    expect(finalizeStreamingToolCalls(target)[0].id).toBe('call-a');
  });

  it('rejects duplicate completed identities across distinct sparse indexes', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      deltas: [
        { index: 2, id: 'duplicate', type: 'function', function: { name: 'first', arguments: '{}' } },
        { index: 20, id: 'duplicate', type: 'function', function: { name: 'second', arguments: '{}' } },
      ],
    });
    expect(() => finalizeStreamingToolCalls(target)).toThrow(/identity conflicts/i);
  });

  it('accepts empty delta arrays alongside a valid snapshot', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, { deltas: [], snapshot: [call()] });
    expect(finalizeStreamingToolCalls(target)).toEqual([call()]);
  });

  it('rejects conflicting snapshots and conflicting identities', () => {
    const conflicts = [
      () => {
        const target = createToolCallAccumulator();
        mergeStreamingToolCalls(target, delta({
          id: 'call-1', type: 'function', function: { name: 'read_status', arguments: '{"a":1}' },
        }));
        mergeStreamingToolCalls(target, { snapshot: [call('{"b":2}')] });
        return target;
      },
      () => {
        const target = createToolCallAccumulator();
        mergeStreamingToolCalls(target, delta({
          id: 'call-1', type: 'function', function: { name: 'read_status', arguments: '{}' },
        }));
        mergeStreamingToolCalls(target, { snapshot: [call('{}', { id: 'other' })] });
        return target;
      },
    ];
    for (const build of conflicts) expect(build().failure).toBeInstanceOf(Error);
  });

  it('preserves a latched failure and the 64-call sparse-index cap', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, { deltas: 'SECRET_NOT_ARRAY' as any });
    const failure = target.failure;
    mergeStreamingToolCalls(target, { snapshot: [call()] });
    expect(target.failure).toBe(failure);
    expect(target.calls.size).toBe(0);

    const sparse = createToolCallAccumulator();
    mergeStreamingToolCalls(sparse, {
      deltas: Array.from({ length: 64 }, (_, index) => ({
        index: index * 1_000_000,
        id: `call-${index}`,
        type: 'function',
        function: { name: `tool_${index}`, arguments: '{}' },
      })),
    });
    expect(finalizeStreamingToolCalls(sparse)).toHaveLength(64);
    mergeStreamingToolCalls(sparse, {
      deltas: [{ index: Number.MAX_SAFE_INTEGER - 1, id: 'overflow', type: 'function', function: { name: 'overflow', arguments: '{}' } }],
    });
    expect(sparse.failure).toBeInstanceOf(Error);
  });
});
