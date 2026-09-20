/**
 * JSON export payload for a completed/interrupted benchmark run — used by the "Export JSON"
 * action on the run-detail view.
 *
 * Pure and deliberately trivial: the only reason this exists as its own module (rather than an
 * inline `JSON.stringify` in `+page.svelte`) is `formatVersion`, so a future PR can change the
 * export shape without silently breaking whatever a user has already saved to disk.
 */

import type { BenchmarkAttempt, BenchmarkRun } from './benchmark-run';

export const BENCHMARK_EXPORT_FORMAT_VERSION = 1;

export interface BenchmarkExport {
  formatVersion: typeof BENCHMARK_EXPORT_FORMAT_VERSION;
  exportedAt: number;
  run: BenchmarkRun;
  attempts: BenchmarkAttempt[];
}

export function buildBenchmarkExport(
  run: BenchmarkRun,
  attempts: readonly BenchmarkAttempt[],
  now: number = Date.now(),
): BenchmarkExport {
  return {
    formatVersion: BENCHMARK_EXPORT_FORMAT_VERSION,
    exportedAt: now,
    run,
    attempts: [...attempts],
  };
}
