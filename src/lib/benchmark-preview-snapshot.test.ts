import { describe, expect, it } from 'vitest';
import {
  applyHistoricalSnapshot,
  applyHistoricalSnapshotError,
  applySummarySnapshot,
  applySummarySnapshotError,
  claimPreviewOwnership,
  createPreviewOwnership,
  emptyPreviewSnapshot,
} from './benchmark-preview-snapshot';
import type { BenchmarkAttempt, BenchmarkRun } from './benchmark-run';
import type { BenchmarkSuite } from './benchmark-suite';

function suite(): BenchmarkSuite {
  return {
    id: 'suite-1',
    name: 'Arithmetic',
    createdAt: 1700000000000,
    targets: [{ alias: 'model-a', variantId: null }],
    cases: [{ id: 'c1', prompt: 'What is 2+2?' }],
    warmupCount: 0,
    repeatCount: 1,
  };
}

function run(status: BenchmarkRun['status'], id = 'run-1'): BenchmarkRun {
  return {
    id,
    suiteId: 'suite-1',
    suite: suite(),
    createdAt: 1700000000000,
    status,
  };
}

function attempt(status: BenchmarkAttempt['status'], id = 'attempt-1'): BenchmarkAttempt {
  return {
    id,
    runId: 'run-1',
    logicalAttemptId: 't0:c0:r0',
    targetIndex: 0,
    phase: 'measured',
    caseIndex: 0,
    repeatIndex: 0,
    sequence: 0,
    status,
    alias: 'model-a',
    requestedVariantId: null,
    intentCommittedAt: 1700000001000,
    ...(status === 'succeeded'
      ? {
          sdkCallStartedAt: 1700000001100,
          sdkCallDurationMs: 25,
          settledAt: 1700000001125,
          responseText: '4',
        }
      : {}),
  };
}

describe('historical benchmark preview snapshot ownership', () => {
  it('keeps a full completion snapshot authoritative when an older summary succeeds later', () => {
    const live = claimPreviewOwnership(createPreviewOwnership(), 'run-1', 'live-summary');
    const summaryToken = live;
    const historical = claimPreviewOwnership(live, 'run-1', 'historical-full');
    const fullToken = historical;
    const completed = run('completed');
    const fullAttempt = attempt('succeeded');

    const afterFull = applyHistoricalSnapshot(
      emptyPreviewSnapshot(),
      historical,
      fullToken,
      completed,
      [fullAttempt],
    );
    const afterLateSummary = applySummarySnapshot(
      afterFull,
      historical,
      summaryToken,
      run('running'),
      [{ ...fullAttempt, status: 'dispatched' }],
    );

    expect(afterLateSummary).toBe(afterFull);
    expect(afterLateSummary.run?.status).toBe('completed');
    expect(afterLateSummary.attempts[0]?.status).toBe('succeeded');
    expect(afterLateSummary.results?.[0]?.measured[0]?.responseText).toBe('4');
  });

  it('replaces an already-published stale nonempty summary when the full read finishes later', () => {
    const live = claimPreviewOwnership(createPreviewOwnership(), 'run-1', 'live-summary');
    const staleAttempt = attempt('dispatched', 'stale-attempt');
    const withSummary = applySummarySnapshot(
      emptyPreviewSnapshot(),
      live,
      live,
      run('running'),
      [staleAttempt],
    );
    const historical = claimPreviewOwnership(live, 'run-1', 'historical-full');
    const completed = run('completed');
    const fullAttempt = attempt('succeeded');

    const afterFull = applyHistoricalSnapshot(
      withSummary,
      historical,
      historical,
      completed,
      [fullAttempt],
    );

    expect(afterFull.run).toBe(completed);
    expect(afterFull.attempts).toEqual([
      expect.objectContaining({ id: 'attempt-1', status: 'succeeded' }),
    ]);
    expect(afterFull.results?.[0]?.measured[0]?.status).toBe('succeeded');
  });

  it('publishes a provisional summary while the historical full read is pending', () => {
    const historical = claimPreviewOwnership(
      createPreviewOwnership(),
      'run-1',
      'historical-full',
    );

    const provisional = applySummarySnapshot(
      emptyPreviewSnapshot(),
      historical,
      historical,
      run('stopped'),
      [attempt('failed')],
    );

    expect(provisional.run?.status).toBe('stopped');
    expect(provisional.attempts[0]?.status).toBe('failed');
    expect(provisional.results).toBeNull();
  });

  it('rejects a summary after the historical full snapshot has published', () => {
    const historical = claimPreviewOwnership(
      createPreviewOwnership(),
      'run-1',
      'historical-full',
    );
    const completed = applyHistoricalSnapshot(
      emptyPreviewSnapshot(),
      historical,
      historical,
      run('completed'),
      [attempt('succeeded')],
    );

    const unchanged = applySummarySnapshot(
      completed,
      historical,
      historical,
      run('running'),
      [attempt('dispatched')],
    );

    expect(unchanged).toBe(completed);
  });

  it('clears a summary failure when the authoritative full read succeeds', () => {
    const live = claimPreviewOwnership(createPreviewOwnership(), 'run-1', 'live-summary');
    const failedSummary = applySummarySnapshotError(
      emptyPreviewSnapshot(),
      live,
      live,
      'Could not refresh run attempts: database unavailable',
    );
    const historical = claimPreviewOwnership(live, 'run-1', 'historical-full');

    const afterFull = applyHistoricalSnapshot(
      failedSummary,
      historical,
      historical,
      run('completed'),
      [attempt('succeeded')],
    );

    expect(afterFull.pollError).toBe('');
    expect(afterFull.resultError).toBe('');
    expect(afterFull.run?.status).toBe('completed');
  });

  it('ignores a summary failure that finishes after the full snapshot', () => {
    const live = claimPreviewOwnership(createPreviewOwnership(), 'run-1', 'live-summary');
    const historical = claimPreviewOwnership(live, 'run-1', 'historical-full');
    const afterFull = applyHistoricalSnapshot(
      emptyPreviewSnapshot(),
      historical,
      historical,
      run('completed'),
      [attempt('succeeded')],
    );

    const afterLateFailure = applySummarySnapshotError(
      afterFull,
      historical,
      live,
      'Could not refresh run attempts: database unavailable',
    );

    expect(afterLateFailure).toBe(afterFull);
    expect(afterLateFailure.pollError).toBe('');
  });

  it('keeps same-run reopen ownership stable so an in-flight coalesced full read can publish', () => {
    const historical = claimPreviewOwnership(
      createPreviewOwnership(),
      'run-1',
      'historical-full',
    );
    const fullToken = historical;
    const reopened = claimPreviewOwnership(historical, 'run-1', 'historical-full');

    expect(reopened).toBe(historical);
    const published = applyHistoricalSnapshot(
      emptyPreviewSnapshot(),
      reopened,
      fullToken,
      run('completed'),
      [attempt('succeeded')],
    );
    expect(published.run?.status).toBe('completed');
  });

  it('rejects an old full read after selection changes', () => {
    const first = claimPreviewOwnership(createPreviewOwnership(), 'run-1', 'historical-full');
    const second = claimPreviewOwnership(first, 'run-2', 'historical-full');
    const initial = emptyPreviewSnapshot();

    const unchanged = applyHistoricalSnapshot(
      initial,
      second,
      first,
      run('completed'),
      [attempt('succeeded')],
    );
    const unchangedAfterError = applyHistoricalSnapshotError(
      unchanged,
      second,
      first,
      'late failure',
    );
    expect(unchanged).toBe(initial);
    expect(unchangedAfterError).toBe(initial);
  });

  it('lets resume reclaim live summary ownership and rejects the prior historical read', () => {
    const historical = claimPreviewOwnership(
      createPreviewOwnership(),
      'run-1',
      'historical-full',
    );
    const live = claimPreviewOwnership(historical, 'run-1', 'live-summary');
    const running = run('running');
    const dispatched = attempt('dispatched');

    const afterStaleFull = applyHistoricalSnapshot(
      emptyPreviewSnapshot(),
      live,
      historical,
      run('stopped'),
      [attempt('failed')],
    );
    const afterLiveSummary = applySummarySnapshot(
      afterStaleFull,
      live,
      live,
      running,
      [dispatched],
    );

    expect(afterLiveSummary.run).toBe(running);
    expect(afterLiveSummary.attempts[0]?.status).toBe('dispatched');
    expect(afterLiveSummary.results).toBeNull();
  });

  it('preserves provisional run details when the full read fails', () => {
    const historical = claimPreviewOwnership(
      createPreviewOwnership(),
      'run-1',
      'historical-full',
    );
    const stale = {
      ...emptyPreviewSnapshot(),
      run: run('running'),
      attempts: [{ ...attempt('dispatched') }],
      pollError: 'old summary failure',
    };

    const failed = applyHistoricalSnapshotError(
      stale,
      historical,
      historical,
      'Could not load results',
    );

    expect(failed).toEqual({
      run: stale.run,
      attempts: stale.attempts,
      results: null,
      resultsRunId: null,
      pollError: '',
      resultError: 'Could not load results',
    });
  });
});
