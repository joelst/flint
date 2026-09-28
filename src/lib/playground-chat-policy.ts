export type PlaygroundChatTransport = "sidecar" | "direct";

export function selectPlaygroundChatTransport(
  endpoint: string | null | undefined,
  directClientAvailable: boolean,
): PlaygroundChatTransport {
  return endpoint || !directClientAvailable ? "sidecar" : "direct";
}

export function preparationScopeIsCurrent(
  ownerConversation: string | null,
  currentConversation: string | null,
  ownerEpoch: number,
  currentEpoch: number,
): boolean {
  return ownerConversation === currentConversation && ownerEpoch === currentEpoch;
}

export function settlePreparationCount(
  currentCount: number,
  ownerIsCurrent: boolean,
): number {
  return ownerIsCurrent ? Math.max(0, currentCount - 1) : currentCount;
}
