import { describe, expect, it } from 'vitest';
import { buildProgressMatrix, isAttemptSummary, isRunInterrupted, isRunResumable, nextRunPollAction, nextRunPollActionAfterReread, summarizeAttempt, type AttemptSummary } from './benchmark-progress';
import type { BenchmarkAttempt } from './benchmark-run';
import type { BenchmarkSuite } from './benchmark-suite';

const suite = (over: Partial<BenchmarkSuite> = {}): BenchmarkSuite => ({
  id: 'suite-1',
  name: 'Arithmetic',
  createdAt: 1700000000000,
  targets: [{ alias: 'model-a', variantId: null }, { alias: 'model-b', variantId: 'v2' }],
  cases: [{ id: 'c1', prompt: 'What is 2+2?' }, { id: 'c2', prompt: 'What is 3+3?' }],
  warmupCount: 1,
  repeatCount: 1,
  ...over,
});

const attempt = (over: Partial<BenchmarkAttempt> = {}): BenchmarkAttempt => ({
  id: 'exec-1',
  runId: 'run-1',
  logicalAttemptId: 't0:c0:r0',
  targetIndex: 0,
  phase: 'measured',
  caseIndex: 0,
  repeatIndex: 0,
  sequence: 0,
  status: 'dispatched',
  alias: 'model-a',
  requestedVariantId: null,
  intentCommittedAt: 1,
  ...over,
});

describe('summarizeAttempt', () => {
  it('keeps only the fields the progress matrix and polling need, dropping response/usage/error', () => {
    const full = attempt({
      status: 'succeeded',
      responseText: 'four',
      servedVariantId: 'v1',
      usage: { promptTokens: 3, completionTokens: 1 },
      settledAt: 100,
    });
    const summary = summarizeAttempt(full);
    expect(summary).toEqual({
      id: 'exec-1',
      runId: 'run-1',
      logicalAttemptId: 't0:c0:r0',
      targetIndex: 0,
      phase: 'measured',
      caseIndex: 0,
      repeatIndex: 0,
      sequence: 0,
      status: 'succeeded',
      intentCommittedAt: 1,
    });
  });
});

describe('isAttemptSummary', () => {
  const valid: AttemptSummary = {
    id: 'exec-1',
    runId: 'run-1',
    logicalAttemptId: 't0:c0:r0',
    targetIndex: 0,
    phase: 'measured',
    caseIndex: 0,
    repeatIndex: 0,
    sequence: 0,
    status: 'succeeded',
  };

  it('accepts a well-formed measured summary and a well-formed warmup summary', () => {
    expect(isAttemptSummary(valid)).toBe(true);
    expect(isAttemptSummary({ ...valid, phase: 'warmup', caseIndex: null, repeatIndex: null })).toBe(true);
  });

  it('rejects a measured summary with null case/repeat indices, and a warmup with numeric ones', () => {
    // Mirrors isBenchmarkAttempt's invariant: a warmup position has no case/repeat coordinate
    // (both null); a measured position must have both, non-negative. Mixing these is corrupt.
    expect(isAttemptSummary({ ...valid, caseIndex: null, repeatIndex: null })).toBe(false);
    expect(isAttemptSummary({ ...valid, phase: 'warmup', caseIndex: 0, repeatIndex: null })).toBe(false);
    expect(isAttemptSummary({ ...valid, phase: 'warmup', caseIndex: null, repeatIndex: 0 })).toBe(false);
  });

  it('rejects negative case/repeat indices on a measured summary', () => {
    expect(isAttemptSummary({ ...valid, caseIndex: -1 })).toBe(false);
    expect(isAttemptSummary({ ...valid, repeatIndex: -1 })).toBe(false);
  });

  it('rejects non-objects and missing/empty required fields', () => {
    expect(isAttemptSummary(null)).toBe(false);
    expect(isAttemptSummary(undefined)).toBe(false);
    expect(isAttemptSummary('not an object')).toBe(false);
    expect(isAttemptSummary({ ...valid, id: '' })).toBe(false);
    expect(isAttemptSummary({ ...valid, runId: undefined })).toBe(false);
  });

  it('rejects an unrecognized phase or status (e.g. a future-format row)', () => {
    expect(isAttemptSummary({ ...valid, phase: 'cooldown' })).toBe(false);
    expect(isAttemptSummary({ ...valid, status: 'retrying' })).toBe(false);
  });

  it('rejects non-integer or negative numeric fields', () => {
    expect(isAttemptSummary({ ...valid, targetIndex: 1.5 })).toBe(false);
    expect(isAttemptSummary({ ...valid, targetIndex: -1 })).toBe(false);
    expect(isAttemptSummary({ ...valid, sequence: NaN })).toBe(false);
    expect(isAttemptSummary({ ...valid, caseIndex: 1.5 })).toBe(false);
  });

  it('accepts a finite non-negative intentCommittedAt and rejects a malformed one', () => {
    expect(isAttemptSummary({ ...valid, intentCommittedAt: 0 })).toBe(true);
    expect(isAttemptSummary({ ...valid, intentCommittedAt: 1700000001000 })).toBe(true);
    expect(isAttemptSummary({ ...valid, intentCommittedAt: -1 })).toBe(false);
    expect(isAttemptSummary({ ...valid, intentCommittedAt: NaN })).toBe(false);
    expect(isAttemptSummary({ ...valid, intentCommittedAt: Infinity })).toBe(false);
    expect(isAttemptSummary({ ...valid, intentCommittedAt: '1' })).toBe(false);
  });
});

describe('buildProgressMatrix', () => {
  it('marks every position pending when no attempts exist yet', () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const matrix = buildProgressMatrix(s, []);
    expect(matrix).toHaveLength(2);
    for (const target of matrix) {
      expect(target.positions).toHaveLength(1);
      expect(target.positions[0].state).toBe('pending');
      expect(target.counts).toEqual({ total: 1, pending: 1, running: 0, uncertain: 0, succeeded: 0, failed: 0 });
    }
  });

  it('classifies a dispatched-only position (no terminal execution) as uncertain, not pending or failed', () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const summaries: AttemptSummary[] = [summarizeAttempt(attempt({ logicalAttemptId: 't0:c0:r0', status: 'dispatched' }))];
    const matrix = buildProgressMatrix(s, summaries);
    const target0 = matrix.find((t) => t.targetIndex === 0)!;
    expect(target0.positions[0].state).toBe('uncertain');
    expect(target0.positions[0].latestAttemptId).toBe('exec-1');
    expect(target0.counts.uncertain).toBe(1);
    expect(target0.counts.running).toBe(0);
  });

  it('classifies a dispatched position as running while the run is live, not uncertain', () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const summaries: AttemptSummary[] = [summarizeAttempt(attempt({ logicalAttemptId: 't0:c0:r0', status: 'dispatched' }))];
    const matrix = buildProgressMatrix(s, summaries, { live: true });
    const target0 = matrix.find((t) => t.targetIndex === 0)!;
    expect(target0.positions[0].state).toBe('running');
    expect(target0.counts.running).toBe(1);
    expect(target0.counts.uncertain).toBe(0);
  });

  it('keeps pre-session dispatched rows uncertain during a live Resume', () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const old = summarizeAttempt(attempt({ logicalAttemptId: 't0:c0:r0', status: 'dispatched', intentCommittedAt: 10 }));
    const matrix = buildProgressMatrix(s, [old], { live: true, liveAfter: 100 });
    const target0 = matrix.find((t) => t.targetIndex === 0)!;
    expect(target0.positions[0].state).toBe('uncertain');
    expect(target0.counts.uncertain).toBe(1);
    expect(target0.counts.running).toBe(0);
  });

  it('marks only this-session dispatched rows as running when liveAfter is set', () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const leftover = summarizeAttempt(attempt({
      id: 'old',
      logicalAttemptId: 't0:c0:r0',
      status: 'dispatched',
      intentCommittedAt: 10,
    }));
    const current = summarizeAttempt(attempt({
      id: 'new',
      logicalAttemptId: 't1:c0:r0',
      targetIndex: 1,
      alias: 'model-b',
      status: 'dispatched',
      intentCommittedAt: 150,
    }));
    const matrix = buildProgressMatrix(s, [leftover, current], { live: true, liveAfter: 100 });
    expect(matrix.find((t) => t.targetIndex === 0)!.positions[0].state).toBe('uncertain');
    expect(matrix.find((t) => t.targetIndex === 1)!.positions[0].state).toBe('running');
  });

  it('treats a dispatched row with no intentCommittedAt as leftover when liveAfter is set', () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const legacy = summarizeAttempt(attempt({
      logicalAttemptId: 't0:c0:r0',
      status: 'dispatched',
    }));
    delete legacy.intentCommittedAt;
    const matrix = buildProgressMatrix(s, [legacy], { live: true, liveAfter: 100 });
    expect(matrix.find((t) => t.targetIndex === 0)!.positions[0].state).toBe('uncertain');
  });

  it('classifies a succeeded terminal execution as succeeded, and a failed one as failed', () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }, { id: 'c2', prompt: 'y' }] });
    const summaries: AttemptSummary[] = [
      summarizeAttempt(attempt({ id: 'e1', logicalAttemptId: 't0:c0:r0', caseIndex: 0, status: 'succeeded' })),
      summarizeAttempt(attempt({ id: 'e2', logicalAttemptId: 't0:c1:r0', caseIndex: 1, status: 'failed' })),
    ];
    const matrix = buildProgressMatrix(s, summaries);
    const target0 = matrix.find((t) => t.targetIndex === 0)!;
    const byLogicalId = new Map(target0.positions.map((p) => [p.logicalAttemptId, p]));
    expect(byLogicalId.get('t0:c0:r0')!.state).toBe('succeeded');
    expect(byLogicalId.get('t0:c1:r0')!.state).toBe('failed');
  });

  it('picks the resumed (higher-sequence) terminal execution over an earlier uncertain one for the same position', () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const summaries: AttemptSummary[] = [
      summarizeAttempt(attempt({ id: 'e1', logicalAttemptId: 't0:c0:r0', sequence: 0, status: 'dispatched' })),
      summarizeAttempt(attempt({ id: 'e2', logicalAttemptId: 't0:c0:r0', sequence: 1, status: 'succeeded' })),
    ];
    const matrix = buildProgressMatrix(s, summaries);
    const position = matrix.find((t) => t.targetIndex === 0)!.positions[0];
    expect(position.state).toBe('succeeded');
    expect(position.latestAttemptId).toBe('e2');
  });

  it('never lets a different target\'s attempts bleed into this target\'s counts', () => {
    const s = suite({ warmupCount: 0, repeatCount: 1, cases: [{ id: 'c1', prompt: 'x' }] });
    const summaries: AttemptSummary[] = [
      summarizeAttempt(attempt({ id: 'e1', targetIndex: 1, alias: 'model-b', logicalAttemptId: 't1:c0:r0', status: 'succeeded' })),
    ];
    const matrix = buildProgressMatrix(s, summaries);
    const target0 = matrix.find((t) => t.targetIndex === 0)!;
    const target1 = matrix.find((t) => t.targetIndex === 1)!;
    expect(target0.counts).toEqual({ total: 1, pending: 1, running: 0, uncertain: 0, succeeded: 0, failed: 0 });
    expect(target1.counts).toEqual({ total: 1, pending: 0, running: 0, uncertain: 0, succeeded: 1, failed: 0 });
  });
});

describe('nextRunPollAction', () => {
  it('keeps polling while the parent still owns the run, even if the row is already terminal', () => {
    expect(nextRunPollAction({ confirmed: true, ownedNow: true, ownedAtStart: true, status: 'completed' })).toBe('keep');
    expect(nextRunPollAction({ confirmed: false, ownedNow: true, ownedAtStart: true, status: 'running' })).toBe('keep');
  });

  it('re-reads when ownership drops during the tick or the snapshot is still running', () => {
    expect(nextRunPollAction({ confirmed: true, ownedNow: false, ownedAtStart: true, status: 'running' })).toBe('reread');
    expect(nextRunPollAction({ confirmed: true, ownedNow: false, ownedAtStart: false, status: 'running' })).toBe('reread');
    expect(nextRunPollAction({ confirmed: true, ownedNow: false, ownedAtStart: false, status: 'stopped' })).toBe('stop');
  });

  it('after a confirmation read, keeps one extra tick only if this session just released a still-running row', () => {
    expect(nextRunPollActionAfterReread({ ownedNow: false, ownedAtStart: true, status: 'running' })).toBe('keep');
    expect(nextRunPollActionAfterReread({ ownedNow: false, ownedAtStart: true, status: 'completed' })).toBe('stop');
    expect(nextRunPollActionAfterReread({ ownedNow: false, ownedAtStart: false, status: 'running' })).toBe('stop');
    expect(nextRunPollActionAfterReread({ ownedNow: true, ownedAtStart: true, status: 'running' })).toBe('keep');
  });
});

describe('isRunInterrupted', () => {
  it('treats a persisted "running" status as interrupted unless it is the live active run', () => {
    expect(isRunInterrupted({ id: 'run-1', status: 'running' })).toBe(true);
    expect(isRunInterrupted({ id: 'run-1', status: 'running' }, 'run-1')).toBe(false);
    expect(isRunInterrupted({ id: 'run-1', status: 'running' }, 'run-other')).toBe(true);
  });

  it('treats every terminal status as not interrupted', () => {
    expect(isRunInterrupted({ id: 'run-1', status: 'completed' })).toBe(false);
    expect(isRunInterrupted({ id: 'run-1', status: 'stopped' })).toBe(false);
    expect(isRunInterrupted({ id: 'run-1', status: 'recovery_required' })).toBe(false);
  });
});

describe('isRunResumable', () => {
  const run = (over: { id?: string; status?: 'running' | 'stopped' | 'completed' | 'recovery_required'; suite?: BenchmarkSuite } = {}) => ({
    id: 'run-1',
    status: 'running' as const,
    suite: suite(),
    ...over,
  });

  it('allows resume for interrupted, stopped, and recovery_required rows that are not live', () => {
    expect(isRunResumable(run({ status: 'running' }))).toBe(true);
    expect(isRunResumable(run({ status: 'stopped' }))).toBe(true);
    expect(isRunResumable(run({ status: 'recovery_required' }))).toBe(true);
    expect(isRunResumable(run({ status: 'completed' }))).toBe(false);
    expect(isRunResumable(run({ status: 'running' }), 'run-1')).toBe(false);
  });

  it('does not offer Resume for a legacy same-alias/different-variant snapshot', () => {
    const legacy = suite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
      ],
    });
    expect(isRunResumable(run({ status: 'stopped', suite: legacy }))).toBe(false);
  });
});
