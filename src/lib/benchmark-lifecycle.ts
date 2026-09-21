/**
 * Benchmark Preview start/resume coordinator: pin-before-load, alias-only transport,
 * and detached execution. The page binds $state and injects SDK operations.
 */

import { SidecarOperationError } from './operation-outcome';
import { usageFromChatCompletion } from './chat-usage';
import {
  createStopController,
  prepareBenchmarkRun,
  resumeBenchmarkRun,
  startBenchmarkRun,
  type AttemptTransport,
  type AttemptTransportRequest,
  type AttemptTransportResult,
  type StartRunOutcome,
  type StopController,
} from './benchmark-runner';
import { getBenchmarkRun, listAttemptsForRun, updateBenchmarkRunStatus } from './benchmark-repository';
import { pendingTargetIndexes, type BenchmarkAttempt } from './benchmark-run';
import { isBenchmarkSuite, type BenchmarkSuite } from './benchmark-suite';

export type LifecycleOutcome = { ok: true; runId: string } | { ok: false; error: string };

export interface BenchmarkLifecycleHost {
  /** Returns the variant the runtime actually loaded, when the load reply reports one. */
  loadModel(alias: string, variantId: string | null): Promise<string | null | void>;
  pinAliases(aliases: string[]): Promise<void>;
  unpin(): Promise<void>;
  chatCompletion(
    alias: string,
    messages: AttemptTransportRequest['messages'],
    opts: { maxTokens?: number; temperature?: number },
  ): Promise<{
    choices?: Array<{ message?: { content?: unknown } }>;
    servedVariantId?: string | null;
    usage?: unknown;
  }>;
}

function targetsToPrepare(suite: BenchmarkSuite, onlyTargetIndexes?: ReadonlySet<number>) {
  return suite.targets.filter((_, i) => onlyTargetIndexes == null || onlyTargetIndexes.has(i));
}

export type PrepareResult = { ok: true } | { ok: false; error: string; stopped?: boolean };

/** Explicit suite variant; else the durable bound variant recorded when an earlier attempt's
 * intent was committed, which survives even a position left `dispatched` (uncertain) by Stop or
 * a crash; else (for attempt rows written before `boundVariantId` existed) the served variant
 * from a completed attempt, as a backward-compatible fallback.
 *
 * All attempts for one target within a run are expected to record the same binding — pinThenLoad
 * aborts preparation the moment a load resolves to something else, so no attempt should ever
 * disagree with an earlier one, *and* an explicit suite variant is validated against whatever was
 * actually recorded rather than trusted blindly: an older/headless run (or a suite edited after
 * the fact) could have bound to a different build, and silently loading today's suite variant
 * instead would mix measurements from two variants into one target. If persisted rows disagree
 * with each other or with an explicit suite variant (only reachable through data corruption, a
 * suite edit, or a bug elsewhere), refuse to pick one arbitrarily: report the conflict so resume
 * fails loudly instead of silently binding to a value that may not match what the original run
 * actually executed against.
 *
 * If this target has attempts but none recorded a binding (legacy dispatched-only rows from
 * before `boundVariantId`), fail closed: treating that as never-run would load today's default
 * and mix builds. Callers should only invoke this for targets Resume will still execute. */
export function boundVariantIdForTarget(
  target: { variantId: string | null },
  targetIndex: number,
  attempts: readonly Pick<BenchmarkAttempt, 'targetIndex' | 'boundVariantId' | 'servedVariantId'>[],
): { ok: true; variantId: string | null } | { ok: false; error: string } {
  const recorded = new Set<string>();
  let matching = 0;
  for (const attempt of attempts) {
    if (attempt.targetIndex !== targetIndex) continue;
    matching += 1;
    // Both fields are recorded independently (not boundVariantId-else-servedVariantId): an
    // attempt where they disagree is exactly the "another load replaced the pinned variant
    // mid-run" case assertServedVariant already detects at record time, and Resume must not
    // paper over it by only ever looking at one of the two fields.
    if (typeof attempt.boundVariantId === 'string' && attempt.boundVariantId.length > 0) {
      recorded.add(attempt.boundVariantId);
    }
    if (typeof attempt.servedVariantId === 'string' && attempt.servedVariantId.length > 0) {
      recorded.add(attempt.servedVariantId);
    }
  }
  if (target.variantId) {
    const conflicting = [...recorded].filter((v) => v !== target.variantId);
    if (conflicting.length > 0) {
      return {
        ok: false,
        error:
          `Target ${targetIndex} recorded variant(s) ${conflicting.join(', ')} that do not match `
          + `the suite's explicit variant "${target.variantId}" — start a new run rather than `
          + `mixing measurements from two variants`,
      };
    }
    return { ok: true, variantId: target.variantId };
  }
  if (matching > 0 && recorded.size === 0) {
    return {
      ok: false,
      error:
        `Target ${targetIndex} has attempts but none recorded a bound or served variant; `
        + `start a new run rather than mixing today's default with the original build`,
    };
  }
  if (recorded.size > 1) {
    return {
      ok: false,
      error: `Conflicting recorded variants for target ${targetIndex} (${target.variantId ?? 'alias-only'}): ${[...recorded].join(', ')}`,
    };
  }
  return { ok: true, variantId: recorded.size === 1 ? [...recorded][0] : null };
}

export function assertServedVariant(
  alias: string,
  expected: string | null,
  served: string | null,
): { ok: true } | { ok: false; errorMessage: string } {
  if (!expected) return { ok: true };
  if (!served) {
    return {
      ok: false,
      errorMessage: `Response for ${alias} did not report a served variant; expected "${expected}"`,
    };
  }
  if (served !== expected) {
    return {
      ok: false,
      errorMessage:
        `Served variant "${served}" did not match the bound variant "${expected}" for ${alias}`
        + ` — another load likely replaced the pinned variant mid-run`,
    };
  }
  return { ok: true };
}

export async function loadBenchmarkTargets(
  suite: BenchmarkSuite,
  loadModel: BenchmarkLifecycleHost['loadModel'],
  stopController?: StopController,
  onlyTargetIndexes?: ReadonlySet<number>,
  expectedByAlias?: Map<string, string>,
): Promise<PrepareResult> {
  for (const target of targetsToPrepare(suite, onlyTargetIndexes)) {
    if (stopController?.isStopped()) {
      return { ok: false, error: 'Stopped before every target was loaded', stopped: true };
    }
    const bound = expectedByAlias?.get(target.alias) ?? target.variantId;
    try {
      const resolved = await loadModel(target.alias, bound);
      // Reject whitespace-only "resolved" values rather than trusting them as a real variant id
      // — an identifier consisting only of whitespace can never legitimately equal `bound` or a
      // suite variant id, so treating it as informative would only ever produce a false mismatch
      // (or worse, get durably persisted as a bogus binding).
      if (typeof resolved === 'string' && resolved.trim().length > 0) {
        // `bound` is either an explicit suite variant (fresh run, `expectedByAlias` still empty)
        // or a variant already recorded earlier in this same prepare pass -- either way, once a
        // variant is bound for this alias, a load reporting a different one must abort rather
        // than silently rebind: comparing only against a *prior* map entry missed the fresh
        // explicit-variant case entirely (an empty map has no prior entry to disagree with), so
        // execution would proceed against whatever the loader actually resolved instead of the
        // variant the suite asked for.
        if (bound && bound !== resolved) {
          return {
            ok: false,
            error: `Loaded variant "${resolved}" for ${target.alias} did not match the bound variant "${bound}"`,
          };
        }
        expectedByAlias?.set(target.alias, resolved);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `Could not load ${target.alias}${bound ? ` (${bound})` : ''}: ${message}`,
      };
    }
  }
  return { ok: true };
}

export function createSidecarBenchmarkTransport(
  chatCompletion: BenchmarkLifecycleHost['chatCompletion'],
  expectedByAlias: Map<string, string> = new Map(),
): AttemptTransport {
  return async (request: AttemptTransportRequest): Promise<AttemptTransportResult> => {
    try {
      const res = await chatCompletion(request.alias, request.messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
      const content = res?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        return { ok: false, errorMessage: 'Response had no message content' };
      }
      const servedVariantId = res?.servedVariantId ?? null;
      const expected = request.requestedVariantId ?? expectedByAlias.get(request.alias) ?? null;
      const checked = assertServedVariant(request.alias, expected, servedVariantId);
      if (!checked.ok) return { ok: false, errorMessage: checked.errorMessage };
      if (servedVariantId) expectedByAlias.set(request.alias, servedVariantId);
      return {
        ok: true,
        responseText: content,
        servedVariantId,
        usage: usageFromChatCompletion(res?.usage),
      };
    } catch (e: unknown) {
      if (e instanceof SidecarOperationError && (e.certainty === 'cancelled' || e.certainty === 'unknown')) {
        return {
          ok: false,
          errorMessage: e.message || (e.certainty === 'cancelled' ? 'Runtime is draining' : 'Lost contact with the runtime'),
          haltRun: 'stopped',
        };
      }
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, errorMessage: message };
    }
  };
}

export interface PreparedExecution {
  runId: string;
  stopController: StopController;
  done: Promise<StartRunOutcome>;
  /** Attempt IDs that already existed in storage before this session dispatched anything.
   * A leftover `dispatched` row from a prior Stop/crash keeps its original id; only a genuinely
   * new dispatch from *this* session mints a fresh one (see `generateAttemptId` in
   * `benchmark-runner.ts`), so "not in this set" is an exact identity check for "this session's
   * work" — unlike a wall-clock comparison, it cannot be fooled by the system clock repeating or
   * moving backward during the unbounded model-loading phase between snapshot and dispatch. */
  knownAttemptIds: ReadonlySet<string>;
}

async function pinThenLoad(
  suite: BenchmarkSuite,
  host: BenchmarkLifecycleHost,
  stopController?: StopController,
  onlyTargetIndexes?: ReadonlySet<number>,
  expectedByAlias?: Map<string, string>,
): Promise<PrepareResult> {
  if (stopController?.isStopped()) {
    return { ok: false, error: 'Stopped before targets were pinned', stopped: true };
  }
  const targets = targetsToPrepare(suite, onlyTargetIndexes);
  if (targets.length === 0) return { ok: true };
  const aliases = Array.from(new Set(targets.map((t) => t.alias)));
  // Any pin failure -- not just for suites with explicit variants -- must abort preparation.
  // Proceeding to load anyway would run the benchmark with no eviction protection at all: under
  // an enabled idle/cap policy, loading a later target or merely pausing between attempts could
  // unload an earlier target mid-run, contradicting the "pinned for the run's duration"
  // invariant and making results depend on eviction/reload timing instead of being measured
  // consistently. Still unpin during cleanup: a failed pin acknowledgement is uncertain, not
  // proven absent, so the priority lease may need releasing regardless.
  //
  // Fire-and-forget, not awaited: `host.unpin()` ultimately sends `applyMemorySettings`, which
  // has no IPC deadline (see ipc-deadlines.ts) by design -- effectful operations are never
  // client-side timed out. Awaiting it here would make this function's returned promise (and
  // therefore `done` in `startBenchmarkSession`/`resumeBenchmarkSession`, and the exclusive
  // gateway release the caller's `.finally()` performs once `done` settles) hang for as long as
  // the sidecar takes to answer -- indefinitely, if it has stopped answering at all. The same
  // reasoning that made `finishBenchmarkExecution` in +page.svelte background its own restore
  // call (`void unpinBenchmarkTargets()`) applies identically here; `pendingPriorityRestore`
  // (tracked inside `unpinBenchmarkTargets` itself) still makes a later `pinAliases` call join
  // this restore before sending its own pin, so backgrounding it does not reopen the
  // stale-write race that tracker exists to close.
  try {
    await host.pinAliases(aliases);
  } catch (e: unknown) {
    const pinError = e instanceof Error ? e.message : String(e);
    void host.unpin().catch(() => {});
    return { ok: false, error: `Could not pin targets: ${pinError}` };
  }
  if (stopController?.isStopped()) {
    void host.unpin().catch(() => {});
    return { ok: false, error: 'Stopped before every target was loaded', stopped: true };
  }
  const loaded = await loadBenchmarkTargets(suite, host.loadModel, stopController, onlyTargetIndexes, expectedByAlias);
  if (!loaded.ok) {
    void host.unpin().catch(() => {});
    return loaded;
  }
  return { ok: true };
}

/** Marks a reserved run stopped after preparation fails. IndexedDB `{ ok: false }` is a
 * normal result, not a throw — callers must not `.catch()` it away. */
export async function haltPreparedRun(runId: string, preparationError: string): Promise<string> {
  const halted = await updateBenchmarkRunStatus(runId, 'stopped', { finalizedAt: Date.now() });
  if (!halted.ok) {
    return `${preparationError}; also could not mark the run stopped: ${halted.error}`;
  }
  return preparationError;
}

/** User Stop during pin/load is a successful halt (same shape as the runner), not a failed start.
 * A failed status write is `recovery_required`, matching `haltWith`. */
async function finishPreparedHalt(
  runId: string,
  host: BenchmarkLifecycleHost,
  kind: 'stopped' | 'failed',
  error: string,
): Promise<StartRunOutcome> {
  // Fire-and-forget for the same reason as `pinThenLoad`'s own unpin calls above: awaiting an
  // unbounded `applyMemorySettings` restore here would hang this function's returned promise --
  // and therefore `done` and the exclusive-gateway release gated on it -- if the sidecar never
  // answers. `benchmarkPinnedAliases` is already cleared (and `pendingPriorityRestore` already
  // tracking this call) synchronously inside `unpin()` before this line returns.
  void host.unpin().catch(() => {});
  if (kind === 'stopped') {
    const halted = await updateBenchmarkRunStatus(runId, 'stopped', { finalizedAt: Date.now() });
    if (!halted.ok) {
      return {
        ok: true,
        result: { status: 'recovery_required', haltedError: `failed to persist run status "stopped": ${halted.error}` },
      };
    }
    return { ok: true, result: { status: 'stopped' } };
  }
  return { ok: false, error: await haltPreparedRun(runId, error) };
}

/** Resume-only guard: immediately before this runs, `getBenchmarkRun` already re-validated the
 * stored run with `isBenchmarkRun(..., { allowDuplicateAliases: true })` against every *current*
 * suite constraint (targets/cases counts, attempt limits, etc.) tolerating only the pre-1.0
 * duplicate-target-alias shape. So the only way `suite` can still fail this stricter
 * `isBenchmarkSuite` check is that one tolerated legacy shape, and the message naming it is
 * accurate here. (Start does not use this: a *fresh* suite has never been validated at all yet,
 * so attributing every possible validation failure to duplicate aliases would be misleading —
 * `prepareBenchmarkRun` runs `validateBenchmarkSuite` immediately after and reports the suite's
 * actual errors instead.) */
function resumeInexecutableSuiteError(suite: BenchmarkSuite, runId: string): string | null {
  if (isBenchmarkSuite(suite)) return null;
  return `benchmark run "${runId}" cannot be resumed: its suite snapshot has duplicate target aliases from before that shape was rejected`;
}

export async function startBenchmarkSession(
  suite: BenchmarkSuite,
  host: BenchmarkLifecycleHost,
): Promise<{ ok: true; execution: PreparedExecution } | { ok: false; error: string }> {

  // Insert the run row before pin/load so putBenchmarkSuiteIfNoRuns / Edit see history for
  // this suite during the long prepare window (a remount resets local lifecycleBusy).
  const prepared = await prepareBenchmarkRun(suite);
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const stopController = createStopController();
  const expectedByAlias = new Map<string, string>();
  const transport = createSidecarBenchmarkTransport(host.chatCompletion, expectedByAlias);
  const runId = prepared.run.id;
  // Pin/load/execute the frozen snapshot, not the caller's object — mutating `suite` while
  // pinAliases is awaiting would otherwise load a different alias set than the run will execute.
  const frozen = prepared.run.suite;
  // Return the controller immediately so Stop is live during unbounded model loads. Pin/load
  // and execution run on `done`; loadModel has no cancel-in-flight API, so Stop is honored
  // between operations (same admission contract as the runner).
  const done = (async (): Promise<StartRunOutcome> => {
    const preparedPin = await pinThenLoad(frozen, host, stopController, undefined, expectedByAlias);
    if (!preparedPin.ok) {
      return finishPreparedHalt(runId, host, preparedPin.stopped ? 'stopped' : 'failed', preparedPin.error);
    }
    if (stopController.isStopped()) {
      return finishPreparedHalt(runId, host, 'stopped', 'Stopped during preparation');
    }
    return startBenchmarkRun(frozen, transport, stopController, prepared.run, expectedByAlias);
  })();
  // A new run has no leftover dispatched rows; an empty set means every intent is this session.
  return { ok: true, execution: { runId, stopController, done, knownAttemptIds: new Set() } };
}

export async function resumeBenchmarkSession(
  runId: string,
  host: BenchmarkLifecycleHost,
): Promise<{ ok: true; execution: PreparedExecution } | { ok: false; error: string }> {
  const existing = await getBenchmarkRun(runId);
  if (!existing.ok || !existing.value) {
    return { ok: false, error: existing.error || 'Run not found' };
  }
  const suite = existing.value.suite;
  const inexecutable = resumeInexecutableSuiteError(suite, runId);
  if (inexecutable) return { ok: false, error: inexecutable };

  // Fetched once, up front, and reused by both `knownAttemptIds` (below) and `done` (which
  // would otherwise have to re-fetch the same rows to compute `only`/`expectedByAlias`) — the
  // set of ids captured here is exactly "every attempt that existed before this session
  // dispatched anything", the leftover/this-session boundary `buildProgressMatrix` needs.
  const attempts = await listAttemptsForRun(runId);
  if (!attempts.ok) return { ok: false, error: attempts.error || 'Failed to load existing attempts' };
  const existingRows = attempts.value ?? [];
  const knownAttemptIds = new Set(existingRows.map((a) => a.id));

  const stopController = createStopController();
  const expectedByAlias = new Map<string, string>();
  const transport = createSidecarBenchmarkTransport(host.chatCompletion, expectedByAlias);
  const done = (async (): Promise<StartRunOutcome> => {
    // Same attempt list resumeBenchmarkRun will use. Pin/load only unsettled targets so a
    // deleted completed model cannot fail this prepare and block the remaining retries.
    const rows = existingRows;
    // Only bind variants for targets Resume will still execute. A completed alias-only target
    // can have legacy terminal rows with neither boundVariantId nor servedVariantId; failing
    // closed on those would block retries of still-pending targets we can bind.
    const only = new Set(pendingTargetIndexes(suite, rows));
    for (const i of only) {
      const target = suite.targets[i];
      const bound = boundVariantIdForTarget(target, i, rows);
      if (!bound.ok) {
        return finishPreparedHalt(runId, host, 'failed', bound.error);
      }
      if (bound.variantId) expectedByAlias.set(target.alias, bound.variantId);
    }
    if (only.size > 0) {
      const preparedPin = await pinThenLoad(suite, host, stopController, only, expectedByAlias);
      if (!preparedPin.ok) {
        return finishPreparedHalt(runId, host, preparedPin.stopped ? 'stopped' : 'failed', preparedPin.error);
      }
    }
    if (stopController.isStopped()) {
      return finishPreparedHalt(runId, host, 'stopped', 'Stopped during preparation');
    }
    return resumeBenchmarkRun(runId, transport, stopController, expectedByAlias);
  })();
  return { ok: true, execution: { runId, stopController, done, knownAttemptIds } };
}
