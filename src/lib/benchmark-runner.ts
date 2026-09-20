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

/** Builds the message list for one logical position. Warm-ups reuse the target's first case
 * (there is nothing else to prime with); measured positions use their own case verbatim. */
function messagesForPosition(suite: BenchmarkSuite, position: LogicalAttempt): BenchmarkMessage[] {
  const caseEntry = position.phase === 'warmup' ? suite.cases[0] : suite.cases[position.caseIndex!];
  if (caseEntry.messages) return caseEntry.messages;
  return [{ role: 'user', content: caseEntry.prompt! }];
}

/** Best-effort: a failure to record `recovery_required` itself does not change what already
 * happened to the attempt journal, so it is not treated as a second durability failure — the
 * caller's returned `RunExecutionResult` is the authoritative signal either way. */
async function markRecoveryRequired(runId: string): Promise<void> {
  await updateBenchmarkRunStatus(runId, 'recovery_required', { finalizedAt: Date.now() });
}

/**
 * Executes `positions` in order against `run`, using and extending `attemptsSoFar` (so
 * `nextSequenceFor` sees every execution written so far in this call, not just ones already in
 * storage before it started) to pick each new execution's sequence number.
 */
async function executePositions(
  run: BenchmarkRun,
  positions: readonly LogicalAttempt[],
  attemptsSoFar: BenchmarkAttempt[],
  transport: AttemptTransport,
  stopController: StopController,
): Promise<RunExecutionResult> {
  for (const position of positions) {
    if (stopController.isStopped()) {
      await updateBenchmarkRunStatus(run.id, 'stopped');
      return { status: 'stopped' };
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
      await markRecoveryRequired(run.id);
      return { status: 'recovery_required', haltedError: `failed to record dispatch intent: ${dispatchWrite.error}` };
    }
    attemptsSoFar.push(intent);

    if (stopController.isStopped()) {
      // The intent already committed — this position stays `dispatched` (uncertain), exactly
      // as an actual crash would leave it. Never call the transport once Stop has landed.
      await updateBenchmarkRunStatus(run.id, 'stopped');
      return { status: 'stopped' };
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
      await markRecoveryRequired(run.id);
      return { status: 'recovery_required', haltedError: `failed to record terminal result: ${terminalWrite.error}` };
    }
    attemptsSoFar[attemptsSoFar.length - 1] = {
      ...intent,
      ...(transportResult.ok
        ? { status: 'succeeded' as const, responseText: transportResult.responseText, settledAt }
        : { status: 'failed' as const, errorMessage: transportResult.errorMessage, settledAt }),
    };
  }

  await updateBenchmarkRunStatus(run.id, 'completed', { finalizedAt: Date.now() });
  return { status: 'completed' };
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
  const run: BenchmarkRun = {
    id: generateRunId(),
    suiteId: suite.id,
    suite,
    createdAt: Date.now(),
    status: 'running',
    startedAt: Date.now(),
  };
  const created = await createBenchmarkRun(run);
  if (!created.ok) return { ok: false, error: created.error };

  const schedule = buildAttemptSchedule(suite);
  const result = await executePositions(run, schedule, [], transport, stopController);
  return { ok: true, run, result };
}

export interface ResumeRunOutcome {
  ok: boolean;
  result?: RunExecutionResult;
  error?: string;
}

/**
 * Re-attempts only the logical positions that have no terminal execution yet — this covers both
 * positions left `dispatched` (uncertain, from a crash or a prior Stop) and positions never
 * attempted at all. Every position with a genuine terminal success/failure is left completely
 * untouched, and no existing attempt row is edited: each retry is a new execution.
 */
export async function resumeBenchmarkRun(
  runId: string,
  transport: AttemptTransport,
  stopController: StopController = createStopController(),
): Promise<ResumeRunOutcome> {
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
    await updateBenchmarkRunStatus(runId, 'completed', { finalizedAt: Date.now() });
    return { ok: true, result: { status: 'completed' } };
  }

  const resumedStart = await updateBenchmarkRunStatus(runId, 'running', { startedAt: run.startedAt ?? Date.now() });
  if (!resumedStart.ok) return { ok: false, error: resumedStart.error };

  const result = await executePositions(run, pending, [...attempts], transport, stopController);
  return { ok: true, result };
}
