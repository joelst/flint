import { describe, expect, it } from "vitest";
import {
  conversationImagePreviewPartIndexes,
  extractThinkingTrace,
  messageClipboardText,
  messageTimestamp,
  nonTextMessageParts,
  renderableMessageParts,
  sanitizeAssistantHtml,
} from "./message-rendering";
import { TINY_PNG_DATA_URL, pngDataUrl } from "../../sidecar/test-fixtures/images";

describe("malformed stored message content", () => {
  // The chat view derives preview budgets straight from persisted message objects, so a
  // record missing `content` must not throw: a thrown derived blanks the whole Playground.
  const malformed = [undefined, null, 42, { noType: true }, { type: 7 }] as any[];

  it("never throws while allocating conversation preview budgets", () => {
    expect(() => conversationImagePreviewPartIndexes(malformed)).not.toThrow();
    expect(conversationImagePreviewPartIndexes(malformed)).toEqual([[], [], [], [], []]);
  });

  it("renders malformed content as no parts rather than throwing", () => {
    for (const content of malformed) {
      expect(() => renderableMessageParts(content)).not.toThrow();
      expect(renderableMessageParts(content)).toEqual([]);
      expect(messageClipboardText(content)).toBe("");
    }
  });

  it("keeps surrounding messages renderable when one record is malformed", () => {
    const contents = [
      null,
      [{ type: "image_url", image_url: { url: TINY_PNG_DATA_URL } }],
    ] as any[];
    expect(conversationImagePreviewPartIndexes(contents)).toEqual([[], [0]]);
  });
});

// A single part object where an array is expected is a plausible legacy or hand-edited
// payload. Dropping it renders an apparently empty message, which reads as data loss;
// wrapping it renders what it carries, or labels it undisplayable.
describe("a bare content part stored outside an array", () => {
  it("renders a bare text part", () => {
    expect(renderableMessageParts({ type: "text", text: "stored bare" } as any)).toEqual([
      { type: "text", text: "stored bare" },
    ]);
    expect(messageClipboardText({ type: "text", text: "stored bare" } as any)).toBe("stored bare");
  });

  it("renders a bare image part, and budgets it like any other image", () => {
    const content = { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } } as any;
    expect(conversationImagePreviewPartIndexes([content])).toEqual([[0]]);
    expect(renderableMessageParts(content)).toEqual([
      { type: "image", previewUrl: TINY_PNG_DATA_URL, label: "Attached image" },
    ]);
  });

  it("renders a bare file part", () => {
    const content = { type: "file_text", file: { name: "a.txt", text: "body" } } as any;
    expect(renderableMessageParts(content)).toEqual([
      { type: "file", name: "a.txt", text: "body" },
    ]);
  });

  it("labels a bare part of an unrecognized type rather than dropping it", () => {
    expect(renderableMessageParts({ type: "video_url", video_url: {} } as any)).toEqual([
      { type: "unknown", label: "Attachment this version cannot display" },
    ]);
  });
});

describe("multipart message rendering", () => {
  const content = [
    { type: "text" as const, text: "What is this?" },
    {
      type: "image_url" as const,
      image_url: { url: TINY_PNG_DATA_URL },
    },
  ];

  it("keeps text and safe image previews separate instead of coercing objects", () => {
    expect(renderableMessageParts(content)).toEqual([
      { type: "text", text: "What is this?" },
      {
        type: "image",
        previewUrl: TINY_PNG_DATA_URL,
        label: "Attached image",
      },
    ]);
    expect(JSON.stringify(renderableMessageParts(content))).not.toContain("[object Object]");
  });

  describe("messageTimestamp", () => {
    it("uses a concise time today and exposes the full timestamp", () => {
      const timestamp = new Date(2026, 8, 30, 15, 41, 12).getTime();
      const result = messageTimestamp(timestamp, new Date(2026, 8, 30, 16).getTime(), "en-US");
      expect(result?.label).toBe("3:41 PM");
      expect(result?.title).toContain("Wednesday, September 30, 2026");
      expect(result?.title).toContain("3:41:12 PM");
      expect(result?.datetime).toBe(new Date(timestamp).toISOString());
    });

    it("includes the date for messages from another day", () => {
      const timestamp = new Date(2026, 8, 29, 9, 5).getTime();
      expect(messageTimestamp(timestamp, new Date(2026, 8, 30).getTime(), "en-US")?.label)
        .toBe("Sep 29, 9:05 AM");
    });

    it("rejects absent and invalid timestamps", () => {
      expect(messageTimestamp(undefined)).toBeNull();
      expect(messageTimestamp(Number.NaN)).toBeNull();
    });
  });

  it("copies meaningful text and an attachment marker", () => {
    expect(messageClipboardText(content)).toBe("What is this?\n[Attached image]");
    expect(messageClipboardText("plain text")).toBe("plain text");
  });

  it("does not preview active image formats such as SVG", () => {
    expect(renderableMessageParts([{
      type: "image_url",
      image_url: { url: "data:image/svg+xml;base64,PHN2Zz4=" },
    }])).toEqual([{ type: "image", previewUrl: null, label: "Attached image" }]);
  });

  it("does not hand the webview a stored image it could not safely decode", () => {
    const refused = [
      pngDataUrl(10_000, 10_000), // a few bytes that expand to 400 MB of pixels
      "data:image/png;base64,AQID", // a raster label with no readable header
      "data:image/png;base64," + "A".repeat(350_001), // over the stored-image length bound
    ];
    for (const url of refused) {
      expect(renderableMessageParts([{ type: "image_url", image_url: { url } }]))
        .toEqual([{ type: "image", previewUrl: null, label: "Attached image" }]);
    }
  });

  it("limits image previews across the whole conversation by count and decoded pixels", () => {
    const images = [
      pngDataUrl(4096, 4096),
      pngDataUrl(2000, 2000),
      TINY_PNG_DATA_URL,
      TINY_PNG_DATA_URL,
      TINY_PNG_DATA_URL,
      TINY_PNG_DATA_URL,
    ];
    const contents = images.map((url) => [{
      type: "image_url" as const,
      image_url: { url },
    }]);
    const allowed = conversationImagePreviewPartIndexes(contents);

    expect(allowed.map((indexes, messageIndex) => indexes.length ? messageIndex : -1)
      .filter((index) => index >= 0)).toEqual([2, 3, 4, 5]);
    expect(allowed.flat()).toHaveLength(4);
    expect(renderableMessageParts(contents[0], allowed[0])[0])
      .toEqual({ type: "image", previewUrl: null, label: "Attached image" });

    const manySmallImages = Array.from({ length: 6 }, () => [{
      type: "image_url" as const,
      image_url: { url: TINY_PNG_DATA_URL },
    }]);
    const countLimited = conversationImagePreviewPartIndexes(manySmallImages);
    expect(countLimited.map((indexes, messageIndex) => indexes.length ? messageIndex : -1)
      .filter((index) => index >= 0)).toEqual([2, 3, 4, 5]);
  });

  it("keeps aggregate decoded pixels within budget while favoring the newest image", () => {
    const contents = [pngDataUrl(3000, 3000), pngDataUrl(3000, 3000)].map((url) => [{
      type: "image_url" as const,
      image_url: { url },
    }]);
    expect(conversationImagePreviewPartIndexes(contents)).toEqual([[], [0]]);
  });

  it("renders attached text files as chips and copies their contents", () => {
    const fileContent = [{
      type: "file_text" as const,
      file: { name: "main.ts", text: "export const answer = 42;" },
    }];
    expect(renderableMessageParts(fileContent)).toEqual([{
      type: "file",
      name: "main.ts",
      text: "export const answer = 42;",
    }]);
    expect(messageClipboardText(fileContent))
      .toBe("[Attached file: main.ts]\nexport const answer = 42;");
  });

  it("renders malformed and future parts as an honest placeholder instead of throwing", () => {
    const parts = renderableMessageParts([
      { type: "image_url", image_url: {} } as any,
      { type: "x-flint-unknown", original: { type: "audio_url" } },
    ]);
    expect(parts).toEqual([
      { type: "unknown", label: "Attachment this version cannot display" },
      { type: "unknown", label: "Attachment this version cannot display" },
    ]);
  });

  it("keeps assistant attachments and opaque parts available alongside rendered text", () => {
    const parts = renderableMessageParts([
      { type: "text", text: "Here is the result." },
      { type: "file_text", file: { name: "result.txt", text: "output" } },
      { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
      { type: "future_part", payload: "kept opaque" },
    ] as any);

    expect(parts[0]).toEqual({ type: "text", text: "Here is the result." });
    expect(nonTextMessageParts(parts)).toEqual([
      { type: "file", name: "result.txt", text: "output" },
      { type: "image", previewUrl: TINY_PNG_DATA_URL, label: "Attached image" },
      { type: "unknown", label: "Attachment this version cannot display" },
    ]);
  });
});

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

  it("extracts a closing think tag with no matching opening tag", () => {
    // Some chat templates (e.g. Qwen3-family) inject the opening <think> as part of the
    // prompt prefix fed to the model, so only the closing tag comes back in the response.
    const input = "reasoning steps here\n</think>\n\nFinal answer";
    const result = extractThinkingTrace(input);
    expect(result.visibleContent).toBe("Final answer");
    expect(result.thinkingContent).toEqual(["reasoning steps here"]);
  });

  it("extracts a closing thinking tag with no matching opening tag", () => {
    const input = "some thoughts\n</thinking>\nFinal answer";
    const result = extractThinkingTrace(input);
    expect(result.visibleContent).toBe("Final answer");
    expect(result.thinkingContent).toEqual(["some thoughts"]);
  });

  it("leaves ordinary content untouched when no think tags appear at all", () => {
    const input = "Just a normal answer with no reasoning markers.";
    const result = extractThinkingTrace(input);
    expect(result.visibleContent).toBe(input);
    expect(result.thinkingContent).toEqual([]);
  });

  it("collapses an explicit plain-text thinking section for a reasoning model", () => {
    const input = "Thinking Process:\nInspect the pixels carefully.\n\nFinal Answer: A red square.";
    const result = extractThinkingTrace(input, true);
    expect(result.visibleContent).toBe("A red square.");
    expect(result.thinkingContent).toEqual(["Inspect the pixels carefully."]);
  });

  it("keeps an unfinished explicit thinking section collapsed after streaming", () => {
    const input = "Thinking Process:\nInspect the pixels carefully.";
    const result = extractThinkingTrace(input, true);
    expect(result.visibleContent).toBe("");
    expect(result.thinkingContent).toEqual(["Inspect the pixels carefully."]);
  });

  it("does not reinterpret plain-text headings for a non-reasoning model", () => {
    const input = "Thinking Process:\nThis is ordinary requested prose.";
    const result = extractThinkingTrace(input, false);
    expect(result.visibleContent).toBe(input);
    expect(result.thinkingContent).toEqual([]);
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
