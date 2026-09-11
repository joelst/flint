export type LaneName = 'chat' | 'audio';

/** Version of the JSON-lines transport handshake shared with the sidecar. */
export const SIDECAR_PROTOCOL_VERSION = 1;

export type SidecarCommand =
  | { cmd: 'init'; appName: string; logLevel: string }
  | { cmd: 'setLogLevel'; level: string }
  | { cmd: 'startService'; port: number; alias?: string; preferredEp?: string; bindAddress?: string; gateway?: boolean }
  | { cmd: 'stopService' }
  | { cmd: 'stopAndUnload'; drainTimeoutMs?: number }
  | { cmd: 'shutdownRuntime'; drainTimeoutMs?: number }
  | { cmd: 'getStatus' }
  | { cmd: 'listModels' }
  | { cmd: 'download'; alias: string; variantId?: string }
  | { cmd: 'load'; alias: string; lane?: LaneName; variantId?: string }
  | { cmd: 'unload'; alias: string; lane?: LaneName }
  | { cmd: 'deleteModel'; alias: string; variantId?: string }
  | { cmd: 'getEndpoint' }
  | { cmd: 'chatCompletion'; model: string; messages: unknown[]; maxTokens?: number; temperature?: number; preferredEp?: string; stream?: boolean }
  | { cmd: 'cancelChatRequest'; requestId: number }
  | { cmd: 'transcribeAudio'; audioBase64: string; mimeType: string; fileName: string; model: string; language: string; temperature?: number; preferredEp?: string }
  | { cmd: 'getEps' }
  | { cmd: 'ensureAccelerators' }
  | { cmd: 'getVisionModels' }
  | { cmd: 'getSTTModels' }
  | { cmd: 'poolStatus' }
  | { cmd: 'getAccessLog' }
  | { cmd: 'getCacheInventory' }
  | { cmd: 'fetchUrl'; url: string; maxChars?: number }
  | { cmd: 'inspectModelFolder'; folderPath: string }
  | { cmd: 'importModelFolder'; folderPath: string; name: string; publisher?: string; version?: number; promptTemplate?: PromptTemplate }
  | { cmd: 'linkModelFolder'; folderPath: string; name: string; publisher?: string }
  | { cmd: 'getModelTemplate'; name: string }
  | { cmd: 'setModelTemplate'; name: string; promptTemplate: PromptTemplate }
  | { cmd: 'setEvictionConfig'; idleUnloadEnabled?: boolean; idleTimeoutMs?: number; maxResidentEnabled?: boolean; maxResident?: number }
  | { cmd: 'setModelPriorities'; priorities: ModelPriorityEntry[] }
  | { cmd: 'applyMemorySettings'; priorities: ModelPriorityEntry[]; eviction?: Partial<EvictionConfig> }
  | { cmd: 'wslStatus' }
  | { cmd: 'wslEnableMirrored' }
  | { cmd: 'wslShutdown' };

/**
 * How keen Flint is to unload a model when the pool needs to shrink.
 * `pinned` is exempt from eviction entirely; `low` is unloaded before anything else.
 */
export type ModelPriority = 'pinned' | 'normal' | 'low';

export interface ModelPriorityEntry {
  alias: string;
  priority: ModelPriority;
}

/** Bounds how many models stay resident. Both rules are off unless the user turns them on. */
export interface EvictionConfig {
  idleUnloadEnabled: boolean;
  idleTimeoutMs: number;
  maxResidentEnabled: boolean;
  maxResident: number;
}

/** A discoverable execution provider and whether the native runtime can currently use it. */
export interface EpInfo {
  name: string;
  isRegistered: boolean;
}

/** The native result of attempting to register every discoverable accelerator provider. */
export interface EpDownloadResult {
  success: boolean;
  status: string;
  registeredEps: string[];
  failedEps: string[];
}

/** The four turn wrappers Foundry substitutes `{Content}` into when building a prompt. */
export interface PromptTemplate {
  system: string;
  user: string;
  assistant: string;
  prompt: string;
}

export type SidecarCommandName = SidecarCommand['cmd'];

export const KNOWN_COMMANDS = new Set<SidecarCommandName>([
  'init', 'setLogLevel', 'startService', 'stopService', 'stopAndUnload', 'shutdownRuntime', 'getStatus',
  'listModels', 'download', 'load', 'unload', 'deleteModel', 'getEndpoint',
  'chatCompletion', 'cancelChatRequest', 'transcribeAudio',
  'getEps', 'ensureAccelerators', 'getVisionModels', 'getSTTModels',
  'poolStatus', 'getAccessLog', 'fetchUrl',
  'getCacheInventory',
  'inspectModelFolder', 'importModelFolder', 'linkModelFolder',
  'getModelTemplate', 'setModelTemplate',
  'setEvictionConfig', 'setModelPriorities', 'applyMemorySettings',
  'wslStatus', 'wslEnableMirrored', 'wslShutdown',
]);

/**
 * An endpoint profile represents a configured inference endpoint.
 * Auth credentials are intentionally excluded — they must be stored separately
 * in secure storage (OS keychain) and must never be persisted alongside profile metadata.
 */
export interface EndpointProfile {
  id: string;
  name: string;
  type: 'foundry-local' | 'openai-compatible';
  baseUrl: string;
  routingRole: LaneName | 'both';
}
