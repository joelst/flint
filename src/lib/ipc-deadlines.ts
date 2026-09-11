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
  getCacheInventory: 30_000,
  // Windows accelerator telemetry has its own 10-second fallback budget.
  poolStatus: 20_000,
  getEps: 10_000,
  // WSL version discovery may use a 15-second subprocess timeout.
  wslStatus: 20_000,
  listModels: 30_000,
  getVisionModels: 30_000,
  getSTTModels: 30_000,
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
  wslEnableMirrored: null,
  wslShutdown: null,
  chatCompletion: null,
  transcribeAudio: null,
  cancelChatRequest: null,
};

export function deadlineForCommand(cmd: string): number | null {
  return (IPC_COMMAND_DEADLINES_MS as Record<string, number | null | undefined>)[cmd] ?? null;
}
