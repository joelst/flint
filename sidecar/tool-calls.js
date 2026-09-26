export const MAX_TOOL_CALLS = 64;
export const MAX_TOOL_CALL_ID_LENGTH = 256;
export const MAX_TOOL_CALL_NAME_LENGTH = 128;
// Applies independently to each function.arguments string in inbound history,
// completed responses, full streaming snapshots, and incremental deltas.
export const MAX_TOOL_CALL_ARGUMENT_BYTES = 64 * 1024;

const utf8Encoder = new TextEncoder();

function isPlainObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function utf8ByteLength (value) {
  return utf8Encoder.encode(value).byteLength;
}

export function sanitizeToolCalls (toolCalls, field = 'assistant.tool_calls') {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0 || toolCalls.length > MAX_TOOL_CALLS) {
    throw new Error(`${field} must contain 1 to ${MAX_TOOL_CALLS} calls`);
  }
  return toolCalls.map((toolCall, index) => {
    const callField = `${field}[${index}]`;
    if (!isPlainObject(toolCall)
      || typeof toolCall.id !== 'string'
      || !toolCall.id.trim()
      || toolCall.id.length > MAX_TOOL_CALL_ID_LENGTH) {
      throw new Error(`${callField}.id must be a non-empty string of at most ${MAX_TOOL_CALL_ID_LENGTH} characters`);
    }
    if (toolCall.type !== 'function') {
      throw new Error(`${callField}.type must be "function"`);
    }
    if (!isPlainObject(toolCall.function)
      || typeof toolCall.function.name !== 'string'
      || !toolCall.function.name.trim()
      || toolCall.function.name.length > MAX_TOOL_CALL_NAME_LENGTH) {
      throw new Error(`${callField}.function.name must be a non-empty string of at most ${MAX_TOOL_CALL_NAME_LENGTH} characters`);
    }
    if (typeof toolCall.function.arguments !== 'string') {
      throw new Error(`${callField}.function.arguments must be a string`);
    }
    if (utf8ByteLength(toolCall.function.arguments) > MAX_TOOL_CALL_ARGUMENT_BYTES) {
      throw new Error(`${callField}.function.arguments must be at most ${MAX_TOOL_CALL_ARGUMENT_BYTES} UTF-8 bytes (64 KiB)`);
    }
    return {
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    };
  });
}

export function validateCompletedChatResponse (response) {
  if (!isPlainObject(response) || !Array.isArray(response.choices)) return response;
  return {
    ...response,
    choices: response.choices.map((choice, choiceIndex) => {
      if (!isPlainObject(choice)) return choice;
      const message = isPlainObject(choice.message) ? choice.message : null;
      let toolCalls;
      if (message?.tool_calls !== undefined) {
        try {
          toolCalls = sanitizeToolCalls(
            message.tool_calls,
            `choices[${choiceIndex}].message.tool_calls`,
          );
        } catch (error) {
          throw new Error(
            `Invalid completed assistant tool_calls: ${error?.message || error}`,
            { cause: error },
          );
        }
      }
      if (choice.finish_reason === 'tool_calls' && !toolCalls?.length) {
        throw new Error(
          `Invalid completed assistant tool_calls: choices[${choiceIndex}] finished with tool_calls without valid nonempty calls`,
        );
      }
      if (!message || toolCalls === undefined) return choice;
      return {
        ...choice,
        message: {
          ...message,
          tool_calls: toolCalls,
        },
      };
    }),
  };
}

export function createToolCallAccumulator ({ utf8ByteLength: measureUtf8 = utf8ByteLength } = {}) {
  return {
    calls: new Map(),
    snapshots: new Map(),
    snapshotOrder: [],
    nextIndex: 0,
    failure: null,
    measureUtf8,
  };
}

function appendLimitedString (current, fragment, field, maxLength) {
  if (fragment === undefined) return current;
  if (typeof fragment !== 'string') throw new Error(`Streamed tool-call ${field} must be a string`);
  const currentLength = typeof current === 'string' ? current.length : 0;
  if (fragment.length > maxLength - currentLength) {
    throw new Error(`Streamed tool-call ${field} must be at most ${maxLength} characters`);
  }
  return typeof current === 'string' ? current + fragment : fragment;
}

function appendArgumentFragment (target, current, fragment, byteState) {
  if (fragment === undefined) return current;
  if (typeof fragment !== 'string') {
    throw new Error('Streamed tool-call function.arguments must be a string');
  }
  const existing = typeof current === 'string' ? current : '';
  let addedBytes = target.measureUtf8(fragment);
  if (byteState.trailingHighSurrogate
    && fragment.length > 0
    && /[\uDC00-\uDFFF]/.test(fragment[0])) {
    addedBytes -= 2;
  }
  const nextBytes = byteState.bytes + addedBytes;
  if (nextBytes > MAX_TOOL_CALL_ARGUMENT_BYTES) {
    throw new Error(`Streamed tool-call function.arguments must be at most ${MAX_TOOL_CALL_ARGUMENT_BYTES} UTF-8 bytes (64 KiB)`);
  }
  byteState.bytes = nextBytes;
  if (fragment.length > 0) {
    byteState.trailingHighSurrogate = /[\uD800-\uDBFF]/.test(fragment.at(-1));
  }
  return existing + fragment;
}

function compatibleValue (current, incoming, field, { maxLength, maxBytes } = {}) {
  if (typeof current !== 'string' || typeof incoming !== 'string') {
    throw new Error(`Streamed tool-call ${field} must be a string`);
  }
  if (maxLength !== undefined && incoming.length > maxLength) {
    throw new Error(`Streamed tool-call ${field} must be at most ${maxLength} characters`);
  }
  if (maxBytes !== undefined && utf8ByteLength(incoming) > maxBytes) {
    throw new Error(`Streamed tool-call ${field} must be at most ${maxBytes} UTF-8 bytes (64 KiB)`);
  }
  if (current === incoming || incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  throw new Error(`Streamed tool-call ${field} conflicts with an earlier value`);
}

function isJsonExtension (current, incoming) {
  let currentValue;
  let incomingValue;
  try {
    currentValue = JSON.parse(current);
    incomingValue = JSON.parse(incoming);
  } catch {
    return false;
  }
  const pending = [[currentValue, incomingValue]];
  while (pending.length > 0) {
    const [subset, value] = pending.pop();
    if (Object.is(subset, value)) continue;
    if (!isPlainObject(subset) || !isPlainObject(value)) return false;
    for (const [key, child] of Object.entries(subset)) {
      if (!Object.hasOwn(value, key)) return false;
      pending.push([child, value[key]]);
    }
  }
  return true;
}

function mergeSnapshotCall (current, snapshot) {
  if (!current) return snapshot;
  if (current.id !== snapshot.id || current.type !== snapshot.type || current.function.name !== snapshot.function.name) {
    throw new Error('Streamed tool-call snapshot identity conflicts with an earlier snapshot');
  }
  return {
    id: snapshot.id,
    type: snapshot.type,
    function: {
      name: snapshot.function.name,
      arguments: isJsonExtension(current.function.arguments, snapshot.function.arguments)
        ? snapshot.function.arguments
        : compatibleValue(
            current.function.arguments,
            snapshot.function.arguments,
            'function.arguments',
            { maxBytes: MAX_TOOL_CALL_ARGUMENT_BYTES },
          ),
    },
  };
}

function identityCompatible (delta, snapshot) {
  const deltaId = delta?.id;
  const deltaName = delta?.function?.name;
  if (deltaId !== undefined
    && !(snapshot.id === deltaId || snapshot.id.startsWith(deltaId) || deltaId.startsWith(snapshot.id))) {
    return false;
  }
  if (deltaName !== undefined
    && !(snapshot.function.name === deltaName
      || snapshot.function.name.startsWith(deltaName)
      || deltaName.startsWith(snapshot.function.name))) {
    return false;
  }
  return deltaId !== undefined || deltaName !== undefined;
}

function matchingSnapshots (target, delta) {
  return target.snapshotOrder
    .map((id) => target.snapshots.get(id))
    .filter((snapshot) => identityCompatible(delta, snapshot));
}

function mergeDeltaSnapshot (delta, snapshot) {
  if (delta.type !== undefined && delta.type !== snapshot.type) {
    throw new Error('Streamed tool-call type conflicts with a complete snapshot');
  }
  return {
    id: delta.id === undefined
      ? snapshot.id
      : compatibleValue(delta.id, snapshot.id, 'id', { maxLength: MAX_TOOL_CALL_ID_LENGTH }),
    type: delta.type ?? snapshot.type,
    function: {
      name: delta.function?.name === undefined
        ? snapshot.function.name
        : compatibleValue(
            delta.function.name,
            snapshot.function.name,
            'function.name',
            { maxLength: MAX_TOOL_CALL_NAME_LENGTH },
          ),
      arguments: delta.function?.arguments === undefined
        ? snapshot.function.arguments
        : compatibleValue(
            delta.function.arguments,
            snapshot.function.arguments,
            'function.arguments',
            { maxBytes: MAX_TOOL_CALL_ARGUMENT_BYTES },
          ),
    },
  };
}

function assertReconciliationIsUnambiguous (target, { final = false } = {}) {
  if (target.snapshots.size === 0 || target.calls.size === 0) return;
  const matchedSnapshotIds = new Set();
  let unmatchedDeltas = 0;
  for (const delta of target.calls.values()) {
    const candidates = matchingSnapshots(target, delta);
    if (candidates.length > 1) {
      if (final) throw new Error('Streamed tool-call identity is ambiguous');
      continue;
    }
    if (candidates.length === 1) {
      const id = candidates[0].id;
      if (matchedSnapshotIds.has(id)) {
        throw new Error('Streamed tool-call identity conflicts with another call');
      }
      mergeDeltaSnapshot(delta, candidates[0]);
      matchedSnapshotIds.add(id);
    } else if (delta.id !== undefined && delta.function?.name !== undefined) {
      unmatchedDeltas += 1;
    }
  }
  if (unmatchedDeltas > 0
    && target.calls.size === target.snapshots.size
    && matchedSnapshotIds.size + unmatchedDeltas === target.calls.size) {
    throw new Error('Streamed tool-call identity conflicts with a complete snapshot');
  }
}

function mergeDeltas (target, deltas) {
  if (deltas === undefined) return;
  if (!Array.isArray(deltas)) throw new Error('Streamed tool_calls must be an array');
  for (const delta of deltas) {
    if (!isPlainObject(delta)) throw new Error('Streamed tool-call delta must be an object');
    let index;
    if (delta.index === undefined) {
      if (target.nextIndex >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Invalid streamed tool-call index');
      }
      index = target.nextIndex;
      target.nextIndex += 1;
    } else {
      index = delta.index;
      if (!Number.isSafeInteger(index) || index < 0 || index >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Invalid streamed tool-call index');
      }
      target.nextIndex = Math.max(target.nextIndex, index + 1);
    }
    const existing = target.calls.get(index);
    if (!existing && target.calls.size >= MAX_TOOL_CALLS) {
      throw new Error(`Streamed tool_calls cannot contain more than ${MAX_TOOL_CALLS} distinct call indexes`);
    }
    if (delta.type !== undefined && delta.type !== 'function') {
      throw new Error('Streamed tool-call type must be "function"');
    }
    if (existing?.type !== undefined && delta.type !== undefined && existing.type !== delta.type) {
      throw new Error('Streamed tool-call type fragments must not conflict');
    }
    if (delta.function !== undefined && !isPlainObject(delta.function)) {
      throw new Error('Streamed tool-call function must be an object');
    }
    const currentFunction = existing?.function || {};
    const nextFunction = delta.function || {};
    const argumentByteState = existing?.argumentByteState || {
      bytes: 0,
      trailingHighSurrogate: false,
    };
    const next = {
      ...(existing?.id !== undefined || delta.id !== undefined
        ? {
            id: appendLimitedString(
              existing?.id,
              delta.id,
              'id',
              MAX_TOOL_CALL_ID_LENGTH,
            ),
          }
        : {}),
      ...(existing?.type !== undefined || delta.type !== undefined
        ? { type: existing?.type ?? delta.type }
        : {}),
      ...(existing?.function !== undefined || delta.function !== undefined
        ? {
            function: {
              ...(currentFunction.name !== undefined || nextFunction.name !== undefined
                ? {
                    name: appendLimitedString(
                      currentFunction.name,
                      nextFunction.name,
                      'function.name',
                      MAX_TOOL_CALL_NAME_LENGTH,
                    ),
                  }
                : {}),
              ...(currentFunction.arguments !== undefined || nextFunction.arguments !== undefined
                ? {
                    arguments: appendArgumentFragment(
                      target,
                      currentFunction.arguments,
                      nextFunction.arguments,
                      argumentByteState,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      argumentByteState,
    };
    target.calls.set(index, next);
  }
}

function mergeSnapshot (target, snapshot) {
  if (snapshot === undefined) return;
  const validated = sanitizeToolCalls(snapshot, 'streamed assistant tool_calls');
  const ids = new Set();
  for (const call of validated) {
    if (ids.has(call.id)) {
      throw new Error('Streamed tool-call snapshot contains conflicting identities');
    }
    ids.add(call.id);
    if (!target.snapshots.has(call.id)) {
      if (target.snapshots.size >= MAX_TOOL_CALLS) {
        throw new Error(`Streamed tool_calls cannot contain more than ${MAX_TOOL_CALLS} snapshot calls`);
      }
      target.snapshotOrder.push(call.id);
    }
    target.snapshots.set(call.id, mergeSnapshotCall(target.snapshots.get(call.id), call));
  }
}

export function mergeStreamingToolCalls (target, { deltas, snapshot } = {}) {
  if (target.failure) return target;
  try {
    mergeDeltas(target, deltas);
    mergeSnapshot(target, snapshot);
    assertReconciliationIsUnambiguous(target);
  } catch (error) {
    target.failure ??= error instanceof Error ? error : new Error(String(error));
  }
  return target;
}

export function finalizeStreamingToolCalls (target) {
  if (target.failure) throw target.failure;
  assertReconciliationIsUnambiguous(target, { final: true });
  const matchedSnapshotIds = new Set();
  const calls = Array.from(target.calls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, delta]) => {
      const candidates = matchingSnapshots(target, delta);
      if (candidates.length > 1) {
        throw new Error('Streamed tool-call identity is ambiguous');
      }
      if (candidates.length === 0) {
        const { argumentByteState: _argumentByteState, ...call } = delta;
        return call;
      }
      const snapshot = candidates[0];
      if (matchedSnapshotIds.has(snapshot.id)) {
        throw new Error('Streamed tool-call identity conflicts with another call');
      }
      matchedSnapshotIds.add(snapshot.id);
      return mergeDeltaSnapshot(delta, snapshot);
    });
  for (const id of target.snapshotOrder) {
    if (!matchedSnapshotIds.has(id)) calls.push(target.snapshots.get(id));
  }
  if (calls.length > MAX_TOOL_CALLS) {
    throw new Error(`Streamed tool_calls cannot contain more than ${MAX_TOOL_CALLS} calls`);
  }
  const finalIds = new Set();
  for (const call of calls) {
    if (typeof call?.id === 'string' && finalIds.has(call.id)) {
      throw new Error('Streamed tool-call identity conflicts with another call');
    }
    if (typeof call?.id === 'string') finalIds.add(call.id);
  }
  return calls.length ? sanitizeToolCalls(calls, 'streamed assistant tool_calls') : [];
}
