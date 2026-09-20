import { describe, expect, it } from 'vitest';
import { buildProgressMatrix, isRunInterrupted, summarizeAttempt, type AttemptSummary } from './benchmark-progress';
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
      logicalAttemptId: 't0:c0:r0',
      targetIndex: 0,
      phase: 'measured',
      caseIndex: 0,
      repeatIndex: 0,
      sequence: 0,
      status: 'succeeded',
    });
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
      expect(target.counts).toEqual({ total: 1, pending: 1, uncertain: 0, succeeded: 0, failed: 0 });
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
    expect(target0.counts).toEqual({ total: 1, pending: 1, uncertain: 0, succeeded: 0, failed: 0 });
    expect(target1.counts).toEqual({ total: 1, pending: 0, uncertain: 0, succeeded: 1, failed: 0 });
  });
});

describe('isRunInterrupted', () => {
  it('treats a persisted "running" status as interrupted, since no process is actually executing it after reload', () => {
    expect(isRunInterrupted({ status: 'running' })).toBe(true);
  });

  it('treats every terminal status as not interrupted', () => {
    expect(isRunInterrupted({ status: 'completed' })).toBe(false);
    expect(isRunInterrupted({ status: 'stopped' })).toBe(false);
    expect(isRunInterrupted({ status: 'recovery_required' })).toBe(false);
  });
});
