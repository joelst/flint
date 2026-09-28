export type PlaygroundChatTransport = "sidecar" | "direct" | "unavailable";

export function selectPlaygroundChatTransport(
  runtimeReady: boolean,
  directClientAvailable: boolean,
): PlaygroundChatTransport {
  if (runtimeReady) return "sidecar";
  return directClientAvailable ? "direct" : "unavailable";
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
