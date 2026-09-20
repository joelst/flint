import { describe, expect, it, vi } from 'vitest';
import {
  buildAttemptSchedule,
  isBenchmarkAttempt,
  isBenchmarkRun,
  nextSequenceFor,
  pendingLogicalAttempts,
  pendingTargetIndexes,
  settledLogicalAttemptIds,
  uncertainLogicalAttemptIds,
  type BenchmarkAttempt,
  type BenchmarkRun,
} from './benchmark-run';
import { benchmarkAttemptCount, type BenchmarkSuite } from './benchmark-suite';

function suite(over: Partial<BenchmarkSuite> = {}): BenchmarkSuite {
  return {
    id: 'suite-1',
    name: 'Arithmetic',
    createdAt: 1700000000000,
    targets: [
      { alias: 'model-a', variantId: null },
      { alias: 'model-b', variantId: 'model-b-cuda:1' },
    ],
    cases: [
      { id: 'c1', prompt: 'What is 2+2?' },
      { id: 'c2', prompt: 'What is 3+3?' },
    ],
    warmupCount: 1,
    repeatCount: 2,
    ...over,
  };
}

function attempt(over: Partial<BenchmarkAttempt> = {}): BenchmarkAttempt {
  return {
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
    intentCommittedAt: 1700000001000,
    ...over,
  };
}

function run(over: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: 'run-1',
    suiteId: 'suite-1',
    suite: suite(),
    createdAt: 1700000000000,
    status: 'running',
    ...over,
  };
}

describe('buildAttemptSchedule', () => {
  it('matches benchmarkAttemptCount for a variety of suites', () => {
    const suites = [
      suite(),
      suite({ warmupCount: 0, repeatCount: 1 }),
      suite({ targets: [{ alias: 'solo', variantId: null }] }),
      suite({ cases: [{ id: 'only', prompt: 'hi' }], repeatCount: 3 }),
    ];
    for (const s of suites) {
      expect(buildAttemptSchedule(s)).toHaveLength(benchmarkAttemptCount(s));
    }
  });

  it('orders each target\'s warm-ups before its cases, and cases before the next target', () => {
    const schedule = buildAttemptSchedule(suite());
    const target0 = schedule.filter((e) => e.targetIndex === 0);
    const target1 = schedule.filter((e) => e.targetIndex === 1);
    expect(schedule.indexOf(target0[target0.length - 1])).toBeLessThan(schedule.indexOf(target1[0]));
    expect(target0[0].phase).toBe('warmup');
    expect(target0.filter((e) => e.phase === 'warmup')).toHaveLength(1);
    expect(target0.filter((e) => e.phase === 'measured')).toHaveLength(4); // 2 cases * 2 repeats
  });

  it('produces unique, stable logicalAttemptId values', () => {
    const schedule = buildAttemptSchedule(suite());
    const ids = schedule.map((e) => e.logicalAttemptId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives warm-ups a null caseIndex/repeatIndex and measured entries real indices', () => {
    const schedule = buildAttemptSchedule(suite());
    const warmup = schedule.find((e) => e.phase === 'warmup')!;
    expect(warmup.caseIndex).toBeNull();
    expect(warmup.repeatIndex).toBeNull();
    const measured = schedule.find((e) => e.phase === 'measured')!;
    expect(measured.caseIndex).not.toBeNull();
    expect(measured.repeatIndex).not.toBeNull();
  });
});

describe('settledLogicalAttemptIds / pendingLogicalAttempts / uncertainLogicalAttemptIds', () => {
  const schedule = buildAttemptSchedule(suite());

  it('treats a run with no attempts as fully pending', () => {
    expect(pendingLogicalAttempts(schedule, [])).toEqual(schedule);
    expect(settledLogicalAttemptIds([])).toEqual(new Set());
    expect(uncertainLogicalAttemptIds([])).toEqual(new Set());
  });

  it('excludes a logical position from pending once any of its executions is terminal', () => {
    const target = schedule[0];
    const attempts = [attempt({ logicalAttemptId: target.logicalAttemptId, status: 'succeeded', responseText: 'ok', settledAt: 2 })];
    const pending = pendingLogicalAttempts(schedule, attempts);
    expect(pending.find((e) => e.logicalAttemptId === target.logicalAttemptId)).toBeUndefined();
    expect(pending).toHaveLength(schedule.length - 1);
  });

  it('marks a dispatched-only position as uncertain, not pending-and-silent, and not settled', () => {
    const target = schedule[0];
    const attempts = [attempt({ logicalAttemptId: target.logicalAttemptId, status: 'dispatched' })];
    expect(uncertainLogicalAttemptIds(attempts)).toEqual(new Set([target.logicalAttemptId]));
    expect(settledLogicalAttemptIds(attempts)).toEqual(new Set());
    // Still pending: an uncertain (never-terminal) position must remain eligible for Resume.
    expect(pendingLogicalAttempts(schedule, attempts).some((e) => e.logicalAttemptId === target.logicalAttemptId)).toBe(true);
  });

  it('a failed retry after an uncertain dispatch is no longer uncertain, and the position is settled', () => {
    const target = schedule[0];
    const attempts = [
      attempt({ id: 'exec-1', logicalAttemptId: target.logicalAttemptId, sequence: 0, status: 'dispatched' }),
      attempt({ id: 'exec-2', logicalAttemptId: target.logicalAttemptId, sequence: 1, status: 'failed', errorMessage: 'boom', settledAt: 3 }),
    ];
    expect(uncertainLogicalAttemptIds(attempts)).toEqual(new Set());
    expect(settledLogicalAttemptIds(attempts)).toEqual(new Set([target.logicalAttemptId]));
  });

  it('pendingTargetIndexes omits a target whose every position is terminal', () => {
    const s = suite({
      targets: [{ alias: 'model-a', variantId: null }, { alias: 'model-b', variantId: null }],
      warmupCount: 0,
      repeatCount: 1,
      cases: [{ id: 'c1', prompt: 'x' }],
    });
    const t0 = buildAttemptSchedule(s).filter((e) => e.targetIndex === 0);
    const attempts = t0.map((e, i) => attempt({
      id: `exec-t0-${i}`,
      logicalAttemptId: e.logicalAttemptId,
      targetIndex: 0,
      status: 'succeeded',
      responseText: 'ok',
      settledAt: 2,
    }));
    expect(pendingTargetIndexes(s, attempts)).toEqual([1]);
  });

  it('pendingTargetIndexes still includes a target whose only executions are dispatched', () => {
    const s = suite({
      targets: [{ alias: 'model-a', variantId: null }, { alias: 'model-b', variantId: null }],
      warmupCount: 0,
      repeatCount: 1,
      cases: [{ id: 'c1', prompt: 'x' }],
    });
    const t0 = buildAttemptSchedule(s).find((e) => e.targetIndex === 0)!;
    const attempts = [attempt({
      logicalAttemptId: t0.logicalAttemptId,
      targetIndex: 0,
      status: 'dispatched',
    })];
    expect(pendingTargetIndexes(s, attempts)).toEqual([0, 1]);
  });
});

describe('nextSequenceFor', () => {
  it('is 0 for a logical position never attempted', () => {
    expect(nextSequenceFor('t0:c0:r0', [])).toBe(0);
  });

  it('is one past the highest existing sequence for that position, ignoring other positions', () => {
    const attempts = [
      attempt({ logicalAttemptId: 't0:c0:r0', sequence: 0 }),
      attempt({ logicalAttemptId: 't0:c0:r0', sequence: 1 }),
      attempt({ logicalAttemptId: 't0:c0:r1', sequence: 5 }),
    ];
    expect(nextSequenceFor('t0:c0:r0', attempts)).toBe(2);
    expect(nextSequenceFor('t0:c0:r1', attempts)).toBe(6);
  });
});

describe('isBenchmarkRun', () => {
  it('accepts a well-formed run', () => {
    expect(isBenchmarkRun(run())).toBe(true);
  });

  it('rejects a run with an invalid embedded suite snapshot', () => {
    expect(isBenchmarkRun(run({ suite: { ...suite(), cases: [] } }))).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(isBenchmarkRun({ ...run(), status: 'bogus' })).toBe(false);
  });

  it('rejects a run whose suiteId does not match its embedded suite snapshot id', () => {
    expect(isBenchmarkRun(run({ suiteId: 'mismatched-suite-id' }))).toBe(false);
  });

  it('rejects a run whose embedded suite has the legacy duplicate-alias shape by default', () => {
    const legacySuite = suite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
      ],
    });
    expect(isBenchmarkRun(run({ suite: legacySuite }))).toBe(false);
  });

  it('accepts a legacy duplicate-alias run only when read with allowDuplicateAliases', () => {
    const legacySuite = suite({
      targets: [
        { alias: 'model-a', variantId: 'v1' },
        { alias: 'model-a', variantId: 'v2' },
      ],
    });
    const legacyRun = run({ suite: legacySuite });
    expect(isBenchmarkRun(legacyRun)).toBe(false);
    expect(isBenchmarkRun(legacyRun, { allowDuplicateAliases: true })).toBe(true);
  });
});

describe('buildAttemptSchedule cross-check', () => {
  it('proof gate: throws if the schedule length ever diverges from benchmarkAttemptCount', async () => {
    vi.doMock('./benchmark-suite', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./benchmark-suite')>();
      return { ...actual, benchmarkAttemptCount: () => 999 };
    });
    vi.resetModules();
    const { buildAttemptSchedule: buildWithMockedCount } = await import('./benchmark-run');
    expect(() => buildWithMockedCount(suite())).toThrow(/does not match benchmarkAttemptCount/);
    vi.doUnmock('./benchmark-suite');
    vi.resetModules();
  });
});

describe('isBenchmarkAttempt', () => {
  it('accepts a well-formed dispatched attempt', () => {
    expect(isBenchmarkAttempt(attempt())).toBe(true);
  });

  it('rejects a succeeded attempt with no responseText', () => {
    expect(isBenchmarkAttempt(attempt({ status: 'succeeded', settledAt: 2 }))).toBe(false);
  });

  it('accepts a succeeded attempt with a legitimately empty responseText', () => {
    expect(isBenchmarkAttempt(attempt({ status: 'succeeded', responseText: '', settledAt: 2 }))).toBe(true);
  });

  it('rejects a failed attempt with no errorMessage', () => {
    expect(isBenchmarkAttempt(attempt({ status: 'failed', settledAt: 2 }))).toBe(false);
  });

  it('rejects a terminal attempt with no settledAt', () => {
    expect(isBenchmarkAttempt(attempt({ status: 'succeeded', responseText: 'ok' }))).toBe(false);
  });

  it('accepts a well-formed succeeded attempt', () => {
    expect(isBenchmarkAttempt(attempt({ status: 'succeeded', responseText: 'ok', settledAt: 2 }))).toBe(true);
  });

  it('rejects a warmup attempt carrying non-null caseIndex/repeatIndex', () => {
    expect(isBenchmarkAttempt(attempt({ phase: 'warmup', caseIndex: 0, repeatIndex: 0 }))).toBe(false);
  });

  it('rejects a measured attempt with a null caseIndex or repeatIndex', () => {
    expect(isBenchmarkAttempt(attempt({ phase: 'measured', caseIndex: null }))).toBe(false);
    expect(isBenchmarkAttempt(attempt({ phase: 'measured', repeatIndex: null }))).toBe(false);
  });

  it('rejects fractional or negative index/sequence values', () => {
    expect(isBenchmarkAttempt(attempt({ targetIndex: 1.5 }))).toBe(false);
    expect(isBenchmarkAttempt(attempt({ caseIndex: -1 }))).toBe(false);
    expect(isBenchmarkAttempt(attempt({ repeatIndex: 0.5 }))).toBe(false);
    expect(isBenchmarkAttempt(attempt({ sequence: -1 }))).toBe(false);
  });

  it('rejects an attempt missing requestedVariantId entirely (not just null)', () => {
    // `undefined !== null` is true in JS, so the existing null-vs-non-empty-string check
    // already rejects a wholly-missing property; this pins that behavior down explicitly
    // rather than relying on it as an accidental side effect of the null check.
    const { requestedVariantId, ...withoutField } = attempt();
    expect(requestedVariantId).toBeDefined(); // sanity: the field really was present before we dropped it
    expect(isBenchmarkAttempt(withoutField)).toBe(false);
  });
});
