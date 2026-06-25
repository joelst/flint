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

  it("removes img onerror XSS", () => {
    const output = sanitizeAssistantHtml('<img src="x" onerror="alert(1)">');
    expect(output).not.toContain('onerror');
    expect(output).not.toContain('<img');
  });

  it("strips iframe injection", () => {
    const output = sanitizeAssistantHtml('<iframe src="https://evil.example"></iframe>');
    expect(output).not.toContain('<iframe');
  });

  it("strips svg with onload handler", () => {
    const output = sanitizeAssistantHtml('<svg onload="alert(1)"><rect/></svg>');
    expect(output).not.toContain('<svg');
    expect(output).not.toContain('onload');
  });

  it("strips data: href injection", () => {
    const output = sanitizeAssistantHtml('<a href="data:text/html,<script>alert(1)</script>">click</a>');
    expect(output).not.toContain('data:');
  });

  it("strips meta refresh", () => {
    const output = sanitizeAssistantHtml('<meta http-equiv="refresh" content="0;url=javascript:alert(1)">');
    expect(output).not.toContain('<meta');
  });

  it("strips style tag", () => {
    const output = sanitizeAssistantHtml('<style>body{background:url(javascript:alert(1))}</style>');
    expect(output).not.toContain('<style');
  });

  it("keeps safe anchor attributes and body text", () => {
    const output = sanitizeAssistantHtml('<a href="https://example.com" title="t">go</a>');
    expect(output).toContain('href="https://example.com"');
    expect(output).toContain('title="t"');
    expect(output).toContain('go');
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
