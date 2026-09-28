import { describe, expect, it } from "vitest";
import {
  beginScopedPreparation,
  preparationScopeIsCurrent,
  resetScopedPreparations,
  selectPlaygroundChatTransport,
  settleScopedPreparation,
  settlePreparationCount,
} from "./playground-chat-policy";

describe("Playground chat policy", () => {
  it("uses sidecar IPC when the runtime is ready without requiring its HTTP service", () => {
    expect(selectPlaygroundChatTransport(true, false)).toBe("sidecar");
  });

  it("prefers ready sidecar IPC over a development client", () => {
    expect(selectPlaygroundChatTransport(true, true)).toBe("sidecar");
  });

  it("uses a direct client only as a runtime-not-ready development fallback", () => {
    expect(selectPlaygroundChatTransport(false, true)).toBe("direct");
    expect(selectPlaygroundChatTransport(false, false)).toBe("unavailable");
  });

  it("retires only preparation work owned by the current composer epoch", () => {
    expect(preparationScopeIsCurrent("conversation-a", "conversation-a", 3, 3)).toBe(true);
    expect(preparationScopeIsCurrent("conversation-a", "conversation-b", 3, 3)).toBe(false);
    expect(preparationScopeIsCurrent("conversation-a", "conversation-a", 3, 4)).toBe(false);
    expect(settlePreparationCount(2, true)).toBe(1);
    expect(settlePreparationCount(1, false)).toBe(1);
  });

  it("does not let a retired classification decrement newer in-flight work", () => {
    let state = { generation: 0, count: 0 };
    const old = beginScopedPreparation(state);
    state = old.next;
    state = resetScopedPreparations(state);
    const current = beginScopedPreparation(state);
    state = current.next;

    state = settleScopedPreparation(state, old.generation);
    expect(state.count).toBe(1);
    state = settleScopedPreparation(state, current.generation);
    expect(state.count).toBe(0);
  });
});
