/**
 * Pure projection from a suite's schedule + attempt rows into a per-target progress matrix,
 * for the Benchmark Preview run-detail view.
 *
 * Deliberately reuses `buildAttemptSchedule` from `benchmark-run.ts` as the single source of
 * truth for "what positions exist" instead of re-deriving them here, so the progress view can
 * never silently disagree with the runner about the shape of a suite's schedule.
 *
 * Works over `AttemptSummary` (a lightweight projection of `BenchmarkAttempt`, no response text
 * or usage) rather than full attempt rows, so a live-polling UI never has to clone/diff response
 * bodies for up to 900 attempts on every refresh.
 */

import { buildAttemptSchedule, type BenchmarkAttempt, type BenchmarkRun, type LogicalAttempt } from './benchmark-run';
import { isBenchmarkSuite, type BenchmarkSuite } from './benchmark-suite';

export interface AttemptSummary {
  id: string;
  runId: string;
  logicalAttemptId: string;
  targetIndex: number;
  phase: LogicalAttempt['phase'];
  caseIndex: number | null;
  repeatIndex: number | null;
  sequence: number;
  status: BenchmarkAttempt['status'];
  /** When this execution was write-ahead dispatched. Used to tell this session's in-flight
   * work from leftover `dispatched` rows of a previous Stop/crash. */
  intentCommittedAt?: number;
}

/** Projects a full attempt row down to the fields the progress matrix (and polling) need. */
export function summarizeAttempt(attempt: BenchmarkAttempt): AttemptSummary {
  return {
    id: attempt.id,
    runId: attempt.runId,
    logicalAttemptId: attempt.logicalAttemptId,
    targetIndex: attempt.targetIndex,
    phase: attempt.phase,
    caseIndex: attempt.caseIndex,
    repeatIndex: attempt.repeatIndex,
    sequence: attempt.sequence,
    status: attempt.status,
    intentCommittedAt: attempt.intentCommittedAt,
  };
}

const ATTEMPT_PHASES: ReadonlySet<AttemptSummary['phase']> = new Set(['warmup', 'measured']);
const ATTEMPT_STATUSES: ReadonlySet<AttemptSummary['status']> = new Set(['dispatched', 'succeeded', 'failed']);

/**
 * Shape guard for rows read back from the dedicated `attemptSummaries` store, mirroring
 * `isBenchmarkAttempt`'s validation for the full-attempt store. Unlike a full attempt row, a
 * summary is written and read by the same schema version together (never carried forward from
 * an older format the way a suite/run snapshot can be), but it is still a value coming out of
 * IndexedDB rather than one just constructed in memory — a future format change, direct DB
 * inspection/edit, or partial write must be caught here rather than silently misplacing a
 * position/status in the progress matrix.
 */
export function isAttemptSummary(value: unknown): value is AttemptSummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.runId !== 'string' || v.runId.length === 0) return false;
  if (typeof v.logicalAttemptId !== 'string' || v.logicalAttemptId.length === 0) return false;
  if (typeof v.targetIndex !== 'number' || !Number.isInteger(v.targetIndex) || v.targetIndex < 0) return false;
  if (typeof v.phase !== 'string' || !ATTEMPT_PHASES.has(v.phase as AttemptSummary['phase'])) return false;
  // Mirrors isBenchmarkAttempt's invariant exactly, not just each field in isolation: a warmup
  // position has no case/repeat coordinate at all (both null), while a measured position must
  // have both, non-negative. A summary that mixes these — e.g. a negative index, or a numeric
  // index on a warmup row — is exactly as corrupt as it would be on a full attempt row, and
  // must fail the same way rather than passing because each field looked fine on its own.
  if (v.phase === 'warmup') {
    if (v.caseIndex !== null || v.repeatIndex !== null) return false;
  } else {
    if (typeof v.caseIndex !== 'number' || !Number.isInteger(v.caseIndex) || v.caseIndex < 0) return false;
    if (typeof v.repeatIndex !== 'number' || !Number.isInteger(v.repeatIndex) || v.repeatIndex < 0) return false;
  }
  if (typeof v.sequence !== 'number' || !Number.isInteger(v.sequence) || v.sequence < 0) return false;
  if (typeof v.status !== 'string' || !ATTEMPT_STATUSES.has(v.status as AttemptSummary['status'])) return false;
  if (v.intentCommittedAt !== undefined
    && (typeof v.intentCommittedAt !== 'number' || !Number.isFinite(v.intentCommittedAt) || v.intentCommittedAt < 0)) {
    return false;
  }
  return true;
}

/**
 * `pending`: no execution has been dispatched for this position yet.
 * `running`: a `dispatched` execution from *this* live session (intent after `liveAfter`) —
 *   the chat call is outstanding, not a leftover Stop/crash row.
 * `uncertain`: a `dispatched` execution after the process is gone (Stop/crash) with no
 *   terminal row — must never be folded into `succeeded`/`failed`/`pending`.
 * `succeeded` / `failed`: a terminal execution was durably recorded for this position.
 */
export type PositionState = 'pending' | 'running' | 'uncertain' | 'succeeded' | 'failed';

export interface ProgressPosition extends LogicalAttempt {
  state: PositionState;
  /** The execution backing this position's current state, if any attempt exists yet. */
  latestAttemptId: string | null;
}

export interface ProgressCounts {
  total: number;
  pending: number;
  running: number;
  uncertain: number;
  succeeded: number;
  failed: number;
}

export interface TargetProgress {
  targetIndex: number;
  positions: ProgressPosition[];
  counts: ProgressCounts;
}

function emptyCounts(): ProgressCounts {
  return { total: 0, pending: 0, running: 0, uncertain: 0, succeeded: 0, failed: 0 };
}

/**
 * Builds one row of progress per target, in schedule order. A logical position can have more
 * than one execution (a Resume retry after an uncertain/dispatched attempt); the invariant this
 * relies on (enforced by `benchmark-runner.ts`) is that a position only ever gets a new
 * execution while it is *not yet* terminal, so the terminal execution — when one exists — is
 * always the highest-`sequence` execution recorded for that position. Picking the
 * highest-sequence execution per position is therefore equivalent to picking its terminal one
 * whenever a terminal one exists, and its most recent uncertain one otherwise.
 */
export function buildProgressMatrix(
  suite: Pick<BenchmarkSuite, 'targets' | 'cases' | 'warmupCount' | 'repeatCount'>,
  attempts: readonly AttemptSummary[],
  opts: { live?: boolean; liveAfter?: number | null } = {},
): TargetProgress[] {
  const schedule = buildAttemptSchedule(suite as BenchmarkSuite);

  const latestByLogicalId = new Map<string, AttemptSummary>();
  for (const attempt of attempts) {
    const existing = latestByLogicalId.get(attempt.logicalAttemptId);
    if (!existing || attempt.sequence > existing.sequence) {
      latestByLogicalId.set(attempt.logicalAttemptId, attempt);
    }
  }

  const byTarget = new Map<number, ProgressPosition[]>();
  for (const position of schedule) {
    const latest = latestByLogicalId.get(position.logicalAttemptId) ?? null;
    let state: PositionState = 'pending';
    if (latest) {
      if (latest.status === 'succeeded') state = 'succeeded';
      else if (latest.status === 'failed') state = 'failed';
      else {
        // `live` alone is the whole historical run. Resume pin/load still owns the run while
        // leftover dispatched rows from the previous Stop/crash sit in storage — only intents
        // committed at/after this session's liveAfter are actually in flight.
        const fromThisSession = opts.liveAfter == null
          ? !!opts.live
          : (latest.intentCommittedAt ?? 0) >= opts.liveAfter;
        state = opts.live && fromThisSession ? 'running' : 'uncertain';
      }
    }
    const entry: ProgressPosition = { ...position, state, latestAttemptId: latest?.id ?? null };
    const forTarget = byTarget.get(position.targetIndex) ?? [];
    forTarget.push(entry);
    byTarget.set(position.targetIndex, forTarget);
  }

  return suite.targets.map((_target, targetIndex) => {
    const positions = byTarget.get(targetIndex) ?? [];
    const counts = positions.reduce((acc, p) => {
      acc.total++;
      acc[p.state]++;
      return acc;
    }, emptyCounts());
    return { targetIndex, positions, counts };
  });
}

/**
 * A run read back from storage with status `'running'` is never still actually executing —
 * the process that was running it is gone (this is a fresh page load/hydration), so its only
 * possible meanings are "crashed mid-run" or "closed while a Stop/terminal write was in
 * flight." The UI must always label it as interrupted and offer Resume, never silently treat
 * a persisted `'running'` row as a live, in-progress run.
 */
export function isRunInterrupted(
  run: Pick<BenchmarkRun, 'id' | 'status'>,
  activeRunId?: string | null,
): boolean {
  return run.status === 'running' && run.id !== activeRunId;
}

/**
 * Live polling is parent ownership, not persisted `running`. A tick that started while we
 * owned the run can still hold the pre-final `running` snapshot after the parent has
 * cleared activeRunId — re-read before stopping so Resume is not offered on a completed run.
 */
export function nextRunPollAction(opts: {
  confirmed: boolean;
  ownedNow: boolean;
  ownedAtStart: boolean;
  status: BenchmarkRun['status'] | null | undefined;
}): 'keep' | 'reread' | 'stop' {
  if (!opts.confirmed) return 'keep';
  if (opts.ownedNow) return 'keep';
  if (opts.ownedAtStart || opts.status === 'running') return 'reread';
  return 'stop';
}

/** After the confirmation read: keep one extra tick if this session just released a
 * still-`running` row (status write may still be in flight). Follow-up ticks are not
 * owned-at-start and stop even if storage is still `running` (crash leftover). */
export function nextRunPollActionAfterReread(opts: {
  ownedNow: boolean;
  ownedAtStart: boolean;
  status: BenchmarkRun['status'] | null | undefined;
}): 'keep' | 'stop' {
  if (opts.ownedNow) return 'keep';
  if (opts.ownedAtStart && opts.status === 'running') return 'keep';
  return 'stop';
}

/** Positions remain to retry: interrupted running, user Stop, or a durability halt.
 * A legacy same-alias/different-variant snapshot is readable but not executable — Resume
 * would re-dispatch through the alias-only transport and attribute the last-loaded variant. */
export function isRunResumable(
  run: Pick<BenchmarkRun, 'id' | 'status' | 'suite'>,
  activeRunId?: string | null,
): boolean {
  if (run.id === activeRunId) return false;
  if (!isBenchmarkSuite(run.suite)) return false;
  return run.status === 'running' || run.status === 'stopped' || run.status === 'recovery_required';
}
