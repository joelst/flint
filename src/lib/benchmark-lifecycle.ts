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
import { getBenchmarkRun, updateBenchmarkRunStatus } from './benchmark-repository';
import { isBenchmarkSuite, type BenchmarkSuite } from './benchmark-suite';

export type LifecycleOutcome = { ok: true; runId: string } | { ok: false; error: string };

export interface BenchmarkLifecycleHost {
  loadModel(alias: string, variantId: string | null): Promise<void>;
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

export function suiteHasExplicitVariants(suite: BenchmarkSuite): boolean {
  return suite.targets.some((t) => t.variantId != null);
}

export async function loadBenchmarkTargets(
  suite: BenchmarkSuite,
  loadModel: BenchmarkLifecycleHost['loadModel'],
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const target of suite.targets) {
    try {
      await loadModel(target.alias, target.variantId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `Could not load ${target.alias}${target.variantId ? ` (${target.variantId})` : ''}: ${message}`,
      };
    }
  }
  return { ok: true };
}

export function createSidecarBenchmarkTransport(
  chatCompletion: BenchmarkLifecycleHost['chatCompletion'],
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
      if (request.requestedVariantId && servedVariantId && servedVariantId !== request.requestedVariantId) {
        return {
          ok: false,
          errorMessage:
            `Served variant "${servedVariantId}" did not match the requested variant "${request.requestedVariantId}"`
            + ` for ${request.alias} — another load likely replaced the pinned variant mid-run`,
        };
      }
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
}

async function pinThenLoad(
  suite: BenchmarkSuite,
  host: BenchmarkLifecycleHost,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const aliases = Array.from(new Set(suite.targets.map((t) => t.alias)));
  let pinError: string | null = null;
  try {
    await host.pinAliases(aliases);
  } catch (e: unknown) {
    pinError = e instanceof Error ? e.message : String(e);
    if (suiteHasExplicitVariants(suite)) {
      await host.unpin().catch(() => {});
      return { ok: false, error: `Could not pin targets with explicit variants: ${pinError}` };
    }
  }
  const loaded = await loadBenchmarkTargets(suite, host.loadModel);
  if (!loaded.ok) {
    await host.unpin().catch(() => {});
    return loaded;
  }
  return { ok: true };
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

  const preparedPin = await pinThenLoad(suite, host);
  if (!preparedPin.ok) {
    await updateBenchmarkRunStatus(prepared.run.id, 'stopped', { finalizedAt: Date.now() }).catch(() => {});
    return preparedPin;
  }

  const stopController = createStopController();
  const transport = createSidecarBenchmarkTransport(host.chatCompletion);
  const done = startBenchmarkRun(suite, transport, stopController, prepared.run);
  return { ok: true, execution: { runId: prepared.run.id, stopController, done } };
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

  const preparedPin = await pinThenLoad(suite, host);
  if (!preparedPin.ok) return preparedPin;

  const stopController = createStopController();
  const transport = createSidecarBenchmarkTransport(host.chatCompletion);
  const done = resumeBenchmarkRun(runId, transport, stopController);
  return { ok: true, execution: { runId, stopController, done } };
}
