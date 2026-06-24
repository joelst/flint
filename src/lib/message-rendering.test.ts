import { describe, expect, it } from "vitest";
import {
  extractThinkingTrace,
  sanitizeAssistantHtml,
} from "./message-rendering";

describe("extractThinkingTrace", () => {
  it("extracts closed think tags and keeps visible content", () => {
    const input = "<think>reasoning</think>\nFinal answer";
    const result = extractThinkingTrace(input);
    expect(result.visibleContent).toBe("Final answer");
    expect(result.thinkingContent).toEqual(["reasoning"]);
  });

  it("extracts unterminated think tags during streaming", () => {
    const input = "<think>partial reasoning";
    const result = extractThinkingTrace(input);
    expect(result.visibleContent).toBe("");
    expect(result.thinkingContent).toEqual(["partial reasoning"]);
  });
});

describe("sanitizeAssistantHtml", () => {
  it("removes script tags and inline handlers", () => {
    const input =
      '<p onclick="alert(1)">ok</p><script>alert("xss")</script><a href="javascript:alert(1)">bad</a>';
    const output = sanitizeAssistantHtml(input);
    expect(output).toContain("<p>ok</p>");
    expect(output).not.toContain("<script");
    expect(output).not.toContain("onclick");
    expect(output).not.toContain("javascript:");
  });

  it("adds safe anchor attributes", () => {
    const output = sanitizeAssistantHtml('<a href="https://example.com">go</a>');
    expect(output).toContain('target="_blank"');
    expect(output).toContain('rel="noopener noreferrer"');
  });

  it("rejects protocol-relative links", () => {
    const output = sanitizeAssistantHtml('<a href="//evil.example">nope</a>');
    expect(output).not.toContain('href="//evil.example"');
  });

  it("falls back to escaped text when DOM globals are unavailable", () => {
    const originalDomParser = (globalThis as any).DOMParser;
    const originalNodeFilter = (globalThis as any).NodeFilter;

    Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'NodeFilter', { configurable: true, value: undefined });

    try {
      const output = sanitizeAssistantHtml('<script>alert("x")</script><b>ok</b>');
      expect(output).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;b&gt;ok&lt;/b&gt;');
    } finally {
      Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: originalDomParser });
      Object.defineProperty(globalThis, 'NodeFilter', { configurable: true, value: originalNodeFilter });
    }
  });
});
