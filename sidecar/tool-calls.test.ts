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

  it('rejects duplicate IDs within a call list while scoping uniqueness to each choice', () => {
    const repeatedId = call('{}', { id: 'call-repeated' });
    expect(() => sanitizeToolCalls([repeatedId, call('{}', { id: 'call-repeated' })]))
      .toThrow(/duplicate call IDs/i);

    expect(() => validateCompletedChatResponse({
      choices: [
        { finish_reason: 'stop', message: { content: 'safe' } },
        { finish_reason: 'tool_calls', message: { tool_calls: [repeatedId, call('{}', { id: 'call-repeated' })] } },
      ],
    })).toThrow(/Invalid completed assistant tool_calls/i);

    expect(() => validateCompletedChatResponse({
      choices: [
        { finish_reason: 'tool_calls', message: { tool_calls: [repeatedId] } },
        { finish_reason: 'tool_calls', message: { tool_calls: [repeatedId] } },
      ],
    })).not.toThrow();
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

  it('validates cumulative snapshot argument bytes incrementally', () => {
    const measured: string[] = [];
    const target = createToolCallAccumulator({
      utf8ByteLength: (value: string) => {
        measured.push(value);
        return new TextEncoder().encode(value).byteLength;
      },
    });
    for (let length = 1; length <= 4096; length += 1) {
      mergeStreamingToolCalls(target, { snapshot: [call('a'.repeat(length))] });
    }
    expect(finalizeStreamingToolCalls(target)[0].function.arguments).toBe('a'.repeat(4096));
    expect(measured).toHaveLength(4096);
    expect(measured.every((value) => value === 'a')).toBe(true);
  });

  it('counts cumulative snapshot UTF-8 bytes across split surrogate pairs', () => {
    const measured: string[] = [];
    const target = createToolCallAccumulator({
      utf8ByteLength: (value: string) => {
        measured.push(value);
        return new TextEncoder().encode(value).byteLength;
      },
    });
    const prefix = 'a'.repeat(MAX_TOOL_CALL_ARGUMENT_BYTES - 4);
    mergeStreamingToolCalls(target, { snapshot: [call(`${prefix}\uD83D`)] });
    mergeStreamingToolCalls(target, { snapshot: [call(`${prefix}😀`)] });
    expect(target.failure).toBeNull();
    expect(new TextEncoder().encode(finalizeStreamingToolCalls(target)[0].function.arguments))
      .toHaveLength(MAX_TOOL_CALL_ARGUMENT_BYTES);
    expect(measured).toEqual([`${prefix}\uD83D`, '\uDE00']);

    mergeStreamingToolCalls(target, { snapshot: [call(`${prefix}😀x`)] });
    expect(target.failure).toBeInstanceOf(Error);
    expect(target.snapshots.get('call-1').function.arguments).toBe(`${prefix}😀`);
  });

  it('bounds discarded snapshots and commits multi-call snapshots atomically', () => {
    const retained = createToolCallAccumulator();
    mergeStreamingToolCalls(retained, { snapshot: [call('{"a":1,"b":2}')] });
    mergeStreamingToolCalls(retained, {
      snapshot: [call(`{${' '.repeat(MAX_TOOL_CALL_ARGUMENT_BYTES)}"a":1}`)],
    });
    expect(retained.failure).toBeInstanceOf(Error);
    expect(retained.snapshots.get('call-1').function.arguments).toBe('{"a":1,"b":2}');

    const atomic = createToolCallAccumulator();
    mergeStreamingToolCalls(atomic, {
      snapshot: [
        call('{}'),
        call('{}', { id: 'call-2', function: { name: '', arguments: '{}' } }),
      ],
    });
    expect(atomic.failure).toBeInstanceOf(Error);
    expect(atomic.snapshots.size).toBe(0);
    expect(atomic.snapshotOrder).toEqual([]);
  });

  it('does not remeasure repeated or rolled-back cumulative snapshots', () => {
    const measured: string[] = [];
    const target = createToolCallAccumulator({
      utf8ByteLength: (value: string) => {
        measured.push(value);
        return new TextEncoder().encode(value).byteLength;
      },
    });
    mergeStreamingToolCalls(target, { snapshot: [call('{"a":1,"b":2}')] });
    mergeStreamingToolCalls(target, { snapshot: [call('{"a":1,"b":2}')] });
    mergeStreamingToolCalls(target, { snapshot: [call('{"a":1}')] });
    expect(finalizeStreamingToolCalls(target)).toEqual([call('{"a":1,"b":2}')]);
    expect(measured).toEqual(['{"a":1,"b":2}', '{"a":1}']);
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

  it('defers a conflicting exact-prefix content match until a later ID extension and snapshot resolve it', () => {
    for (const arrival of ['snapshot-first', 'identity-first', 'same-chunk']) {
      const target = createToolCallAccumulator();
      mergeStreamingToolCalls(target, {
        snapshot: [call('{"a":1}', { id: 'call-a', function: { name: 'lookup', arguments: '{"a":1}' } })],
      });
      mergeStreamingToolCalls(target, {
        deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"b":2}' } }],
      });
      expect(target.failure).toBeNull();

      const extendedId = { deltas: [{ index: 0, id: 'b' }] };
      const matchingSnapshot = {
        snapshot: [call('{"b":2}', { id: 'call-ab', function: { name: 'lookup', arguments: '{"b":2}' } })],
      };
      if (arrival === 'snapshot-first') {
        mergeStreamingToolCalls(target, matchingSnapshot);
        mergeStreamingToolCalls(target, extendedId);
      } else if (arrival === 'identity-first') {
        mergeStreamingToolCalls(target, extendedId);
        mergeStreamingToolCalls(target, matchingSnapshot);
      } else {
        mergeStreamingToolCalls(target, { ...extendedId, ...matchingSnapshot });
      }

      expect(target.failure).toBeNull();
      expect(finalizeStreamingToolCalls(target)).toEqual([
        call('{"b":2}', { id: 'call-ab', function: { name: 'lookup', arguments: '{"b":2}' } }),
        call('{"a":1}', { id: 'call-a', function: { name: 'lookup', arguments: '{"a":1}' } }),
      ]);
    }
  });

  it('defers an unmatched delta identity until its snapshot arrives in a later chunk', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"a":1}', { id: 'call-a', function: { name: 'first', arguments: '{"a":1}' } })],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-b', type: 'function', function: { name: 'second', arguments: '{"b":2}' } }],
    });
    expect(target.failure).toBeNull();

    mergeStreamingToolCalls(target, {
      snapshot: [call('{"b":2}', { id: 'call-b', function: { name: 'second', arguments: '{"b":2}' } })],
    });
    expect(target.failure).toBeNull();
    expect(finalizeStreamingToolCalls(target)).toEqual([
      call('{"b":2}', { id: 'call-b', function: { name: 'second', arguments: '{"b":2}' } }),
      call('{"a":1}', { id: 'call-a', function: { name: 'first', arguments: '{"a":1}' } }),
    ]);
  });

  it('rejects duplicate IDs in a streaming snapshot immediately', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{}', { id: 'call-a' }), call('{}', { id: 'call-a' })],
    });
    expect(target.failure).toBeInstanceOf(Error);
    expect(target.failure?.message).toMatch(/duplicate call IDs/i);
    expect(target.failure?.message).not.toContain('call-a');
  });

  it('does not treat an exact delta id match as ambiguous merely because another snapshot id is a superstring', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      snapshot: [
        call('{}', { id: 'call-a', function: { name: 'lookup', arguments: '{}' } }),
        call('{}', { id: 'call-ab', function: { name: 'lookup', arguments: '{}' } }),
      ],
    });
    expect(target.failure).toBeNull();
    expect(finalizeStreamingToolCalls(target)[0].id).toBe('call-a');
  });

  it('resolves a transient prefix collision between two deltas once more of each identity streams in', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [
        call('{}', { id: 'call-a', function: { name: 'lookup', arguments: '{}' } }),
        call('{}', { id: 'call-b', function: { name: 'lookup', arguments: '{}' } }),
      ],
    });
    // Both deltas currently match the single snapshot 'call-a' (a prefix collision), which
    // must not be treated as a hard error mid-stream since later fragments can disambiguate.
    mergeStreamingToolCalls(target, {
      deltas: [
        { index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      deltas: [
        { index: 1, id: 'call-b', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    });
    expect(target.failure).toBeNull();
    expect(finalizeStreamingToolCalls(target).map((c) => c.id).sort()).toEqual(['call-a', 'call-b']);
  });

  it('reconciles a mixed delta/snapshot pair without quadratic-time re-validation on every fragment', () => {
    const bigObj = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`k${i}`, 1]));
    const bigArguments = JSON.stringify(bigObj);
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call(bigArguments, { id: 'call-a', function: { name: 'lookup', arguments: bigArguments } })],
    });
    const start = Date.now();
    for (let i = 0; i < bigArguments.length; i += 4) {
      mergeStreamingToolCalls(target, {
        deltas: [{
          index: 0,
          id: i === 0 ? 'call-a' : undefined,
          type: i === 0 ? 'function' : undefined,
          function: {
            name: i === 0 ? 'lookup' : undefined,
            arguments: bigArguments.slice(i, i + 4),
          },
        }],
      });
      expect(target.failure).toBeNull();
    }
    // Not a strict big-O assertion (timing is inherently noisy), but the un-fixed
    // behavior (re-running JSON.parse-based validation against the full accumulated
    // string on every fragment) took multiple seconds for an input this size; a
    // generous ceiling here still catches a regression back to that behavior.
    expect(Date.now() - start).toBeLessThan(2000);
    expect(finalizeStreamingToolCalls(target)[0].function.arguments).toBe(bigArguments);
  });

  it('reconciles a delta extending a snapshot even when an earlier, differently-shaped delta already exists for that call', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"a":1}' } }],
    });
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"a":1,"b":2}', { id: 'call-a', function: { name: 'lookup', arguments: '{"a":1,"b":2}' } })],
    });
    expect(target.failure).toBeNull();
    expect(finalizeStreamingToolCalls(target)[0].function.arguments).toBe('{"a":1,"b":2}');
  });

  it('recognizes a snapshot extension that only adds a new field alongside an unchanged array value', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"items":[1]}', { id: 'call-a', function: { name: 'lookup', arguments: '{"items":[1]}' } })],
    });
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"items":[1],"b":2}', { id: 'call-a', function: { name: 'lookup', arguments: '{"items":[1],"b":2}' } })],
    });
    expect(target.failure).toBeNull();
    expect(finalizeStreamingToolCalls(target)[0].function.arguments).toBe('{"items":[1],"b":2}');
  });

  it('does not eagerly reject an exact-looking id match while the delta identity is still growing', () => {
    // A follow-up adversarial pass found that preferring an exact id match too early
    // (before the delta's id/name have fully arrived) could validate the delta's
    // arguments against the wrong snapshot and fail a stream that later disambiguates
    // correctly, since a currently-exact id can still grow into a different snapshot's id.
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [
        call('{"a":1}', { id: 'call-a', function: { name: 'lookup_a', arguments: '{"a":1}' } }),
        call('{"b":2}', { id: 'call-ab', function: { name: 'lookup_b', arguments: '{"b":2}' } }),
      ],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup_', arguments: '{"b":2}' } }],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'b', function: { name: 'b' } }],
    });
    expect(target.failure).toBeNull();
    const calls = finalizeStreamingToolCalls(target);
    expect(calls.map((c) => c.id).sort()).toEqual(['call-a', 'call-ab']);
  });

  it('does not treat a currently-unmatched delta as a complete-snapshot conflict while a contested snapshot remains unresolved', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [
        call('{}', { id: 'call-a', function: { name: 'lookup_a', arguments: '{}' } }),
        call('{}', { id: 'call-ab', function: { name: 'lookup_b', arguments: '{}' } }),
      ],
    });
    mergeStreamingToolCalls(target, {
      deltas: [
        { index: 0, id: 'call-a', type: 'function', function: { name: 'lookup_', arguments: '{}' } },
        { index: 1, id: 'call-c', type: 'function', function: { name: 'third', arguments: '{}' } },
      ],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{}', { id: 'call-c', function: { name: 'third', arguments: '{}' } })],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, { deltas: [{ index: 0, function: { name: 'a' } }] });
    expect(target.failure).toBeNull();
    const calls = finalizeStreamingToolCalls(target);
    expect(calls.map((c) => c.id).sort()).toEqual(['call-a', 'call-ab', 'call-c']);
  });

  it('does not validate the first of two contending deltas against a snapshot neither may end up owning', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"b":2}', { id: 'call-ab', function: { name: 'lookup', arguments: '{"b":2}' } })],
    });
    // Both deltas currently prefix-match the single snapshot 'call-ab'; the first one's
    // (genuinely different) arguments must not be validated against it before the
    // collision is recognized, since delta 0 may turn out to own a different snapshot.
    mergeStreamingToolCalls(target, {
      deltas: [
        { index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"c":3}' } },
        { index: 1, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"b":2}' } },
      ],
    });
    expect(target.failure).toBeNull();
  });

  it('does not prematurely validate a single sole-current-match delta whose id can still grow away from it, across separate chunks', () => {
    // A follow-up pass found that being the *only* current claimant is not enough to
    // eagerly validate content: a delta whose id is a strict prefix of the sole
    // candidate snapshot's id can still grow (on a later, separate chunk) into an id
    // that no longer matches that snapshot at all, so validating against it eagerly
    // may reject a call that ultimately belongs to a different snapshot entirely.
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"b":2}', { id: 'call-ab', function: { name: 'lookup', arguments: '{"b":2}' } })],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"c":3}' } }],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 1, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"b":2}' } }],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"c":3}', { id: 'call-ac', function: { name: 'lookup', arguments: '{"c":3}' } })],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, { deltas: [{ index: 0, id: 'c' }] });
    mergeStreamingToolCalls(target, { deltas: [{ index: 1, id: 'b' }] });
    expect(target.failure).toBeNull();
    expect(finalizeStreamingToolCalls(target).map((c) => c.id).sort()).toEqual(['call-ab', 'call-ac']);
  });

  it('keeps a failed finalize deterministic instead of caching a stale, partially-updated argument state', () => {
    // A follow-up pass found that `reconcileArgumentsWithCache` could commit part of its
    // next cache state (the new `incoming` reference) before the reconciliation it was
    // guarding actually succeeded, so a thrown conflict left `currentRef`/`result` stale;
    // calling finalize a second time with the identical pair could then incorrectly
    // return the earlier (unrelated) cached success instead of re-throwing.
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"a":1}', { id: 'call-ab', function: { name: 'lookup', arguments: '{"a":1}' } })],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"a":1}' } }],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"b":2}', { id: 'call-a', function: { name: 'lookup', arguments: '{"b":2}' } })],
    });
    expect(target.failure).toBeNull();
    expect(() => finalizeStreamingToolCalls(target)).toThrow(/conflicts/i);
    expect(() => finalizeStreamingToolCalls(target)).toThrow(/conflicts/i);
  });

  it('does not eagerly validate a name-only match while the deciding id has not arrived yet', () => {
    // A follow-up pass found that a missing `delta.id` satisfied the eager "exact match"
    // check by vacuous truth (`undefined` treated as "no constraint"), so a delta that
    // has only streamed its function name so far could be validated against whichever
    // snapshot currently shares that name — even though its id, once it arrives, may
    // identify a completely different snapshot. Only a *present and equal* id may permit
    // eager validation; name equality alone must always wait for `final`.
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"a":1}', { id: 'call-a', function: { name: 'lookup', arguments: '{"a":1}' } })],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, type: 'function', function: { name: 'lookup', arguments: '{"b":2}' } }],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      snapshot: [
        call('{"a":1}', { id: 'call-a', function: { name: 'lookup', arguments: '{"a":1}' } }),
        call('{"b":2}', { id: 'call-b', function: { name: 'lookup', arguments: '{"b":2}' } }),
      ],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, { deltas: [{ index: 0, id: 'call-b' }] });
    expect(target.failure).toBeNull();
    expect(finalizeStreamingToolCalls(target).map((c) => c.id).sort()).toEqual(['call-a', 'call-b']);
  });

  it('defers an unparseable in-progress argument fragment instead of treating it as a permanent conflict', () => {
    // A follow-up pass found that a syntactically-incomplete argument fragment (still
    // missing a closing brace) fails both the structural JSON-subset check and the
    // textual-prefix fallback identically to a genuine conflict, even though completing
    // the fragment can still make it a valid subset of the snapshot. Mid-stream, this
    // must be deferred rather than latched as a permanent failure.
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('{"a":{"x":1}}', { id: 'call-a', function: { name: 'lookup', arguments: '{"a":{"x":1}}' } })],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"a":{}' } }],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, function: { arguments: '}' } }],
    });
    expect(target.failure).toBeNull();
    expect(finalizeStreamingToolCalls(target)).toEqual([
      { id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"a":{"x":1}}' } },
    ]);
  });

  it('defers a still-growable bare numeric argument fragment instead of a permanent textual mismatch', () => {
    // A follow-up pass found that a successfully-parsed JSON *number* fragment (unlike
    // objects/arrays/strings, which are closed by a delimiter) is not necessarily
    // finished growing — '1' parses today but could still become '1e-1' on a later
    // fragment, which is numerically (and thus JSON-subset) equal to a snapshot's
    // '0.1'. Treating "parses successfully" as "complete" for a bare number rejected
    // this case via the textual-prefix fallback before the exponent arrived.
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('0.1', { id: 'call-a', function: { name: 'lookup', arguments: '0.1' } })],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '1' } }],
    });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, function: { arguments: 'e-1' } }],
    });
    expect(target.failure).toBeNull();
    expect(finalizeStreamingToolCalls(target)).toEqual([
      { id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '0.1' } },
    ]);
  });

  it('still rejects a genuinely conflicting bare numeric argument once the stream finalizes', () => {
    // Deferring incomplete numeric fragments must not weaken the final, strict check:
    // a delta that completes to a number genuinely different from the snapshot's
    // number must still fail at finalize.
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call('0.1', { id: 'call-a', function: { name: 'lookup', arguments: '0.1' } })],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '2' } }],
    });
    expect(target.failure).toBeNull();
    expect(() => finalizeStreamingToolCalls(target)).toThrow(/conflicts/i);
  });

  it('does not overflow the call stack comparing deeply nested but valid array extensions', () => {
    const nested = '['.repeat(5000) + '0' + ']'.repeat(5000);
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call(`{"items":${nested}}`, { id: 'call-a', function: { name: 'lookup', arguments: `{"items":${nested}}` } })],
    });
    mergeStreamingToolCalls(target, {
      snapshot: [call(`{"items":${nested},"b":2}`, { id: 'call-a', function: { name: 'lookup', arguments: `{"items":${nested},"b":2}` } })],
    });
    expect(target.failure).toBeNull();
  });

  it('does not repeat argument reconciliation work for an unchanged call while unrelated calls stream', () => {
    const bigObj = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, 1]));
    const bigArguments = JSON.stringify(bigObj);
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, {
      snapshot: [call(bigArguments, { id: 'call-a', function: { name: 'lookup', arguments: bigArguments } })],
    });
    mergeStreamingToolCalls(target, {
      deltas: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"k0":1}' } }],
    });
    expect(target.failure).toBeNull();
    const start = Date.now();
    for (let i = 0; i < 5000; i += 1) {
      mergeStreamingToolCalls(target, {
        deltas: [{
          index: 1,
          id: i === 0 ? 'noop' : undefined,
          function: { name: i === 0 ? 'noop' : undefined },
        }],
      });
    }
    expect(Date.now() - start).toBeLessThan(1000);
    expect(target.failure).toBeNull();
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
    for (const build of conflicts) {
      const target = build();
      expect(target.failure).toBeNull();
      expect(() => finalizeStreamingToolCalls(target)).toThrow(/arguments|identity conflicts/i);
    }
  });

  it('rejects contradictory cumulative snapshots as soon as the contradiction arrives', () => {
    const target = createToolCallAccumulator();
    mergeStreamingToolCalls(target, { snapshot: [call('{"a":1}')] });
    expect(target.failure).toBeNull();
    mergeStreamingToolCalls(target, { snapshot: [call('{"b":2}')] });
    expect(target.failure).toBeInstanceOf(Error);
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
