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
  const ids = new Set();
  return toolCalls.map((toolCall, index) => {
    const callField = `${field}[${index}]`;
    if (!isPlainObject(toolCall)
      || typeof toolCall.id !== 'string'
      || !toolCall.id.trim()
      || toolCall.id.length > MAX_TOOL_CALL_ID_LENGTH) {
      throw new Error(`${callField}.id must be a non-empty string of at most ${MAX_TOOL_CALL_ID_LENGTH} characters`);
    }
    if (ids.has(toolCall.id)) {
      throw new Error(`${field} must not contain duplicate call IDs`);
    }
    ids.add(toolCall.id);
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
    // Caches incremental argument-prefix verification so repeatedly reconciling one
    // call's growing `function.arguments` (against a snapshot counterpart, or between
    // successive snapshots of the same id) costs proportionally to the new bytes added
    // since the last check, not to the full accumulated length each time. Keyed by
    // delta call index / snapshot id respectively; see `reconcileArgumentsWithCache`.
    deltaArgumentCache: new Map(),
    snapshotArgumentCache: new Map(),
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

// Structural equality used only for array leaves inside `isJsonExtension`: JSON.parse
// always produces fresh array instances, so Object.is never matches even when an array
// field is genuinely unchanged between two cumulative snapshots. Arrays are compared by
// value here rather than treated as extendable, since element-wise growth cannot be
// distinguished from replacement. Uses an explicit worklist (not recursion) since
// `function.arguments` up to 64 KiB can encode arrays/objects nested deeply enough to
// overflow the call stack if compared recursively.
function deepEqual (a, b) {
  const pending = [[a, b]];
  while (pending.length > 0) {
    const [x, y] = pending.pop();
    if (Object.is(x, y)) continue;
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i += 1) pending.push([x[i], y[i]]);
      continue;
    }
    if (isPlainObject(x) && isPlainObject(y)) {
      const keys = Object.keys(x);
      if (keys.length !== Object.keys(y).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(y, key)) return false;
        pending.push([x[key], y[key]]);
      }
      continue;
    }
    return false;
  }
  return true;
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
    if (Array.isArray(subset) || Array.isArray(value)) {
      if (!deepEqual(subset, value)) return false;
      continue;
    }
    if (!isPlainObject(subset) || !isPlainObject(value)) return false;
    for (const [key, child] of Object.entries(subset)) {
      if (!Object.hasOwn(value, key)) return false;
      pending.push([child, value[key]]);
    }
  }
  return true;
}

// Reconciles a `function.arguments` string pair that may be two cumulative snapshots,
// a streaming delta fragment against a snapshot, or vice versa. Tries JSON-subset
// extension in both directions first (an in-progress fragment is rarely valid JSON on
// its own, so this usually only succeeds once both sides parse), then falls back to
// plain textual prefix compatibility for partial fragments.
//
// `allowDefer` covers a gap the structural/textual checks above cannot: a fragment can
// be syntactically *incomplete* (fails to parse as JSON at all, e.g. `'{"a":{}'` before
// its closing brace arrives) without yet being provably wrong — its eventual complete
// form could still turn out to be a valid JSON-subset extension once finished (as the
// bidirectional `isJsonExtension` check above would confirm). The plain textual prefix
// fallback (`compatibleValue`) cannot tell "still incomplete" apart from "genuinely
// different content" — both simply fail the "is one a literal prefix of the other"
// test. So when `allowDefer` is set and at least one side does not yet parse as
// complete JSON, a prefix mismatch is treated as merely undecided rather than a
// confirmed conflict: `deferred: true` is returned instead of throwing, and the caller
// must not persist this outcome as settled (see `reconcileArgumentsWithCache`) since a
// later fragment could still resolve it either way. Once both sides *do* parse (or at
// `final`, where allowDefer is never set), a prefix mismatch is a real, permanent
// conflict and still throws exactly as before.
function reconcileArguments (current, incoming, maxBytes, { allowDefer = false } = {}) {
  if (isJsonExtension(current, incoming)) return { value: incoming, deferred: false };
  if (isJsonExtension(incoming, current)) return { value: current, deferred: false };
  if (allowDefer && (!isCompleteJson(current) || !isCompleteJson(incoming))) {
    return { value: current.length >= incoming.length ? current : incoming, deferred: true };
  }
  return { value: compatibleValue(current, incoming, 'function.arguments', { maxBytes }), deferred: false };
}

function isCompleteJson (value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  // A successfully-parsed bare JSON *number* is not necessarily finished growing:
  // unlike objects/arrays (closed by a matching brace/bracket), strings (closed by a
  // quote), and the exact keywords true/false/null, a JSON number has no closing
  // delimiter — '1' parses successfully today but could still become '1e-1' (or '15',
  // '1.5', etc.) on a later fragment, and a differently-formatted-but-equal number
  // (e.g. '1e-1' vs '0.1') only resolves once compared as a fully-formed value via
  // `isJsonExtension`'s numeric equality check above, not while still (potentially)
  // mid-digit. Every other JSON type genuinely cannot be extended once it parses.
  return typeof parsed !== 'number';
}

// Reconciles the same pair as `reconcileArguments`, but a growing stream calls this
// repeatedly for the same call as its `arguments` string is extended one fragment (or
// one snapshot revision) at a time. Re-running `reconcileArguments` from scratch on
// every call would cost O(current length) each time — quadratic overall for N
// fragments accumulating a large string, and (via `isJsonExtension`) at least one full
// `JSON.parse` of both sides on every call regardless of outcome.
//
// `cache` (one per call/snapshot id, persisted across calls) remembers:
//   - the exact (current, incoming) pair last checked and its result, so a call where
//     neither side has actually changed since the last check (e.g. a different call
//     index's fragment triggered re-validation of this one) is O(1), not a repeat of
//     the full comparison;
//   - the UTF-8 byte length ceiling check for `incoming`, performed only when
//     `incoming` itself changes identity, not on every call;
//   - how much of the shorter side has already been confirmed as a matching textual
//     prefix of the longer side, advanced only via that same cheap textual comparison
//     (never optimistically advanced by a structural-only match, since two strings can
//     be JSON-equivalent without one being a textual prefix of the other — trusting
//     that for future incremental checks could let a later genuine conflict slip past
//     the cheap path). Once reached, only the delta since the last check is compared,
//     making the common case (one side monotonically extending the other via plain
//     textual growth) O(new bytes) instead of O(total bytes so far).
// The exact, JSON-subset-aware `reconcileArguments` still runs — and its cost is still
// paid — whenever the cheap paths above cannot answer the pair from cache.
//
// `allowDefer` forwards to `reconcileArguments` (see its doc comment) for the mid-stream
// case where a currently-incomplete fragment cannot yet be proven either compatible or
// conflicting. A deferred outcome is deliberately NOT committed to `cache`: this same
// cache is reused, unchanged, by the later `final: true` validation of the same pair
// once it's known whether more fragments will still arrive — persisting an unproven
// placeholder here would let that stricter final check wrongly hit the cheap
// exact-reference fast path above and skip real validation entirely.
function reconcileArgumentsWithCache (cache, current, incoming, maxBytes, { allowDefer = false } = {}) {
  if (typeof current !== 'string' || typeof incoming !== 'string') {
    throw new Error('Streamed tool-call function.arguments must be a string');
  }
  if (cache.currentRef === current && cache.incomingRef === incoming) {
    return cache.result;
  }
  // Compute the next cache state entirely in locals and commit it to `cache` only after
  // every step below has succeeded without throwing — a thrown reconciliation error
  // must leave the cache exactly as it was, so a later call with the very same pair
  // (e.g. a second `finalizeStreamingToolCalls` after the first threw) re-validates
  // from scratch instead of matching a partially-updated, stale cache entry.
  let nextIncomingRef = cache.incomingRef;
  let nextVerifiedLength = cache.verifiedLength;
  if (cache.incomingRef !== incoming) {
    if (maxBytes !== undefined && utf8ByteLength(incoming) > maxBytes) {
      throw new Error(`Streamed tool-call function.arguments must be at most ${maxBytes} UTF-8 bytes (64 KiB)`);
    }
    nextIncomingRef = incoming;
    nextVerifiedLength = 0;
  }
  const shorter = current.length <= incoming.length ? current : incoming;
  const longer = current.length <= incoming.length ? incoming : current;
  const start = Math.min(nextVerifiedLength, shorter.length);
  let result;
  if (start === shorter.length || shorter.slice(start) === longer.slice(start, shorter.length)) {
    nextVerifiedLength = shorter.length;
    result = longer;
  } else {
    const reconciled = reconcileArguments(current, incoming, maxBytes, { allowDefer });
    if (reconciled.deferred) return reconciled.value;
    result = reconciled.value;
  }
  cache.incomingRef = nextIncomingRef;
  cache.verifiedLength = nextVerifiedLength;
  cache.currentRef = current;
  cache.result = result;
  return result;
}

function mergeSnapshotCall (current, snapshot, cache) {
  if (!current) return snapshot;
  if (current.id !== snapshot.id || current.type !== snapshot.type || current.function.name !== snapshot.function.name) {
    throw new Error('Streamed tool-call snapshot identity conflicts with an earlier snapshot');
  }
  return {
    id: snapshot.id,
    type: snapshot.type,
    function: {
      name: snapshot.function.name,
      arguments: reconcileArgumentsWithCache(
        cache,
        current.function.arguments,
        snapshot.function.arguments,
        MAX_TOOL_CALL_ARGUMENT_BYTES,
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

// Plain prefix-fuzzy matching only — this must NOT prefer an exact id match while a
// delta's identity may still be growing (mid-stream), because an exact-looking match
// today can become wrong once more characters arrive (see `finalCandidates`, which
// layers exact-match disambiguation on top of this, but only once final).
function matchingSnapshots (target, delta) {
  return target.snapshotOrder
    .map((id) => target.snapshots.get(id))
    .filter((snapshot) => identityCompatible(delta, snapshot));
}

// At `final: true` every delta's id/name has fully arrived, so an exact id match is
// truly unambiguous (`target.snapshots` is keyed uniquely by id) even when another
// snapshot's id happens to be a superstring of it (e.g. `call-a` vs. `call-ab`).
// Applying this same narrowing mid-stream would be unsafe: a delta whose id currently
// equals one snapshot's id in full may still grow into a different snapshot's id on a
// later fragment, so exact-match preference is intentionally withheld until final.
function finalCandidates (candidates, delta, final) {
  if (!final || candidates.length <= 1 || delta?.id === undefined) return candidates;
  const exact = candidates.filter((snapshot) => snapshot.id === delta.id);
  return exact.length === 1 ? exact : candidates;
}

// `final` defaults to `true` (finalize's own call site never passes it, since finalize
// always wants strict, unconditional validation). The one caller that validates
// mid-stream (`assertReconciliationIsUnambiguous`) explicitly passes `final: false`,
// which allows the `function.arguments` reconciliation to defer an unproven, currently-
// incomplete-JSON prefix mismatch instead of treating it as a permanent conflict (see
// `reconcileArguments`'s doc comment). `id`/`function.name` are plain incrementally-
// streamed text, not JSON, so an in-progress fragment is always a true prefix of its
// eventual complete value — those two fields have no equivalent "incomplete but not yet
// disprovable" case and are validated with the same strictness regardless of `final`.
function mergeDeltaSnapshot (delta, snapshot, cache, { final = true } = {}) {
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
        : reconcileArgumentsWithCache(
            cache,
            delta.function.arguments,
            snapshot.function.arguments,
            MAX_TOOL_CALL_ARGUMENT_BYTES,
            { allowDefer: !final },
          ),
    },
  };
}

function getArgumentCache (cacheMap, key) {
  let cache = cacheMap.get(key);
  if (!cache) {
    cache = { currentRef: undefined, incomingRef: undefined, verifiedLength: 0, result: undefined };
    cacheMap.set(key, cache);
  }
  return cache;
}

// Delta/snapshot pairing is provisional until finalization: a streamed identity can
// still grow, and later snapshots can supply the true partner. Keep cross-record
// identity and content checks here final-only; input shape, size, and conflicts between
// cumulative snapshots are validated as they arrive.
function assertReconciliationIsUnambiguous (target, { final = false } = {}) {
  if (!final || target.snapshots.size === 0 || target.calls.size === 0) return;
  const deltaCandidates = new Map();
  const claimCounts = new Map();
  for (const [index, delta] of target.calls.entries()) {
    const candidates = finalCandidates(matchingSnapshots(target, delta), delta, true);
    deltaCandidates.set(index, candidates);
    if (candidates.length === 1) {
      const id = candidates[0].id;
      claimCounts.set(id, (claimCounts.get(id) || 0) + 1);
    }
  }
  const matchedSnapshotIds = new Set();
  let unmatchedDeltas = 0;
  for (const [index, delta] of target.calls.entries()) {
    const candidates = deltaCandidates.get(index);
    if (candidates.length > 1) {
      throw new Error('Streamed tool-call identity is ambiguous');
    }
    if (candidates.length === 1) {
      const snapshot = candidates[0];
      const id = snapshot.id;
      if (claimCounts.get(id) > 1) {
        throw new Error('Streamed tool-call identity conflicts with another call');
      }
      mergeDeltaSnapshot(delta, snapshot, getArgumentCache(target.deltaArgumentCache, index), { final: true });
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
  for (const call of validated) {
    if (!target.snapshots.has(call.id)) {
      if (target.snapshots.size >= MAX_TOOL_CALLS) {
        throw new Error(`Streamed tool_calls cannot contain more than ${MAX_TOOL_CALLS} snapshot calls`);
      }
      target.snapshotOrder.push(call.id);
    }
    target.snapshots.set(
      call.id,
      mergeSnapshotCall(target.snapshots.get(call.id), call, getArgumentCache(target.snapshotArgumentCache, call.id)),
    );
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
    .map(([index, delta]) => {
      const candidates = finalCandidates(matchingSnapshots(target, delta), delta, true);
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
      return mergeDeltaSnapshot(delta, snapshot, getArgumentCache(target.deltaArgumentCache, index));
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
