import { describe, expect, it } from "vitest";
import { formatTextAttachmentPrompt } from "./text-attachment-policy";
import { estimateTokens, estimateTokensForMessages } from "./token-estimate";

describe("estimateTokens", () => {
  it("counts nothing for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("grows with length", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("hello world hello world")).toBeGreaterThan(
      estimateTokens("hello world"),
    );
  });

  it("uses the character heuristic for long unbroken text that the word heuristic misses", () => {
    // One "word" of 390 characters: word-based says ~2 tokens, character-based says 100.
    expect(estimateTokens("x".repeat(390))).toBe(100);
  });

  it("uses the word heuristic for many short words", () => {
    // 100 single-character words: character-based says ~52, word-based says 133.
    expect(estimateTokens(Array(100).fill("a").join(" "))).toBe(133);
  });
});

describe("estimateTokensForMessages", () => {
  it("counts string content plus per-message overhead", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(estimateTokensForMessages([{ role: "user", content: text }])).toBe(
      estimateTokens(text) + 2,
    );
  });

  it("counts text parts in an array payload", () => {
    const parts = [
      { type: "text", text: "first half" },
      { type: "text", text: "second half" },
    ];
    expect(estimateTokensForMessages([{ role: "user", content: parts }])).toBe(
      estimateTokens("first half") + estimateTokens("second half") + 2,
    );
  });

  it("charges a flat overhead per image part", () => {
    const withImage = estimateTokensForMessages([
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ]);
    expect(withImage).toBe(500 + 2);
  });

  it("counts a stored file_text part as its framed prompt, not the raw body", () => {
    const file = { name: "add.js", text: "a".repeat(400) };
    const counted = estimateTokensForMessages([
      { role: "user", content: [{ type: "file_text", file }] },
    ]);
    expect(counted).toBe(estimateTokens(formatTextAttachmentPrompt(file)) + 2);
    expect(counted).not.toBe(estimateTokens(file.text) + 2);
    expect(estimateTokensForMessages([
      { role: "user", content: [{ type: "file_text", file: { name: 1, text: file.text } }] },
    ])).toBe(2);
    expect(estimateTokensForMessages([
      { role: "user", content: [{ type: "file_text" }] },
    ])).toBe(2);
    expect(estimateTokensForMessages([
      { role: "user", content: [{ type: "file_text", file: "nope" }] },
    ])).toBe(2);
  });

  it("ignores a text part whose text is not a string", () => {
    expect(
      estimateTokensForMessages([{ role: "user", content: [{ type: "text", text: 42 }] }]),
    ).toBe(2);
  });

  // The meter feeds a `$derived` read by the whole chat view, so a malformed archive record
  // must degrade one number rather than throw the view down.
  it("survives null and non-object parts", () => {
    expect(() =>
      estimateTokensForMessages([
        { role: "user", content: [null, undefined, 7, "loose", { type: "text", text: "kept" }] },
      ]),
    ).not.toThrow();
    expect(
      estimateTokensForMessages([
        { role: "user", content: [null, undefined, 7, "loose", { type: "text", text: "kept" }] },
      ]),
    ).toBe(estimateTokens("kept") + 2);
  });

  it("survives null and non-object messages, still charging their turn overhead", () => {
    expect(estimateTokensForMessages([null, undefined, 3, "loose"])).toBe(6);
  });

  it("charges only overhead for a message with no content", () => {
    expect(estimateTokensForMessages([{ role: "user" }])).toBe(2);
    expect(estimateTokensForMessages([{ role: "user", content: null }])).toBe(2);
  });

  it("estimates an unrecognized object payload from its serialization", () => {
    const payload = { legacy: "some older shape" };
    expect(estimateTokensForMessages([{ role: "user", content: payload }])).toBe(
      estimateTokens(JSON.stringify(payload)) + 2,
    );
  });

  it("counts an unserializable payload as its overhead rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => estimateTokensForMessages([{ role: "user", content: cyclic }])).not.toThrow();
    expect(estimateTokensForMessages([{ role: "user", content: cyclic }])).toBe(2);
  });

  it("returns zero for an empty list and for a non-array argument", () => {
    expect(estimateTokensForMessages([])).toBe(0);
    expect(estimateTokensForMessages(undefined as unknown as unknown[])).toBe(0);
    expect(estimateTokensForMessages(null as unknown as unknown[])).toBe(0);
  });

  it("rounds the per-message overhead up across an odd message count", () => {
    expect(estimateTokensForMessages([{}, {}, {}])).toBe(5);
  });

  it("counts tool-call ids, names, and arguments in addition to content", () => {
    const content = "answer";
    const argumentsText = `https://example.com/${"p".repeat(400)}`;
    const plain = estimateTokensForMessages([{ role: "assistant", content }]);
    const withCall = estimateTokensForMessages([{
      role: "assistant",
      content,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "web_fetch", arguments: argumentsText },
      }],
    }]);
    expect(withCall).toBe(
      plain + estimateTokens(["call-1", "web_fetch", argumentsText].join("\n")),
    );
    const linked = estimateTokensForMessages([{
      role: "tool",
      content,
      tool_call_id: "call-1",
      name: "web_fetch",
    }]);
    expect(linked).toBe(plain + estimateTokens("call-1\nweb_fetch"));
    const namedOnly = estimateTokensForMessages([{
      role: "assistant",
      content,
      name: "web_fetch",
    }]);
    expect(namedOnly).toBe(plain);
    const unnamedTool = estimateTokensForMessages([{
      role: "tool",
      content,
      name: "web_fetch",
    }]);
    expect(unnamedTool).toBe(plain);
  });
});
