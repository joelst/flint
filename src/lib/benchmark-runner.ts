/**
 * Benchmark Preview runner: sequential execution of a suite's attempt schedule, with a
 * write-ahead-intent-then-terminal-commit durability contract and explicit Stop/Resume.
 *
 * Pure orchestration over an injected `AttemptTransport` — this module never imports `sdk.ts`
 * and never calls the SDK directly. The actual chat dispatch (through `chatCompletion`, model
 * load/preflight, memory/unload consent) is real, effectful, UI-adjacent policy that belongs to
 * whatever wires this runner up to the app (a later PR); this module only needs *a* function
 * shaped like `AttemptTransport` to be fully testable with a fake one.
 *
 * Durability contract (this is the part a benchmark runner cannot get wrong):
 *  - Before every dispatch, `recordAttemptDispatched` commits a write-ahead intent row with
 *    status `'dispatched'`. If that write itself fails, the transport is never called for that
 *    position — an intent that was never durably recorded must never be indistinguishable from
 *    one that silently succeeded.
 *  - After the transport settles (success or failure), `recordAttemptTerminal` commits the
 *    outcome. If *that* write fails, the run halts immediately (`recovery_required`) rather than
 *    continuing or silently misreporting — a result Flint cannot durably record is not a result
 *    Flint can honestly claim to have gotten.
 *  - Stop is an admission fence, not a cancellation signal: it is checked before each position's
 *    intent write, and again after the intent commits but before the transport is called. A
 *    position already dispatched when Stop lands stays `dispatched` (uncertain) — this module
 *    makes no claim that the underlying model call itself was interrupted.
 *  - Resume never edits an existing attempt row. It only re-dispatches logical positions with no
 *    terminal execution yet, each as a brand-new execution with the next `sequence` number.
 */

import {
  buildAttemptSchedule,
  nextSequenceFor,
  pendingLogicalAttempts,
  type AttemptUsage,
  type BenchmarkAttempt,
  type BenchmarkRun,
  type LogicalAttempt,
} from './benchmark-run';
import type { BenchmarkMessage, BenchmarkSuite } from './benchmark-suite';
import {
  createBenchmarkRun,
  getBenchmarkRun,
  listAttemptsForRun,
  recordAttemptDispatched,
  recordAttemptTerminal,
  updateBenchmarkRunStatus,
} from './benchmark-repository';

export interface AttemptTransportRequest {
  alias: string;
  requestedVariantId: string | null;
  messages: BenchmarkMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface AttemptTransportSuccess {
  ok: true;
  responseText: string;
  /** The variant the SDK actually served, if it differs from (or narrows) `requestedVariantId`. */
  servedVariantId?: string | null;
  usage?: AttemptUsage;
  ttftMs?: number;
}

export interface AttemptTransportFailure {
  ok: false;
  errorMessage: string;
}

export type AttemptTransportResult = AttemptTransportSuccess | AttemptTransportFailure;

/** The one impure boundary this module depends on. A real implementation wraps `chatCompletion`
 * (or `chatCompletionStream`) plus whatever load/preflight the target needs; tests use a fake. */
export type AttemptTransport = (request: AttemptTransportRequest) => Promise<AttemptTransportResult>;

export interface StopController {
  stop(): void;
  isStopped(): boolean;
}

/** Stop only ever prevents *future* dispatch admission from this controller — it has no way to
 * reach into an in-flight transport call, matching the honesty contract described above. */
export function createStopController(): StopController {
  let stopped = false;
  return {
    stop() { stopped = true; },
    isStopped() { return stopped; },
  };
}

export type RunHaltReason = 'stopped' | 'completed' | 'recovery_required';

export interface RunExecutionResult {
  status: RunHaltReason;
  /** Present only when `status === 'recovery_required'` — which durability write failed. */
  haltedError?: string;
}

function generateAttemptId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `att_${crypto.randomUUID()}`;
  }
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function generateRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `run_${crypto.randomUUID()}`;
  }
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function describeTransportThrow(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return 'Benchmark transport failed';
}

/** Deep-clones a suite so a caller mutating their own object after `startBenchmarkRun`/
 * `resumeBenchmarkRun` returns can never retroactively change the run's frozen snapshot or the
 * schedule built from it. `structuredClone` is preferred; environments without it (some older
 * test/JS runtimes) fall back to a JSON round-trip, which is sufficient since `BenchmarkSuite`
 * is plain JSON-shaped data with no functions, dates, or cycles. */
function freezeSuiteSnapshot(suite: BenchmarkSuite): BenchmarkSuite {
  if (typeof structuredClone === 'function') return structuredClone(suite);
  return JSON.parse(JSON.stringify(suite));
}

/** Tracks run ids with an execution currently in flight in this process, so a second concurrent
 * `resumeBenchmarkRun` (or a resume racing a still-running start) call for the same run can be
 * rejected instead of silently duplicating dispatches. This is a process-local guard only — it
 * is not a durable cross-tab/cross-process lease, and does not need to be: Flint runs as a
 * single desktop process per instance. */
const activeRunIds = new Set<string>();

/** Builds the message list for one logical position. Warm-ups reuse the target's first case
 * (there is nothing else to prime with); measured positions use their own case verbatim. */
function messagesForPosition(suite: BenchmarkSuite, position: LogicalAttempt): BenchmarkMessage[] {
  const caseEntry = position.phase === 'warmup' ? suite.cases[0] : suite.cases[position.caseIndex!];
  if (caseEntry.messages) return caseEntry.messages;
  return [{ role: 'user', content: caseEntry.prompt! }];
}

/** Persists the run's terminal status and returns both the result the caller should report and
 * the run object that actually reflects it. A status write failure is never silently absorbed:
 * this refuses to let the caller claim a status ('stopped'/'completed'/`recovery_required`) that
 * was never durably committed. Instead it downgrades to `recovery_required` — the most
 * conservative signal Flint can give — folds the persistence failure into `haltedError`
 * alongside whatever the caller already wanted to report, and returns `run` **unchanged**,
 * since a failed write means storage still holds whatever status it had before this call. Only
 * on a successful write does the returned `run` reflect `intended` and `patch` — built from the
 * exact same values just persisted, so it can never disagree with storage. */
async function haltWith(
  run: BenchmarkRun,
  intended: RunHaltReason,
  patch: Partial<BenchmarkRun> | undefined,
  haltedError?: string,
): Promise<{ result: RunExecutionResult; run: BenchmarkRun }> {
  const write = await updateBenchmarkRunStatus(run.id, intended, patch);
  if (write.ok) {
    const updatedRun: BenchmarkRun = { ...run, ...patch, status: intended };
    return { result: haltedError ? { status: intended, haltedError } : { status: intended }, run: updatedRun };
  }
  const persistenceError = `failed to persist run status "${intended}": ${write.error}`;
  return {
    result: {
      status: 'recovery_required',
      haltedError: haltedError ? `${haltedError}; additionally, ${persistenceError}` : persistenceError,
    },
    run,
  };
}

/**
 * Executes `positions` in order against `run`, using and extending `attemptsSoFar` (so
 * `nextSequenceFor` sees every execution written so far in this call, not just ones already in
 * storage before it started) to pick each new execution's sequence number. Returns the run
 * object reflecting whatever terminal status actually got persisted (see `haltWith`), never the
 * stale pre-execution snapshot the caller passed in.
 */
async function executePositions(
  run: BenchmarkRun,
  positions: readonly LogicalAttempt[],
  attemptsSoFar: BenchmarkAttempt[],
  transport: AttemptTransport,
  stopController: StopController,
): Promise<{ result: RunExecutionResult; run: BenchmarkRun }> {
  for (const position of positions) {
    if (stopController.isStopped()) {
      return haltWith(run, 'stopped', undefined);
    }

    const target = run.suite.targets[position.targetIndex];
    const intent: BenchmarkAttempt = {
      id: generateAttemptId(),
      runId: run.id,
      logicalAttemptId: position.logicalAttemptId,
      targetIndex: position.targetIndex,
      phase: position.phase,
      caseIndex: position.caseIndex,
      repeatIndex: position.repeatIndex,
      sequence: nextSequenceFor(position.logicalAttemptId, attemptsSoFar),
      status: 'dispatched',
      alias: target.alias,
      requestedVariantId: target.variantId,
      intentCommittedAt: Date.now(),
    };

    const dispatchWrite = await recordAttemptDispatched(intent);
    if (!dispatchWrite.ok) {
      // The chat call must never be made for a position whose intent was not durably recorded.
      return haltWith(
        run,
        'recovery_required',
        { finalizedAt: Date.now() },
        `failed to record dispatch intent: ${dispatchWrite.error}`,
      );
    }
    attemptsSoFar.push(intent);

    if (stopController.isStopped()) {
      // The intent already committed — this position stays `dispatched` (uncertain), exactly
      // as an actual crash would leave it. Never call the transport once Stop has landed.
      return haltWith(run, 'stopped', undefined);
    }

    let transportResult: AttemptTransportResult;
    try {
      transportResult = await transport({
        alias: target.alias,
        requestedVariantId: target.variantId,
        messages: messagesForPosition(run.suite, position),
        temperature: run.suite.temperature,
        maxTokens: run.suite.maxTokens,
      });
    } catch (e) {
      transportResult = { ok: false, errorMessage: describeTransportThrow(e) };
    }

    const settledAt = Date.now();
    const terminalWrite = transportResult.ok
      ? await recordAttemptTerminal(intent.id, {
          status: 'succeeded',
          responseText: transportResult.responseText,
          servedVariantId: transportResult.servedVariantId ?? null,
          usage: transportResult.usage,
          ttftMs: transportResult.ttftMs,
          settledAt,
        })
      : await recordAttemptTerminal(intent.id, {
          status: 'failed',
          errorMessage: transportResult.errorMessage,
          settledAt,
        });

    if (!terminalWrite.ok) {
      // The attempt stays `dispatched` (uncertain) in storage — this is the one outcome this
      // runner refuses to paper over. A result Flint cannot durably record is not a result
      // Flint can honestly claim to have gotten, whether the chat call itself succeeded or not.
      return haltWith(
        run,
        'recovery_required',
        { finalizedAt: Date.now() },
        `failed to record terminal result: ${terminalWrite.error}`,
      );
    }
    attemptsSoFar[attemptsSoFar.length - 1] = {
      ...intent,
      ...(transportResult.ok
        ? { status: 'succeeded' as const, responseText: transportResult.responseText, settledAt }
        : { status: 'failed' as const, errorMessage: transportResult.errorMessage, settledAt }),
    };
  }

  return haltWith(run, 'completed', { finalizedAt: Date.now() });
}

export interface StartRunOutcome {
  ok: boolean;
  run?: BenchmarkRun;
  result?: RunExecutionResult;
  error?: string;
}

/**
 * Creates a new run (an immutable snapshot of `suite`, frozen at this moment — a later edit to
 * the stored suite must never affect it) and executes its full schedule in order. Warm-up
 * failures do not block a target's measured attempts: warm-ups exist only to prime the model,
 * never to gate whether Flint bothers measuring it.
 */
export async function startBenchmarkRun(
  suite: BenchmarkSuite,
  transport: AttemptTransport,
  stopController: StopController = createStopController(),
): Promise<StartRunOutcome> {
  // Snapshot (deep-clone) before any await: the caller's `suite` object must never be able to
  // retroactively change what this run recorded or scheduled, even if it's mutated the instant
  // after this call returns control to the event loop.
  const frozenSuite = freezeSuiteSnapshot(suite);
  const runId = generateRunId();
  const run: BenchmarkRun = {
    id: runId,
    suiteId: frozenSuite.id,
    suite: frozenSuite,
    createdAt: Date.now(),
    status: 'running',
    startedAt: Date.now(),
  };

  if (activeRunIds.has(runId)) {
    // Vanishingly unlikely (a fresh id colliding with one already in flight), but a run must
    // never be executed twice concurrently under the same id.
    return { ok: false, error: `benchmark run "${runId}" is already active` };
  }
  activeRunIds.add(runId);
  try {
    const created = await createBenchmarkRun(run);
    if (!created.ok) return { ok: false, error: created.error };

    const schedule = buildAttemptSchedule(frozenSuite);
    const { result, run: finalRun } = await executePositions(run, schedule, [], transport, stopController);
    return { ok: true, run: finalRun, result };
  } finally {
    activeRunIds.delete(runId);
  }
}

export interface ResumeRunOutcome {
  ok: boolean;
  run?: BenchmarkRun;
  result?: RunExecutionResult;
  error?: string;
}

/**
 * Re-attempts only the logical positions that have no terminal execution yet — this covers both
 * positions left `dispatched` (uncertain, from a crash or a prior Stop) and positions never
 * attempted at all. Every position with a genuine terminal success/failure is left completely
 * untouched, and no existing attempt row is edited: each retry is a new execution.
 *
 * Guarded (per-process only, see `activeRunIds`) against a second concurrent resume of the same
 * run id: without this, two overlapping calls could both classify the same logical position as
 * pending, both pick the same next `sequence`, and both dispatch — duplicating the model call
 * and violating the one-new-execution-per-retry identity contract.
 */
export async function resumeBenchmarkRun(
  runId: string,
  transport: AttemptTransport,
  stopController: StopController = createStopController(),
): Promise<ResumeRunOutcome> {
  if (activeRunIds.has(runId)) {
    return { ok: false, error: `benchmark run "${runId}" already has an execution in progress` };
  }
  activeRunIds.add(runId);
  try {
    const runResult = await getBenchmarkRun(runId);
    if (!runResult.ok) return { ok: false, error: runResult.error };
    if (!runResult.value) return { ok: false, error: `no benchmark run "${runId}"` };
    const run = runResult.value;

    const attemptsResult = await listAttemptsForRun(runId);
    if (!attemptsResult.ok) return { ok: false, error: attemptsResult.error };
    const attempts = attemptsResult.value ?? [];

    const schedule = buildAttemptSchedule(run.suite);
    const pending = pendingLogicalAttempts(schedule, attempts);
    if (pending.length === 0) {
      const { result, run: finalRun } = await haltWith(run, 'completed', { finalizedAt: Date.now() });
      return { ok: true, result, run: finalRun };
    }

    // Capture the timestamp once: calling Date.now() separately for the write and for the
    // returned snapshot could let the two disagree by a few ms, breaking the invariant that
    // the returned run always matches what was just persisted.
    const resumedStartedAt = run.startedAt ?? Date.now();
    const resumedStart = await updateBenchmarkRunStatus(runId, 'running', { startedAt: resumedStartedAt });
    if (!resumedStart.ok) return { ok: false, error: resumedStart.error };
    const resumingRun: BenchmarkRun = { ...run, status: 'running', startedAt: resumedStartedAt };

    const { result, run: finalRun } = await executePositions(resumingRun, pending, [...attempts], transport, stopController);
    return { ok: true, result, run: finalRun };
  } finally {
    activeRunIds.delete(runId);
  }
}
