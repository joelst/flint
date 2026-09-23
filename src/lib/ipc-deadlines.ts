import type { SidecarCommandName } from './ipc-contracts';

/**
 * Transport deadlines apply only to finite read-only control-plane queries.
 *
 * Long-running or effectful operations remain unbounded here: timing one out after dispatch
 * would not stop the native work, and the caller could not know whether it took effect.
 */
export const IPC_COMMAND_DEADLINES_MS: Record<SidecarCommandName, number | null> = {
  getStatus: 10_000,
  getEndpoint: 10_000,
  getAccessLog: 10_000,
  getHealthRing: 10_000,
  getCacheInventory: 30_000,
  // Automatic pool telemetry never enters the registration gate: it skips the catalog entirely
  // until a queued `getModels()` read has confirmed the snapshot, and reads loaded state
  // off-queue afterwards. It stays bounded because `refreshModels` awaits it, so an unbounded
  // stalled probe would leave an otherwise successful catalog refresh pending forever.
  poolStatus: 20_000,
  getEps: 10_000,
  // WSL version discovery may use a 15-second subprocess timeout.
  wslStatus: 20_000,
  // These catalog readers can wait behind accelerator registration. That work may download
  // execution providers and is intentionally unbounded, so an outer query deadline would only
  // discard a valid late reply while the native work continues.
  listModels: null,
  getVisionModels: null,
  getSTTModels: null,
  inspectModelFolder: 30_000,
  getModelTemplate: 30_000,

  fetchUrl: null,
  download: null,
  deleteModel: null,
  importModelFolder: null,
  linkModelFolder: null,
  setModelTemplate: null,
  init: null,
  setLogLevel: null,
  startService: null,
  stopService: null,
  stopAndUnload: null,
  shutdownRuntime: null,
  load: null,
  unload: null,
  ensureAccelerators: null,
  setEvictionConfig: null,
  setModelPriorities: null,
  applyMemorySettings: null,
  setBenchmarkExclusive: null,
  wslEnableMirrored: null,
  wslShutdown: null,
  chatCompletion: null,
  transcribeAudio: null,
  embedTexts: null,
  cancelChatRequest: null,
};

export function deadlineForCommand(cmd: string): number | null {
  return (IPC_COMMAND_DEADLINES_MS as Record<string, number | null | undefined>)[cmd] ?? null;
}
