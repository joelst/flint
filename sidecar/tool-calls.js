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

export function createToolCallAccumulator () {
  return { calls: new Map(), snapshotOnly: new Set(), nextIndex: 0, failure: null };
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

function appendArgumentFragment (current, fragment) {
  if (fragment === undefined) return current;
  if (typeof fragment !== 'string') {
    throw new Error('Streamed tool-call function.arguments must be a string');
  }
  const existing = typeof current === 'string' ? current : '';
  let nextBytes = utf8ByteLength(existing) + utf8ByteLength(fragment);
  if (existing.length > 0
    && fragment.length > 0
    && /[\uD800-\uDBFF]/.test(existing.at(-1))
    && /[\uDC00-\uDFFF]/.test(fragment[0])) {
    // TextEncoder counts each unpaired surrogate as a three-byte replacement. When a
    // high surrogate ends one fragment and its low surrogate starts the next, the
    // completed scalar is four bytes, so the separate-fragment sum overcounts by two.
    nextBytes -= 2;
  }
  if (nextBytes > MAX_TOOL_CALL_ARGUMENT_BYTES) {
    throw new Error(`Streamed tool-call function.arguments must be at most ${MAX_TOOL_CALL_ARGUMENT_BYTES} UTF-8 bytes (64 KiB)`);
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

function mergeSnapshotCall (current, snapshot, snapshotOnly) {
  if (!current) return snapshot;
  if (current.type !== undefined && current.type !== snapshot.type) {
    throw new Error('Streamed tool-call type conflicts with an earlier value');
  }
  if (snapshotOnly) {
    if (current.id !== snapshot.id || current.function?.name !== snapshot.function.name) {
      throw new Error('Streamed tool-call snapshot identity conflicts with an earlier snapshot');
    }
    return snapshot;
  }
  return {
    id: current.id === undefined
      ? snapshot.id
      : compatibleValue(current.id, snapshot.id, 'id', { maxLength: MAX_TOOL_CALL_ID_LENGTH }),
    type: snapshot.type,
    function: {
      name: current.function?.name === undefined
        ? snapshot.function.name
        : compatibleValue(
            current.function.name,
            snapshot.function.name,
            'function.name',
            { maxLength: MAX_TOOL_CALL_NAME_LENGTH },
          ),
      arguments: current.function?.arguments === undefined
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
                      currentFunction.arguments,
                      nextFunction.arguments,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    };
    target.calls.set(index, next);
    target.snapshotOnly.delete(index);
  }
}

function mergeSnapshot (target, snapshot) {
  if (snapshot === undefined) return;
  const validated = sanitizeToolCalls(snapshot, 'streamed assistant tool_calls');
  const nextCalls = new Map(target.calls);
  for (const [snapshotIndex, call] of validated.entries()) {
    for (const [existingIndex, existing] of nextCalls) {
      if (existingIndex !== snapshotIndex && existing?.id !== undefined && existing.id === call.id) {
        throw new Error('Streamed tool-call snapshot conflicts with an earlier call index');
      }
    }
    if (!nextCalls.has(snapshotIndex) && nextCalls.size >= MAX_TOOL_CALLS) {
      throw new Error(`Streamed tool_calls cannot contain more than ${MAX_TOOL_CALLS} distinct call indexes`);
    }
    nextCalls.set(
      snapshotIndex,
      mergeSnapshotCall(nextCalls.get(snapshotIndex), call, target.snapshotOnly.has(snapshotIndex)),
    );
  }
  target.calls = nextCalls;
  for (let index = 0; index < validated.length; index += 1) {
    target.snapshotOnly.add(index);
  }
}

export function mergeStreamingToolCalls (target, { deltas, snapshot } = {}) {
  if (target.failure) return target;
  try {
    mergeDeltas(target, deltas);
    mergeSnapshot(target, snapshot);
  } catch (error) {
    target.failure ??= error instanceof Error ? error : new Error(String(error));
  }
  return target;
}

export function finalizeStreamingToolCalls (target) {
  if (target.failure) throw target.failure;
  const calls = Array.from(target.calls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  return calls.length ? sanitizeToolCalls(calls, 'streamed assistant tool_calls') : [];
}
