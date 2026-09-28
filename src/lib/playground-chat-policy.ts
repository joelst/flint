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

export interface ScopedPreparationCount {
  generation: number;
  count: number;
}

export function beginScopedPreparation(
  current: ScopedPreparationCount,
): { next: ScopedPreparationCount; generation: number } {
  return {
    next: { ...current, count: current.count + 1 },
    generation: current.generation,
  };
}

export function resetScopedPreparations(current: ScopedPreparationCount): ScopedPreparationCount {
  return { generation: current.generation + 1, count: 0 };
}

export function settleScopedPreparation(
  current: ScopedPreparationCount,
  generation: number,
): ScopedPreparationCount {
  return generation === current.generation
    ? { ...current, count: Math.max(0, current.count - 1) }
    : current;
}
