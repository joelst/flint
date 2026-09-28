import { describe, expect, it } from "vitest";
import {
  preparationScopeIsCurrent,
  selectPlaygroundChatTransport,
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
});
