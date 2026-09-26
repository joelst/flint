/**
 * Binds a whole benchmark run to the sidecar generation live when it acquired exclusivity, so a
 * respawn at any later point (a crash between target loads, a stuck IPC recovered by Retry, an
 * explicit Stop & Unload/Quit that races the run, etc.) is detected instead of silently continuing.
 *
 * `sdk.ts` calls already guard themselves against a respawn happening *during* their own single
 * round trip (see `loadModel`'s "Sidecar was replaced while confirming the loaded model"), but
 * that only proves no replacement happened mid-call -- it says nothing about a replacement that
 * already happened *before* the call started. A respawn between two host calls (e.g. between
 * pinning and the first target's load, or between two attempts against an already-loaded target)
 * is invisible to that per-call check: the next call's own dispatch simply succeeds against the
 * new process's fresh state, with none of the run's exclusivity fence, priority pins, or
 * previously-loaded targets still holding there. If the new process happens to resolve the same
 * variant, the run looks indistinguishable from a healthy one while recording invalid
 * measurements. This module is the run-wide check that closes that gap.
 */
import { SidecarOperationError } from './operation-outcome';

export const BENCHMARK_GENERATION_MISMATCH_MESSAGE =
  'The runtime restarted during this benchmark run, so the exclusive admission, pinned priorities, and loaded targets from before the restart no longer hold.';

/**
 * Throws a `SidecarOperationError` with `certainty: 'unknown'` when `current` no longer equals
 * `bound`. Callers should call this both immediately before and immediately after every host
 * operation (load, chat) for the run's whole duration -- before, to fail fast without even
 * attempting an operation known to be against the wrong process; after, because some operations
 * (notably `chatCompletion`) have no per-call generation check of their own and would otherwise
 * complete "successfully" against a replacement process with nobody the wiser. `pinAliases` is a
 * deliberate exception: it only asserts before, not after, since a respawn during the pin call
 * itself is still caught by the very next `loadModel`'s own pre-check before anything is loaded
 * or measured -- it just surfaces as an ordinary preparation failure rather than a chat-attempt
 * `haltRun: 'stopped'`, which is fine because nothing has been measured yet either way.
 *
 * `certainty: 'unknown'` is deliberate: `createSidecarBenchmarkTransport` already recognizes it
 * (alongside `'cancelled'`) and reports `haltRun: 'stopped'` rather than a normal per-attempt
 * failure, so the run stops cleanly instead of recording a measurement taken against a process
 * with none of the run's invariants intact.
 */
export function assertBenchmarkGeneration(current: number, bound: number): void {
  if (current !== bound) {
    throw new SidecarOperationError('benchmarkRun', 'unknown', BENCHMARK_GENERATION_MISMATCH_MESSAGE);
  }
}


