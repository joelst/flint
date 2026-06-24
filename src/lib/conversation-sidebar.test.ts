import { describe, expect, it } from "vitest";
import { truncateConversationTitle } from "./conversation-sidebar";

describe("truncateConversationTitle", () => {
  it("returns original when within max length", () => {
    expect(truncateConversationTitle("Short title", 40)).toBe("Short title");
  });

  it("truncates and appends ellipsis when over max length", () => {
    const input = "12345678901234567890123456789012345678901";
    expect(truncateConversationTitle(input, 40)).toBe(
      "123456789012345678901234567890123456789…",
    );
  });
});
