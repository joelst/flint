import { describe, expect, it } from "vitest";
import {
  preparationScopeIsCurrent,
  selectPlaygroundChatTransport,
  settlePreparationCount,
} from "./playground-chat-policy";

describe("Playground chat policy", () => {
  it("uses sidecar IPC without an HTTP endpoint or direct development client", () => {
    expect(selectPlaygroundChatTransport(undefined, false)).toBe("sidecar");
  });

  it("prefers sidecar IPC when the HTTP service is available", () => {
    expect(selectPlaygroundChatTransport("http://127.0.0.1:5272", true)).toBe("sidecar");
  });

  it("uses a direct client only as a no-endpoint fallback", () => {
    expect(selectPlaygroundChatTransport(undefined, true)).toBe("direct");
  });

  it("retires only preparation work owned by the current composer epoch", () => {
    expect(preparationScopeIsCurrent("conversation-a", "conversation-a", 3, 3)).toBe(true);
    expect(preparationScopeIsCurrent("conversation-a", "conversation-b", 3, 3)).toBe(false);
    expect(preparationScopeIsCurrent("conversation-a", "conversation-a", 3, 4)).toBe(false);
    expect(settlePreparationCount(2, true)).toBe(1);
    expect(settlePreparationCount(1, false)).toBe(1);
  });
});
