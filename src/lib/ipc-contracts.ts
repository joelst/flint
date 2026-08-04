export type LaneName = 'chat' | 'audio';

export type SidecarCommand =
  | { cmd: 'init'; appName: string; logLevel: string }
  | { cmd: 'setLogLevel'; level: string }
  | { cmd: 'startService'; port: number; alias?: string; preferredEp?: string; bindAddress?: string }
  | { cmd: 'stopService' }
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
  | { cmd: 'getAccessLog' };

export type SidecarCommandName = SidecarCommand['cmd'];

export const KNOWN_COMMANDS = new Set<SidecarCommandName>([
  'init', 'setLogLevel', 'startService', 'stopService', 'getStatus',
  'listModels', 'download', 'load', 'unload', 'deleteModel', 'getEndpoint',
  'chatCompletion', 'cancelChatRequest', 'transcribeAudio',
  'getEps', 'ensureAccelerators', 'getVisionModels', 'getSTTModels',
  'poolStatus', 'getAccessLog',
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
