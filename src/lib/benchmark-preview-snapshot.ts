import type { BenchmarkAttempt, BenchmarkRun } from './benchmark-run';
import { summarizeAttempt, type AttemptSummary } from './benchmark-progress';
import { buildRunResultView, type TargetResultView } from './benchmark-results';

export type PreviewSnapshotMode = 'none' | 'live-summary' | 'historical-full';

export interface PreviewSnapshotOwnership {
  generation: number;
  runId: string | null;
  mode: PreviewSnapshotMode;
}

export interface BenchmarkPreviewSnapshot {
  run: BenchmarkRun | null;
  attempts: AttemptSummary[];
  results: TargetResultView[] | null;
  resultsRunId: string | null;
  pollError: string;
  resultError: string;
}

export function createPreviewOwnership(): PreviewSnapshotOwnership {
  return { generation: 0, runId: null, mode: 'none' };
}

export function claimPreviewOwnership(
  current: PreviewSnapshotOwnership,
  runId: string | null,
  mode: PreviewSnapshotMode,
): PreviewSnapshotOwnership {
  if (current.runId === runId && current.mode === mode) return current;
  return { generation: current.generation + 1, runId, mode };
}

function owns(
  current: PreviewSnapshotOwnership,
  token: PreviewSnapshotOwnership,
  mode: PreviewSnapshotMode,
): boolean {
  return current.generation === token.generation
    && current.runId === token.runId
    && current.mode === mode
    && token.mode === mode;
}

function ownsProvisionalSummary(
  previous: BenchmarkPreviewSnapshot,
  current: PreviewSnapshotOwnership,
  token: PreviewSnapshotOwnership,
): boolean {
  if (owns(current, token, 'live-summary')) return true;
  return owns(current, token, 'historical-full')
    && previous.resultsRunId !== token.runId;
}

export function emptyPreviewSnapshot(): BenchmarkPreviewSnapshot {
  return {
    run: null,
    attempts: [],
    results: null,
    resultsRunId: null,
    pollError: '',
    resultError: '',
  };
}

export function applySummarySnapshot(
  previous: BenchmarkPreviewSnapshot,
  current: PreviewSnapshotOwnership,
  token: PreviewSnapshotOwnership,
  run: BenchmarkRun,
  attempts: readonly AttemptSummary[],
): BenchmarkPreviewSnapshot {
  if (!ownsProvisionalSummary(previous, current, token) || run.id !== token.runId) {
    return previous;
  }
  return {
    ...previous,
    run,
    attempts: [...attempts],
    pollError: '',
  };
}

export function applySummarySnapshotError(
  previous: BenchmarkPreviewSnapshot,
  current: PreviewSnapshotOwnership,
  token: PreviewSnapshotOwnership,
  error: string,
): BenchmarkPreviewSnapshot {
  if (!ownsProvisionalSummary(previous, current, token)) return previous;
  return { ...previous, pollError: error };
}

export function applyHistoricalSnapshot(
  previous: BenchmarkPreviewSnapshot,
  current: PreviewSnapshotOwnership,
  token: PreviewSnapshotOwnership,
  run: BenchmarkRun,
  attempts: readonly BenchmarkAttempt[],
): BenchmarkPreviewSnapshot {
  if (!owns(current, token, 'historical-full') || run.id !== token.runId) return previous;
  return {
    run,
    attempts: attempts.map(summarizeAttempt),
    results: buildRunResultView(run, attempts),
    resultsRunId: run.id,
    pollError: '',
    resultError: '',
  };
}

export function applyHistoricalSnapshotError(
  previous: BenchmarkPreviewSnapshot,
  current: PreviewSnapshotOwnership,
  token: PreviewSnapshotOwnership,
  error: string,
): BenchmarkPreviewSnapshot {
  if (!owns(current, token, 'historical-full')) return previous;
  return {
    ...previous,
    results: null,
    resultsRunId: null,
    pollError: '',
    resultError: error,
  };
}
