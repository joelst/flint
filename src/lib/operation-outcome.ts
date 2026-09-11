/**
 * What Flint knows about an operation that did not return a normal answer.
 *
 * The sidecar is a separate process spoken to over a pipe. When it dies with requests
 * outstanding, every one of them rejects — but they are not all in the same position. A query
 * that was interrupted changed nothing, and asking again costs nothing. A deletion that was
 * interrupted may have already removed the files, and the reply saying so died with the process.
 * Reporting both as "failed" tells the user something false about the second: it invites them to
 * retry an operation that already happened, or to believe a model is still on disk when it is not.
 *
 * So the certainty of an outcome is derived from the command, not from the error. Nothing here
 * retries anything; the point is to describe what is known so that a person can decide.
 */

import type { SidecarCommandName } from './ipc-contracts';

/**
 * Whether running a command can change anything.
 *
 * `query` does not mean "provably free of side effects" — reading the catalog warms caches, and
 * `poolStatus` creates missing usage bookkeeping. It means the observable state a user reasons
 * about is unchanged, so an interrupted one can simply be asked again.
 */
export type OperationEffect = 'query' | 'effectful';

/**
 * Every command, classified explicitly.
 *
 * A `Record` over the command union rather than a set of queries with "everything else is
 * effectful", because the complement cannot tell a command that was deliberately classified from
 * one that was forgotten. Adding a command to `SidecarCommand` without adding it here does not
 * compile.
 */
export const COMMAND_EFFECTS: Record<SidecarCommandName, OperationEffect> = {
  // Snapshots of state the sidecar already holds.
  getStatus: 'query',
  getEndpoint: 'query',
  getAccessLog: 'query',
  getCacheInventory: 'query',
  poolStatus: 'query',
  wslStatus: 'query',
  // Catalog reads. These refresh SDK-internal caches, which is not nothing, but it is not state
  // the user is reasoning about when they ask whether an operation happened.
  listModels: 'query',
  getVisionModels: 'query',
  getSTTModels: 'query',
  // Discovery only. Registering execution providers is `ensureAccelerators`, which is not this.
  getEps: 'query',
  // Filesystem reads.
  inspectModelFolder: 'query',
  getModelTemplate: 'query',

  // Reaches a third-party server, which may bill for the request, consume a single-use URL, or
  // act on it. Flint cannot see any of that, so it cannot promise a repeat is free.
  fetchUrl: 'effectful',

  // Touch the model cache on disk.
  download: 'effectful',
  deleteModel: 'effectful',
  importModelFolder: 'effectful',
  linkModelFolder: 'effectful',
  setModelTemplate: 'effectful',

  // Move the runtime, the service, or model residency.
  init: 'effectful',
  setLogLevel: 'effectful',
  startService: 'effectful',
  stopService: 'effectful',
  stopAndUnload: 'effectful',
  shutdownRuntime: 'effectful',
  load: 'effectful',
  unload: 'effectful',
  ensureAccelerators: 'effectful',
  setEvictionConfig: 'effectful',
  setModelPriorities: 'effectful',
  applyMemorySettings: 'effectful',

  // Reach outside the sidecar entirely and can stop workloads that are not Flint's.
  wslEnableMirrored: 'effectful',
  wslShutdown: 'effectful',

  // Consume a model and produce output.
  chatCompletion: 'effectful',
  transcribeAudio: 'effectful',

  // Records an intent to stop. It does not itself confirm that anything stopped.
  cancelChatRequest: 'effectful',
};

/** What went wrong, in terms of what it proves about delivery. */
export type InterruptionCause =
  /** Never written: the process was gone, or the request could not be serialized. */
  | 'not-dispatched'
  /** The write rejected. Bytes may still have reached the child before it did. */
  | 'write-failed'
  /** The transport stopped waiting after dispatch; the child may still finish later. */
  | 'deadline-expired'
  /** The child died or errored with the request outstanding. */
  | 'connection-lost';

export type OutcomeCertainty =
  /** It did not happen. */
  | 'failed'
  /** It was stopped before it could happen. */
  | 'cancelled'
  /** It may or may not have happened, and Flint cannot tell which. */
  | 'unknown';

/**
 * What is known about an interrupted operation.
 *
 * Only `not-dispatched` establishes that nothing happened, because it is the one case where the
 * request demonstrably never left. A rejected write does not: resolving means the bytes reached
 * the pipe, and rejecting does not mean they failed to, so the write is not evidence either way
 * and the answer falls back to what the command would have done.
 */
export function certaintyFor(cmd: string, cause: InterruptionCause): OutcomeCertainty {
  if (cause === 'not-dispatched') return 'failed';
  return effectOf(cmd) === 'query' ? 'failed' : 'unknown';
}

/**
 * An unrecognised command counts as effectful.
 *
 * The unsafe direction is claiming a mutation did not happen, so a command this module has never
 * heard of is assumed to be able to change something.
 */
export function effectOf(cmd: string): OperationEffect {
  return (COMMAND_EFFECTS as Record<string, OperationEffect | undefined>)[cmd] ?? 'effectful';
}

/**
 * What to go and check, by family.
 *
 * Grouped rather than written per command: thirty bespoke sentences would drift out of step with
 * the code, and the advice genuinely is the same within a family.
 */
function recoveryAdvice(cmd: string): string {
  switch (cmd) {
    case 'download':
    case 'deleteModel':
    case 'importModelFolder':
    case 'linkModelFolder':
      // Deliberately "refresh and check the variant": the model list shows catalog entries with
      // their own cached flags, so an alias still being listed says nothing about whether its
      // files are still on disk.
      return 'Refresh the model list and check whether the affected variant is still downloaded.';
    case 'setModelTemplate':
      return "Reopen the model's prompt template to see which version was saved.";
    case 'startService':
    case 'stopService':
    case 'stopAndUnload':
    case 'shutdownRuntime':
    case 'init':
    case 'setLogLevel':
    case 'load':
    case 'unload':
    case 'ensureAccelerators':
    case 'setEvictionConfig':
    case 'setModelPriorities':
    case 'applyMemorySettings':
      return 'Check Diagnostics for the current runtime and service state before trying again.';
    case 'wslEnableMirrored':
    case 'wslShutdown':
      return 'Check WSL in Settings; this may have affected programs outside Flint.';
    case 'chatCompletion':
    case 'transcribeAudio':
      // Not "nothing was saved": streaming writes each delta into the conversation and autosave
      // persists it, so partial output may already be on disk. Only completion is unconfirmed.
      return 'The model may have run, and any output received before the interruption may already have been kept.';
    case 'fetchUrl':
      return 'The page may have been requested even though Flint never received it.';
    default:
      return '';
  }
}

/** A sentence for the UI, saying what is and is not known. Never blames the user. */
export function describeOutcome(cmd: string, certainty: OutcomeCertainty): string {
  if (certainty === 'cancelled') {
    return 'Stopped before it was sent, so it did not run.';
  }
  if (certainty === 'unknown') {
    const advice = recoveryAdvice(cmd);
    return (
      'Flint lost contact with its runtime before this finished, so it cannot tell whether it ' +
      'took effect. It may have completed, partly completed, or not run at all.' +
      (advice ? ` ${advice}` : '')
    );
  }
  if (effectOf(cmd) === 'effectful') {
    // A multi-step operation reports the step that failed, and the steps before it are not undone.
    return 'This did not complete. Any part of it that had already been done was not undone.';
  }
  return 'This did not complete. Nothing was changed, so it is safe to try again.';
}

/** Carries the certainty alongside the message, so callers can branch on it rather than parse it. */
export class SidecarOperationError extends Error {
  readonly cmd: string;
  readonly certainty: OutcomeCertainty;
  readonly cause?: unknown;

  constructor(cmd: string, certainty: OutcomeCertainty, detail?: string, cause?: unknown) {
    super(
      [describeOutcome(cmd, certainty), detail?.trim()].filter(Boolean).join(' ') ||
        describeOutcome(cmd, certainty),
    );
    this.name = 'SidecarOperationError';
    this.cmd = cmd;
    this.certainty = certainty;
    this.cause = cause;
  }
}

/**
 * True when the outcome is genuinely unknown.
 *
 * The signal a caller needs before deciding whether to go on: an action that follows an uncertain
 * one must not assume the first one failed, because it may well have succeeded.
 */
export function isUncertainOutcome(error: unknown): boolean {
  return error instanceof SidecarOperationError && error.certainty === 'unknown';
}
