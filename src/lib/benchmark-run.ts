/**
 * Benchmark run/attempt schema, attempt scheduling, and recovery/resume classification.
 *
 * Pure and headless, like `benchmark-suite.ts`. A `BenchmarkRun` is an immutable snapshot of a
 * `BenchmarkSuite` plus run-level bookkeeping; a `BenchmarkAttempt` is one execution of one
 * logical (target, phase, case, repeat) coordinate. Nothing here calls the SDK, touches
 * IndexedDB, or reads a feature flag — that is `benchmark-repository.ts` and (in a later PR)
 * `benchmark-runner.ts` plus UI wiring.
 *
 * Attempt identity is deliberately two-layered:
 *  - `logicalAttemptId` names a *position* in the suite (e.g. "target 0, case 3, repeat 1").
 *    It never changes across retries.
 *  - Each `BenchmarkAttempt.id` names one *execution* of that position. A crash, a Stop, or an
 *    explicit Resume never edits an existing attempt row to make it look like something else
 *    happened — it always adds a new execution with the next `sequence` number. This is what
 *    lets recovery ask "did this logical position ever get a terminal result?" without losing
 *    the history of an interrupted execution that might still be uncertain.
 */

import { benchmarkAttemptCount, isBenchmarkSuite, type BenchmarkSuite } from './benchmark-suite';

export type AttemptPhase = 'warmup' | 'measured';

/**
 * `dispatched` is written before the chat call is made (write-ahead intent) and is the only
 * status an attempt can be left in by a crash or an unacknowledged Stop — it is never rewritten
 * in place to `succeeded`/`failed` on recovery. `succeeded`/`failed` are written only once Flint
 * has durably recorded a real terminal result for that specific execution.
 */
export type AttemptStatus = 'dispatched' | 'succeeded' | 'failed';

export type RunStatus =
  | 'running'
  | 'stopped'
  | 'completed'
  /** A terminal-result write failed mid-run; some execution's outcome may be unrecorded. */
  | 'recovery_required';

/** One position in a suite's schedule: which target, which phase, and (for measured attempts)
 * which case and repeat. Stable across retries — never regenerated with different meaning. */
export interface LogicalAttempt {
  logicalAttemptId: string;
  targetIndex: number;
  phase: AttemptPhase;
  /** `null` for warmups; the case's index within `suite.cases` for measured attempts. */
  caseIndex: number | null;
  /** `null` for warmups; 0-based repeat number for measured attempts. */
  repeatIndex: number | null;
}

export interface BenchmarkRun {
  id: string;
  suiteId: string;
  /** Frozen at run creation. Later edits to the stored suite must never affect this run. */
  suite: BenchmarkSuite;
  createdAt: number;
  status: RunStatus;
  startedAt?: number;
  finalizedAt?: number;
}

export interface AttemptUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface BenchmarkAttempt {
  /** Identifies this one execution. Unique even across retries of the same logical position. */
  id: string;
  runId: string;
  logicalAttemptId: string;
  targetIndex: number;
  phase: AttemptPhase;
  caseIndex: number | null;
  repeatIndex: number | null;
  /** 0 for a position's first execution; incremented for each subsequent Resume retry. */
  sequence: number;
  status: AttemptStatus;
  alias: string;
  requestedVariantId: string | null;
  /** Filled in once the SDK reports which variant actually served the request, if it differs. */
  servedVariantId?: string | null;
  /** Committed before the chat call is dispatched — the write-ahead part of the contract. */
  intentCommittedAt: number;
  sdkCallStartedAt?: number;
  /** Committed only once a terminal (success or failure) result has been durably recorded. */
  settledAt?: number;
  responseText?: string;
  errorMessage?: string;
  usage?: AttemptUsage;
  ttftMs?: number;
}

function warmupLogicalId(targetIndex: number, warmupIndex: number): string {
  return `t${targetIndex}:warmup:${warmupIndex}`;
}

function measuredLogicalId(targetIndex: number, caseIndex: number, repeatIndex: number): string {
  return `t${targetIndex}:c${caseIndex}:r${repeatIndex}`;
}

/**
 * Builds the ordered schedule of logical attempts for a suite: for each target, its warm-ups
 * (once, before any of its cases), then every case repeated `repeatCount` times. This must be
 * the only place that iterates the (target, warmup/case, repeat) space — `benchmarkAttemptCount`
 * is reused (not reimplemented) as a same-suite cross-check so the two can never silently drift.
 */
export function buildAttemptSchedule(suite: BenchmarkSuite): LogicalAttempt[] {
  const schedule: LogicalAttempt[] = [];
  suite.targets.forEach((_target, targetIndex) => {
    for (let warmupIndex = 0; warmupIndex < suite.warmupCount; warmupIndex++) {
      schedule.push({
        logicalAttemptId: warmupLogicalId(targetIndex, warmupIndex),
        targetIndex,
        phase: 'warmup',
        caseIndex: null,
        repeatIndex: null,
      });
    }
    suite.cases.forEach((_case, caseIndex) => {
      for (let repeatIndex = 0; repeatIndex < suite.repeatCount; repeatIndex++) {
        schedule.push({
          logicalAttemptId: measuredLogicalId(targetIndex, caseIndex, repeatIndex),
          targetIndex,
          phase: 'measured',
          caseIndex,
          repeatIndex,
        });
      }
    });
  });
  if (schedule.length !== benchmarkAttemptCount(suite)) {
    // A cross-check, not a normal validation error: this can only mean the schedule builder and
    // `benchmarkAttemptCount` have silently diverged, which is exactly what reusing the helper
    // was supposed to make impossible.
    throw new Error(
      `benchmark schedule length ${schedule.length} does not match benchmarkAttemptCount ${benchmarkAttemptCount(suite)}`,
    );
  }
  return schedule;
}

const TERMINAL_STATUSES: ReadonlySet<AttemptStatus> = new Set(['succeeded', 'failed']);

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * A logical position counts as "settled" once *any* of its executions reached a terminal
 * status. Multiple executions of the same position exist when a Resume re-attempts a position
 * whose earlier execution was left `dispatched` (uncertain) by a crash or a Stop — the earlier,
 * uncertain execution is never deleted or overwritten, only superseded.
 */
export function settledLogicalAttemptIds(attempts: readonly BenchmarkAttempt[]): Set<string> {
  const settled = new Set<string>();
  for (const attempt of attempts) {
    if (isTerminalAttemptStatus(attempt.status)) settled.add(attempt.logicalAttemptId);
  }
  return settled;
}

/**
 * Logical positions from `schedule` that have no terminal execution yet — used both to run a
 * fresh run (all of them) and to compute exactly what an explicit Resume should re-attempt
 * (only these; every position with a genuine terminal success/failure is left untouched).
 */
export function pendingLogicalAttempts(
  schedule: readonly LogicalAttempt[],
  attempts: readonly BenchmarkAttempt[],
): LogicalAttempt[] {
  const settled = settledLogicalAttemptIds(attempts);
  return schedule.filter((entry) => !settled.has(entry.logicalAttemptId));
}

/**
 * Logical positions with a `dispatched` execution but no terminal one — the "uncertain" set a
 * restart/recovery view must show plainly, never silently hide or silently mark failed/succeeded.
 */
export function uncertainLogicalAttemptIds(attempts: readonly BenchmarkAttempt[]): Set<string> {
  const settled = settledLogicalAttemptIds(attempts);
  const uncertain = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.status === 'dispatched' && !settled.has(attempt.logicalAttemptId)) {
      uncertain.add(attempt.logicalAttemptId);
    }
  }
  return uncertain;
}

/** Next `sequence` number to use for a new execution of `logicalAttemptId` — 0 if it has never
 * been attempted, otherwise one past the highest sequence already recorded for it. */
export function nextSequenceFor(
  logicalAttemptId: string,
  attempts: readonly BenchmarkAttempt[],
): number {
  let max = -1;
  for (const attempt of attempts) {
    if (attempt.logicalAttemptId === logicalAttemptId && attempt.sequence > max) {
      max = attempt.sequence;
    }
  }
  return max + 1;
}

const RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['running', 'stopped', 'completed', 'recovery_required']);
const ATTEMPT_PHASES: ReadonlySet<AttemptPhase> = new Set(['warmup', 'measured']);
const ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set(['dispatched', 'succeeded', 'failed']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Defense-in-depth shape check for a run read back from storage — deliberately shallower than
 * `validateBenchmarkSuite` on the embedded snapshot's own fields (that snapshot is re-validated
 * with the real suite validator), but strict about the run-level bookkeeping fields. */
export function isBenchmarkRun(value: unknown): value is BenchmarkRun {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.suiteId)) return false;
  if (!isBenchmarkSuite(v.suite)) return false;
  if ((v.suite as { id: string }).id !== v.suiteId) return false;
  if (!isFiniteNumber(v.createdAt)) return false;
  if (typeof v.status !== 'string' || !RUN_STATUSES.has(v.status as RunStatus)) return false;
  if (v.startedAt !== undefined && !isFiniteNumber(v.startedAt)) return false;
  if (v.finalizedAt !== undefined && !isFiniteNumber(v.finalizedAt)) return false;
  return true;
}

/** Defense-in-depth shape check for an attempt read back from storage. A terminal attempt must
 * carry exactly the outcome fields its status implies — `succeeded` without `responseText`, or
 * `failed` without `errorMessage`, is corrupt data, not a legitimate empty result. */
export function isBenchmarkAttempt(value: unknown): value is BenchmarkAttempt {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.id) || !isNonEmptyString(v.runId) || !isNonEmptyString(v.logicalAttemptId)) return false;
  if (!isFiniteNumber(v.targetIndex) || !Number.isInteger(v.targetIndex) || v.targetIndex < 0) return false;
  if (typeof v.phase !== 'string' || !ATTEMPT_PHASES.has(v.phase as AttemptPhase)) return false;
  if (v.phase === 'warmup') {
    if (v.caseIndex !== null || v.repeatIndex !== null) return false;
  } else {
    if (!isFiniteNumber(v.caseIndex) || !Number.isInteger(v.caseIndex) || (v.caseIndex as number) < 0) return false;
    if (!isFiniteNumber(v.repeatIndex) || !Number.isInteger(v.repeatIndex) || (v.repeatIndex as number) < 0) return false;
  }
  if (!isFiniteNumber(v.sequence) || !Number.isInteger(v.sequence) || v.sequence < 0) return false;
  if (typeof v.status !== 'string' || !ATTEMPT_STATUSES.has(v.status as AttemptStatus)) return false;
  if (!isNonEmptyString(v.alias)) return false;
  if (v.requestedVariantId !== null && !isNonEmptyString(v.requestedVariantId)) return false;
  if (!isFiniteNumber(v.intentCommittedAt)) return false;
  if (v.status === 'succeeded' && typeof v.responseText !== 'string') return false;
  if (v.status === 'failed' && !isNonEmptyString(v.errorMessage)) return false;
  if ((v.status === 'succeeded' || v.status === 'failed') && !isFiniteNumber(v.settledAt)) return false;
  return true;
}
