/**
 * JSON export payload for a benchmark run — used by the "Export JSON" action on the run-detail
 * view. Export is available for any run regardless of status, including one still `running`:
 * the caller (`BenchmarkPreview.svelte`'s `exportRun`) reads the run row and its full attempt
 * history in a single IndexedDB transaction, so an in-progress export always reflects one
 * internally-consistent point in time — never a run snapshot paired with a later or earlier set
 * of attempts. Consumers of an export must not assume every run inside it is finalized; check
 * `run.status` before treating attempt counts/results as final.
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
