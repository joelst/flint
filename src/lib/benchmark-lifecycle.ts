/**
 * Benchmark Preview start/resume coordinator: pin-before-load, alias-only transport,
 * and detached execution. The page binds $state and injects SDK operations.
 */

import { SidecarOperationError } from './operation-outcome';
import { usageFromChatCompletion } from './chat-usage';
import {
  createStopController,
  prepareBenchmarkRun,
  resumeBenchmarkRun,
  startBenchmarkRun,
  type AttemptTransport,
  type AttemptTransportRequest,
  type AttemptTransportResult,
  type StartRunOutcome,
  type StopController,
} from './benchmark-runner';
import { getBenchmarkRun, listAttemptsForRun, updateBenchmarkRunStatus } from './benchmark-repository';
import { pendingTargetIndexes, type BenchmarkAttempt } from './benchmark-run';
import { isBenchmarkSuite, type BenchmarkSuite } from './benchmark-suite';

export type LifecycleOutcome = { ok: true; runId: string } | { ok: false; error: string };

export interface BenchmarkLifecycleHost {
  /** Returns the variant the runtime actually loaded, when the load reply reports one. */
  loadModel(alias: string, variantId: string | null): Promise<string | null | void>;
  pinAliases(aliases: string[]): Promise<void>;
  unpin(): Promise<void>;
  chatCompletion(
    alias: string,
    messages: AttemptTransportRequest['messages'],
    opts: { maxTokens?: number; temperature?: number },
  ): Promise<{
    choices?: Array<{ message?: { content?: unknown } }>;
    servedVariantId?: string | null;
    usage?: unknown;
  }>;
}

export function suiteHasExplicitVariants(
  suite: BenchmarkSuite,
  onlyTargetIndexes?: ReadonlySet<number>,
): boolean {
  return suite.targets.some((t, i) => (onlyTargetIndexes == null || onlyTargetIndexes.has(i)) && t.variantId != null);
}

function targetsToPrepare(suite: BenchmarkSuite, onlyTargetIndexes?: ReadonlySet<number>) {
  return suite.targets.filter((_, i) => onlyTargetIndexes == null || onlyTargetIndexes.has(i));
}

export type PrepareResult = { ok: true } | { ok: false; error: string; stopped?: boolean };

/** Explicit suite variant, else the first served variant already recorded for this target. */
export function boundVariantIdForTarget(
  target: { variantId: string | null },
  targetIndex: number,
  attempts: readonly Pick<BenchmarkAttempt, 'targetIndex' | 'servedVariantId'>[],
): string | null {
  if (target.variantId) return target.variantId;
  for (const attempt of attempts) {
    if (attempt.targetIndex === targetIndex && typeof attempt.servedVariantId === 'string' && attempt.servedVariantId.length > 0) {
      return attempt.servedVariantId;
    }
  }
  return null;
}

export function assertServedVariant(
  alias: string,
  expected: string | null,
  served: string | null,
): { ok: true } | { ok: false; errorMessage: string } {
  if (!expected) return { ok: true };
  if (!served) {
    return {
      ok: false,
      errorMessage: `Response for ${alias} did not report a served variant; expected "${expected}"`,
    };
  }
  if (served !== expected) {
    return {
      ok: false,
      errorMessage:
        `Served variant "${served}" did not match the bound variant "${expected}" for ${alias}`
        + ` — another load likely replaced the pinned variant mid-run`,
    };
  }
  return { ok: true };
}

export async function loadBenchmarkTargets(
  suite: BenchmarkSuite,
  loadModel: BenchmarkLifecycleHost['loadModel'],
  stopController?: StopController,
  onlyTargetIndexes?: ReadonlySet<number>,
  expectedByAlias?: Map<string, string>,
): Promise<PrepareResult> {
  for (const target of targetsToPrepare(suite, onlyTargetIndexes)) {
    if (stopController?.isStopped()) {
      return { ok: false, error: 'Stopped before every target was loaded', stopped: true };
    }
    const bound = expectedByAlias?.get(target.alias) ?? target.variantId;
    try {
      const resolved = await loadModel(target.alias, bound);
      if (typeof resolved === 'string' && resolved.length > 0) {
        const prior = expectedByAlias?.get(target.alias);
        if (prior && prior !== resolved) {
          return {
            ok: false,
            error: `Loaded variant "${resolved}" for ${target.alias} did not match the bound variant "${prior}"`,
          };
        }
        expectedByAlias?.set(target.alias, resolved);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `Could not load ${target.alias}${bound ? ` (${bound})` : ''}: ${message}`,
      };
    }
  }
  return { ok: true };
}

export function createSidecarBenchmarkTransport(
  chatCompletion: BenchmarkLifecycleHost['chatCompletion'],
  expectedByAlias: Map<string, string> = new Map(),
): AttemptTransport {
  return async (request: AttemptTransportRequest): Promise<AttemptTransportResult> => {
    try {
      const res = await chatCompletion(request.alias, request.messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
      const content = res?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        return { ok: false, errorMessage: 'Response had no message content' };
      }
      const servedVariantId = res?.servedVariantId ?? null;
      const expected = request.requestedVariantId ?? expectedByAlias.get(request.alias) ?? null;
      const checked = assertServedVariant(request.alias, expected, servedVariantId);
      if (!checked.ok) return { ok: false, errorMessage: checked.errorMessage };
      if (servedVariantId) expectedByAlias.set(request.alias, servedVariantId);
      return {
        ok: true,
        responseText: content,
        servedVariantId,
        usage: usageFromChatCompletion(res?.usage),
      };
    } catch (e: unknown) {
      if (e instanceof SidecarOperationError && (e.certainty === 'cancelled' || e.certainty === 'unknown')) {
        return {
          ok: false,
          errorMessage: e.message || (e.certainty === 'cancelled' ? 'Runtime is draining' : 'Lost contact with the runtime'),
          haltRun: 'stopped',
        };
      }
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, errorMessage: message };
    }
  };
}

export interface PreparedExecution {
  runId: string;
  stopController: StopController;
  done: Promise<StartRunOutcome>;
  /** Dispatches at or after this timestamp are this session's in-flight work. */
  liveAfter: number;
}

async function pinThenLoad(
  suite: BenchmarkSuite,
  host: BenchmarkLifecycleHost,
  stopController?: StopController,
  onlyTargetIndexes?: ReadonlySet<number>,
  expectedByAlias?: Map<string, string>,
): Promise<PrepareResult> {
  if (stopController?.isStopped()) {
    return { ok: false, error: 'Stopped before targets were pinned', stopped: true };
  }
  const targets = targetsToPrepare(suite, onlyTargetIndexes);
  if (targets.length === 0) return { ok: true };
  const aliases = Array.from(new Set(targets.map((t) => t.alias)));
  let pinError: string | null = null;
  try {
    await host.pinAliases(aliases);
  } catch (e: unknown) {
    pinError = e instanceof Error ? e.message : String(e);
    if (suiteHasExplicitVariants(suite, onlyTargetIndexes)) {
      await host.unpin().catch(() => {});
      return { ok: false, error: `Could not pin targets with explicit variants: ${pinError}` };
    }
  }
  if (stopController?.isStopped()) {
    await host.unpin().catch(() => {});
    return { ok: false, error: 'Stopped before every target was loaded', stopped: true };
  }
  const loaded = await loadBenchmarkTargets(suite, host.loadModel, stopController, onlyTargetIndexes, expectedByAlias);
  if (!loaded.ok) {
    await host.unpin().catch(() => {});
    return loaded;
  }
  return { ok: true };
}

/** Marks a reserved run stopped after preparation fails. IndexedDB `{ ok: false }` is a
 * normal result, not a throw — callers must not `.catch()` it away. */
export async function haltPreparedRun(runId: string, preparationError: string): Promise<string> {
  const halted = await updateBenchmarkRunStatus(runId, 'stopped', { finalizedAt: Date.now() });
  if (!halted.ok) {
    return `${preparationError}; also could not mark the run stopped: ${halted.error}`;
  }
  return preparationError;
}

/** User Stop during pin/load is a successful halt (same shape as the runner), not a failed start.
 * A failed status write is `recovery_required`, matching `haltWith`. */
async function finishPreparedHalt(
  runId: string,
  host: BenchmarkLifecycleHost,
  kind: 'stopped' | 'failed',
  error: string,
): Promise<StartRunOutcome> {
  await host.unpin().catch(() => {});
  if (kind === 'stopped') {
    const halted = await updateBenchmarkRunStatus(runId, 'stopped', { finalizedAt: Date.now() });
    if (!halted.ok) {
      return {
        ok: true,
        result: { status: 'recovery_required', haltedError: `failed to persist run status "stopped": ${halted.error}` },
      };
    }
    return { ok: true, result: { status: 'stopped' } };
  }
  return { ok: false, error: await haltPreparedRun(runId, error) };
}

function inexecutableSuiteError(suite: BenchmarkSuite, action: 'start' | 'resume', runId?: string): string | null {
  if (isBenchmarkSuite(suite)) return null;
  if (action === 'resume') {
    return `benchmark run "${runId}" cannot be resumed: its suite snapshot has duplicate target aliases from before that shape was rejected`;
  }
  return 'cannot start: suite snapshot has duplicate target aliases from before that shape was rejected';
}

export async function startBenchmarkSession(
  suite: BenchmarkSuite,
  host: BenchmarkLifecycleHost,
): Promise<{ ok: true; execution: PreparedExecution } | { ok: false; error: string }> {
  const inexecutable = inexecutableSuiteError(suite, 'start');
  if (inexecutable) return { ok: false, error: inexecutable };

  // Insert the run row before pin/load so putBenchmarkSuiteIfNoRuns / Edit see history for
  // this suite during the long prepare window (a remount resets local lifecycleBusy).
  const prepared = await prepareBenchmarkRun(suite);
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const stopController = createStopController();
  const expectedByAlias = new Map<string, string>();
  const transport = createSidecarBenchmarkTransport(host.chatCompletion, expectedByAlias);
  const runId = prepared.run.id;
  // Pin/load/execute the frozen snapshot, not the caller's object — mutating `suite` while
  // pinAliases is awaiting would otherwise load a different alias set than the run will execute.
  const frozen = prepared.run.suite;
  // Return the controller immediately so Stop is live during unbounded model loads. Pin/load
  // and execution run on `done`; loadModel has no cancel-in-flight API, so Stop is honored
  // between operations (same admission contract as the runner).
  const done = (async (): Promise<StartRunOutcome> => {
    const preparedPin = await pinThenLoad(frozen, host, stopController, undefined, expectedByAlias);
    if (!preparedPin.ok) {
      return finishPreparedHalt(runId, host, preparedPin.stopped ? 'stopped' : 'failed', preparedPin.error);
    }
    if (stopController.isStopped()) {
      return finishPreparedHalt(runId, host, 'stopped', 'Stopped during preparation');
    }
    return startBenchmarkRun(frozen, transport, stopController, prepared.run);
  })();
  // A new run has no leftover dispatched rows; 0 means every intent is this session.
  return { ok: true, execution: { runId, stopController, done, liveAfter: 0 } };
}

export async function resumeBenchmarkSession(
  runId: string,
  host: BenchmarkLifecycleHost,
): Promise<{ ok: true; execution: PreparedExecution } | { ok: false; error: string }> {
  const existing = await getBenchmarkRun(runId);
  if (!existing.ok || !existing.value) {
    return { ok: false, error: existing.error || 'Run not found' };
  }
  const suite = existing.value.suite;
  const inexecutable = inexecutableSuiteError(suite, 'resume', runId);
  if (inexecutable) return { ok: false, error: inexecutable };

  const stopController = createStopController();
  const expectedByAlias = new Map<string, string>();
  const transport = createSidecarBenchmarkTransport(host.chatCompletion, expectedByAlias);
  const liveAfter = Date.now();
  const done = (async (): Promise<StartRunOutcome> => {
    // Same attempt list resumeBenchmarkRun will use. Pin/load only unsettled targets so a
    // deleted completed model cannot fail this prepare and block the remaining retries.
    const attempts = await listAttemptsForRun(runId);
    if (!attempts.ok) return { ok: false, error: attempts.error };
    const rows = attempts.value ?? [];
    for (const [i, target] of suite.targets.entries()) {
      const bound = boundVariantIdForTarget(target, i, rows);
      if (bound) expectedByAlias.set(target.alias, bound);
    }
    const only = new Set(pendingTargetIndexes(suite, rows));
    if (only.size > 0) {
      const preparedPin = await pinThenLoad(suite, host, stopController, only, expectedByAlias);
      if (!preparedPin.ok) {
        return finishPreparedHalt(runId, host, preparedPin.stopped ? 'stopped' : 'failed', preparedPin.error);
      }
    }
    if (stopController.isStopped()) {
      return finishPreparedHalt(runId, host, 'stopped', 'Stopped during preparation');
    }
    return resumeBenchmarkRun(runId, transport, stopController);
  })();
  return { ok: true, execution: { runId, stopController, done, liveAfter } };
}
