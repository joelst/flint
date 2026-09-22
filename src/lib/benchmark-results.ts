/**
 * One-shot projection of a finished run's full attempt rows into a results table.
 *
 * Not used by the live progress poll. That path reads attempt summaries so it never
 * clones response text. Response time here is the monotonic transport duration when
 * available, falling back to settledAt - sdkCallStartedAt for older rows — not time to
 * first token. Warmups are listed and excluded from the median. A succeeded row with
 * no timing data suppresses the median rather than averaging a partial set.
 */

import { buildAttemptSchedule, type AttemptStatus, type BenchmarkAttempt, type BenchmarkRun } from './benchmark-run';
import type { BenchmarkSuite } from './benchmark-suite';

export function responseTimeMs(
  attempt: Pick<BenchmarkAttempt, 'sdkCallStartedAt' | 'sdkCallDurationMs' | 'settledAt'>,
): number | null {
  const duration = attempt.sdkCallDurationMs;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) return duration;
  const started = attempt.sdkCallStartedAt;
  const ended = attempt.settledAt;
  if (typeof started !== 'number' || typeof ended !== 'number') return null;
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  const delta = ended - started;
  if (!Number.isFinite(delta)) return null;
  return delta < 0 ? 0 : delta;
}

export function medianMs(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function formatResponseMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

export type ResultRowStatus = AttemptStatus | 'pending';

export interface AttemptResultRow {
  attemptId: string | null;
  logicalAttemptId: string;
  caseId: string | null;
  /** 0-based, null for warmups. */
  repeatIndex: number | null;
  status: ResultRowStatus;
  responseTimeMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  servedVariantId: string | null;
  errorMessage: string | null;
  responseText: string | null;
}

export interface TargetResultView {
  targetIndex: number;
  alias: string;
  measured: AttemptResultRow[];
  warmups: AttemptResultRow[];
  succeededMeasured: number;
  /** Null when nothing succeeded, or any success lacks a start stamp. */
  medianResponseMs: number | null;
}

function tokenCount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function latestByLogicalId(attempts: readonly BenchmarkAttempt[]): Map<string, BenchmarkAttempt> {
  const latest = new Map<string, BenchmarkAttempt>();
  for (const attempt of attempts) {
    const existing = latest.get(attempt.logicalAttemptId);
    if (!existing || attempt.sequence > existing.sequence) latest.set(attempt.logicalAttemptId, attempt);
  }
  return latest;
}

function rowForPosition(
  suite: BenchmarkSuite,
  position: ReturnType<typeof buildAttemptSchedule>[number],
  latest: BenchmarkAttempt | undefined,
): AttemptResultRow {
  const caseId = position.caseIndex == null ? null : (suite.cases[position.caseIndex]?.id ?? null);
  if (!latest) {
    return {
      attemptId: null,
      logicalAttemptId: position.logicalAttemptId,
      caseId,
      repeatIndex: position.repeatIndex,
      status: 'pending',
      responseTimeMs: null,
      promptTokens: null,
      completionTokens: null,
      servedVariantId: null,
      errorMessage: null,
      responseText: null,
    };
  }
  return {
    attemptId: latest.id,
    logicalAttemptId: position.logicalAttemptId,
    caseId,
    repeatIndex: position.repeatIndex,
    status: latest.status,
    responseTimeMs: latest.status === 'dispatched' ? null : responseTimeMs(latest),
    promptTokens: tokenCount(latest.usage?.promptTokens),
    completionTokens: tokenCount(latest.usage?.completionTokens),
    servedVariantId: latest.servedVariantId ?? null,
    errorMessage: latest.errorMessage ?? null,
    responseText: typeof latest.responseText === 'string' ? latest.responseText : null,
  };
}

export function buildRunResultView(
  run: Pick<BenchmarkRun, 'suite'>,
  attempts: readonly BenchmarkAttempt[],
): TargetResultView[] {
  const suite = run.suite;
  const schedule = buildAttemptSchedule(suite);
  const latest = latestByLogicalId(attempts);
  return suite.targets.map((target, targetIndex) => {
    const positions = schedule.filter((position) => position.targetIndex === targetIndex);
    const measured: AttemptResultRow[] = [];
    const warmups: AttemptResultRow[] = [];
    for (const position of positions) {
      const row = rowForPosition(suite, position, latest.get(position.logicalAttemptId));
      if (position.phase === 'warmup') warmups.push(row);
      else measured.push(row);
    }
    const succeeded = measured.filter((row) => row.status === 'succeeded');
    const times = succeeded.map((row) => row.responseTimeMs);
    const medianResponseMs = times.length > 0 && times.every((time) => time !== null)
      ? medianMs(times as number[])
      : null;
    return {
      targetIndex,
      alias: target.alias,
      measured,
      warmups,
      succeededMeasured: succeeded.length,
      medianResponseMs,
    };
  });
}
