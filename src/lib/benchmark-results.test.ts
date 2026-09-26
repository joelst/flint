import { describe, expect, it } from 'vitest';
import { buildRunResultView, formatResponseMs, medianMs, responseTimeMs } from './benchmark-results';
import type { BenchmarkAttempt, BenchmarkRun } from './benchmark-run';
import type { BenchmarkSuite } from './benchmark-suite';

const suite: BenchmarkSuite = {
  id: 'suite-1',
  name: 'Arithmetic',
  createdAt: 1,
  targets: [{ alias: 'model-a', variantId: null }],
  cases: [{ id: 'c1', prompt: '2+2' }, { id: 'c2', prompt: '3+3' }],
  warmupCount: 1,
  repeatCount: 1,
};

function attempt(over: Partial<BenchmarkAttempt> & Pick<BenchmarkAttempt, 'id' | 'logicalAttemptId' | 'phase'>): BenchmarkAttempt {
  const measured = over.phase === 'measured';
  return {
    runId: 'run-1',
    targetIndex: 0,
    caseIndex: measured ? 0 : null,
    repeatIndex: measured ? 0 : null,
    sequence: 0,
    status: 'succeeded',
    alias: 'model-a',
    requestedVariantId: null,
    intentCommittedAt: 1,
    responseText: 'ok',
    settledAt: 150,
    sdkCallStartedAt: 50,
    ...over,
  };
}

describe('responseTimeMs', () => {
  it('prefers the monotonic duration and falls back to wall-clock stamps for older rows', () => {
    expect(responseTimeMs({ sdkCallStartedAt: 200, sdkCallDurationMs: 75, settledAt: 150 })).toBe(75);
    expect(responseTimeMs({ sdkCallStartedAt: 50, settledAt: 150 })).toBe(100);
    expect(responseTimeMs({ sdkCallStartedAt: 200, settledAt: 150 })).toBeNull();
  });

  it('does not invent a duration when the start stamp was never written', () => {
    expect(responseTimeMs({ settledAt: 150 })).toBeNull();
    expect(responseTimeMs({ sdkCallDurationMs: 75, settledAt: 150 })).toBeNull();
    expect(responseTimeMs({ sdkCallStartedAt: Number.NaN, sdkCallDurationMs: 75, settledAt: 150 })).toBeNull();
    expect(responseTimeMs({ sdkCallStartedAt: 50 })).toBeNull();
  });
});

describe('medianMs', () => {
  it('picks the middle value, averaging the two middle values when the count is even', () => {
    expect(medianMs([])).toBeNull();
    expect(medianMs([30, 10, 20])).toBe(20);
    expect(medianMs([10, 40])).toBe(25);
  });
});

describe('formatResponseMs', () => {
  it('rounds for display and leaves a missing duration blank', () => {
    expect(formatResponseMs(10.4)).toBe('10 ms');
    expect(formatResponseMs(null)).toBe('—');
  });
});

describe('buildRunResultView', () => {
  const run = { suite } as Pick<BenchmarkRun, 'suite'>;

  it('splits warmups from measured rows and medians only timed successes', () => {
    const view = buildRunResultView(run, [
      attempt({ id: 'w', logicalAttemptId: 't0:warmup:0', phase: 'warmup', status: 'failed', errorMessage: 'cold', responseText: undefined, sdkCallStartedAt: 0, settledAt: 5 }),
      attempt({ id: 'm1', logicalAttemptId: 't0:c0:r0', phase: 'measured', caseIndex: 0, repeatIndex: 0, sdkCallStartedAt: 10, settledAt: 30, usage: { promptTokens: 4, completionTokens: 1 }, servedVariantId: 'cuda', responseText: '4' }),
      attempt({ id: 'm2', logicalAttemptId: 't0:c1:r0', phase: 'measured', caseIndex: 1, repeatIndex: 0, sdkCallStartedAt: 40, settledAt: 80, responseText: '6' }),
    ]);
    expect(view).toHaveLength(1);
    expect(view[0].warmups.map((row) => row.status)).toEqual(['failed']);
    expect(view[0].measured.map((row) => [row.caseId, row.responseTimeMs, row.responseText])).toEqual([
      ['c1', 20, '4'],
      ['c2', 40, '6'],
    ]);
    expect(view[0].succeededMeasured).toBe(2);
    expect(view[0].medianResponseMs).toBe(30);
    expect(view[0].measured[0].promptTokens).toBe(4);
    expect(view[0].measured[0].servedVariantId).toBe('cuda');
    expect(view[0].warmups[0].responseTimeMs).toBe(5);
  });

  it('omits the median when any succeeded measured row has no start stamp', () => {
    const view = buildRunResultView(run, [
      attempt({ id: 'm1', logicalAttemptId: 't0:c0:r0', phase: 'measured', caseIndex: 0, sdkCallStartedAt: undefined, sdkCallDurationMs: 20, settledAt: 30 }),
      attempt({ id: 'm2', logicalAttemptId: 't0:c1:r0', phase: 'measured', caseIndex: 1, sdkCallStartedAt: 40, settledAt: 80 }),
    ]);
    expect(view[0].succeededMeasured).toBe(2);
    expect(view[0].medianResponseMs).toBeNull();
  });

  it('omits the median when a legacy wall-clock duration moved backward', () => {
    const view = buildRunResultView(run, [
      attempt({ id: 'm1', logicalAttemptId: 't0:c0:r0', phase: 'measured', caseIndex: 0, sdkCallStartedAt: 50, settledAt: 30 }),
      attempt({ id: 'm2', logicalAttemptId: 't0:c1:r0', phase: 'measured', caseIndex: 1, sdkCallStartedAt: 40, settledAt: 80 }),
    ]);
    expect(view[0].measured[0].responseTimeMs).toBeNull();
    expect(view[0].medianResponseMs).toBeNull();
  });

  it('uses the highest-sequence execution and leaves an undispatched position pending', () => {
    const view = buildRunResultView(run, [
      attempt({ id: 'old', logicalAttemptId: 't0:c0:r0', phase: 'measured', caseIndex: 0, sequence: 0, status: 'dispatched', responseText: undefined, settledAt: undefined, sdkCallStartedAt: undefined }),
      attempt({ id: 'new', logicalAttemptId: 't0:c0:r0', phase: 'measured', caseIndex: 0, sequence: 1, responseText: '4', sdkCallStartedAt: 10, settledAt: 20 }),
    ]);
    expect(view[0].measured[0]).toMatchObject({ attemptId: 'new', status: 'succeeded', responseText: '4', responseTimeMs: 10 });
    expect(view[0].measured[1]).toMatchObject({ attemptId: null, caseId: 'c2', status: 'pending', responseTimeMs: null });
    expect(view[0].warmups[0].status).toBe('pending');
  });

  it('does not report a duration for a position still dispatched', () => {
    const view = buildRunResultView(run, [
      attempt({
        id: 'open',
        logicalAttemptId: 't0:c0:r0',
        phase: 'measured',
        caseIndex: 0,
        status: 'dispatched',
        responseText: undefined,
        settledAt: undefined,
        sdkCallStartedAt: 10,
      }),
    ]);
    expect(view[0].measured[0].responseTimeMs).toBeNull();
    expect(view[0].medianResponseMs).toBeNull();
  });
});
