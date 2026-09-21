import { describe, expect, it } from 'vitest';
import { BENCHMARK_EXPORT_FORMAT_VERSION, buildBenchmarkExport } from './benchmark-export';
import type { BenchmarkAttempt, BenchmarkRun } from './benchmark-run';
import type { BenchmarkSuite } from './benchmark-suite';

const suite: BenchmarkSuite = {
  id: 'suite-1',
  name: 'Arithmetic',
  createdAt: 1,
  targets: [{ alias: 'model-a', variantId: null }],
  cases: [{ id: 'c1', prompt: 'What is 2+2?' }],
  warmupCount: 0,
  repeatCount: 1,
};

const run: BenchmarkRun = {
  id: 'run-1',
  suiteId: suite.id,
  suite,
  createdAt: 1,
  status: 'completed',
  startedAt: 2,
  finalizedAt: 3,
};

const attempt: BenchmarkAttempt = {
  id: 'exec-1',
  runId: 'run-1',
  logicalAttemptId: 't0:c0:r0',
  targetIndex: 0,
  phase: 'measured',
  caseIndex: 0,
  repeatIndex: 0,
  sequence: 0,
  status: 'succeeded',
  alias: 'model-a',
  requestedVariantId: null,
  intentCommittedAt: 1,
  settledAt: 2,
  responseText: 'four',
};

describe('buildBenchmarkExport', () => {
  it('bundles the run, all attempts, a format version, and an export timestamp', () => {
    const exported = buildBenchmarkExport(run, [attempt], 12345);
    expect(exported).toEqual({
      formatVersion: BENCHMARK_EXPORT_FORMAT_VERSION,
      exportedAt: 12345,
      run,
      attempts: [attempt],
    });
  });

  it('copies the attempts array rather than aliasing the caller\'s live array', () => {
    const attempts = [attempt];
    const exported = buildBenchmarkExport(run, attempts, 1);
    attempts.push({ ...attempt, id: 'exec-2' });
    expect(exported.attempts).toHaveLength(1);
  });

  it('defaults exportedAt to the current time when not supplied', () => {
    const before = Date.now();
    const exported = buildBenchmarkExport(run, []);
    const after = Date.now();
    expect(exported.exportedAt).toBeGreaterThanOrEqual(before);
    expect(exported.exportedAt).toBeLessThanOrEqual(after);
  });
});
