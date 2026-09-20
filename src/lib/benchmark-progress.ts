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
import type { BenchmarkSuite } from './benchmark-suite';

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
  };
}

/**
 * `pending`: no execution has been dispatched for this position yet.
 * `uncertain`: an execution was dispatched but nothing terminal was ever recorded for it (a
 *   Stop or a crash left it that way) — must always be shown as uncertain, never silently
 *   folded into `succeeded`/`failed`/`pending`.
 * `succeeded` / `failed`: a terminal execution was durably recorded for this position.
 */
export type PositionState = 'pending' | 'uncertain' | 'succeeded' | 'failed';

export interface ProgressPosition extends LogicalAttempt {
  state: PositionState;
  /** The execution backing this position's current state, if any attempt exists yet. */
  latestAttemptId: string | null;
}

export interface ProgressCounts {
  total: number;
  pending: number;
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
  return { total: 0, pending: 0, uncertain: 0, succeeded: 0, failed: 0 };
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
      else state = 'uncertain';
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
