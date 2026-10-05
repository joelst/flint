import { describe, expect, it } from "vitest";
import {
  conversationImagePreviewPartIndexes,
  extractThinkingTrace,
  modelPrefillsThink,
  assistantClipboardText,
  presentAssistantText,
  replyUsesPrefilledThink,
  stripChatTemplateSpill,
  messageClipboardText,
  messageTimestamp,
  millisecondsUntilNextLocalDay,
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

  describe("millisecondsUntilNextLocalDay", () => {
    it("schedules the refresh just after the next local midnight", () => {
      const now = new Date(2026, 8, 30, 23, 59, 59, 500).getTime();
      expect(millisecondsUntilNextLocalDay(now)).toBe(600);
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

describe("modelPrefillsThink", () => {
  it("matches Qwen3-family and QwQ aliases only", () => {
    expect(modelPrefillsThink("qwen3.5-9b")).toBe(true);
    expect(modelPrefillsThink("qwen3-4b")).toBe(true);
    expect(modelPrefillsThink("qwen3-vl-8b")).toBe(true);
    expect(modelPrefillsThink("qwq-32b")).toBe(true);
    expect(modelPrefillsThink("qwen2.5-7b")).toBe(false);
    expect(modelPrefillsThink("phi-4-mini-reasoning")).toBe(false);
    expect(modelPrefillsThink("")).toBe(false);
  });
});

describe("replyUsesPrefilledThink", () => {
  it("leaves an unstamped reply unchanged instead of using the model selected now", () => {
    expect(replyUsesPrefilledThink({ stamped: false })).toBe(false);
  });

  it("trusts the stamp stored when the reply was produced", () => {
    expect(replyUsesPrefilledThink({ stamped: true })).toBe(true);
  });

  it("shows a stamped error instead of an unclosed thinking trace", () => {
    expect(replyUsesPrefilledThink({ stamped: true, isError: true })).toBe(false);
    expect(replyUsesPrefilledThink({ stamped: true, isError: false })).toBe(true);
  });
});

describe("stripChatTemplateSpill", () => {
  it("drops role lines between a think close and the answer, and a trailing run", () => {
    const text = [
      "The user is asking about the Chicago Cubs.",
      "</think>",
      "",
      "user",
      "",
      "user",
      "",
      "Based on my search, the 2021 record was 74 and 88.",
      "Ask the user before treating that as official.",
      "",
      "user",
      "",
      "system",
      "",
      "assistant",
    ].join("\n");
    const stripped = stripChatTemplateSpill(text);
    expect(stripped).toContain("The user is asking about the Chicago Cubs.");
    expect(stripped).toContain("Based on my search, the 2021 record was 74 and 88.");
    expect(stripped).toContain("Ask the user before treating that as official.");
    expect(stripped).not.toMatch(/^user$/m);
    expect(stripped).not.toMatch(/^system$/m);
    expect(stripped).not.toMatch(/^assistant$/m);
  });

  it("keeps one role word between sentences and inside a code fence", () => {
    const text = [
      "The label below is data.",
      "",
      "user",
      "",
      "It stays.",
      "",
      "```",
      "user",
      "```",
    ].join("\n");
    expect(stripChatTemplateSpill(text)).toBe(text);
  });

  it("keeps a reply that is only the word user", () => {
    expect(stripChatTemplateSpill("user")).toBe("user");
  });

  it("removes the template markers the decoder usually drops", () => {
    expect(stripChatTemplateSpill("hello<|im_end|>\n<|im_start|>user")).toBe("hello");
  });

  it("keeps template markers inside a code fence", () => {
    const fenced = ["```", "token <|im_start|> <|im_end|> <|endoftext|>", "```"].join("\n");
    expect(stripChatTemplateSpill(fenced)).toBe(fenced);
    expect(stripChatTemplateSpill("hello<|endoftext|>\n<|im_start|>user")).toBe("hello");
  });

  it("keeps a role line and template markers inside a tilde fence", () => {
    const fenced = [
      "~~~",
      "user",
      "token <|im_start|> <|im_end|> <|endoftext|>",
      "~~~",
    ].join("\n");
    expect(stripChatTemplateSpill(fenced)).toBe(fenced);
    expect(stripChatTemplateSpill("~~~\n<|im_end|>\nuser")).toBe("~~~\n<|im_end|>\nuser");
  });

  it("keeps a role line and template markers inside a four-backtick fence that contains a triple-backtick line", () => {
    const fenced = [
      "````",
      "```",
      "user",
      "token <|im_start|> <|im_end|> <|endoftext|>",
      "```",
      "````",
    ].join("\n");
    expect(stripChatTemplateSpill(fenced)).toBe(fenced);
  });

  it("does not let a backtick fence close a tilde fence", () => {
    const fenced = [
      "~~~",
      "```",
      "inside",
      "```",
      "user",
      "token <|im_start|> <|im_end|> <|endoftext|>",
      "~~~",
    ].join("\n");
    expect(stripChatTemplateSpill(fenced)).toBe(fenced);
  });

  it("keeps markers when an info string does not close the fence and a longer run does", () => {
    const fenced = [
      "~~~lang",
      "```js",
      "user",
      "token <|im_start|> <|im_end|> <|endoftext|>",
      "~~~~",
    ].join("\n");
    expect(stripChatTemplateSpill(fenced)).toBe(fenced);
  });

  it("keeps an unfinished trailing role line while the stream is open", () => {
    expect(stripChatTemplateSpill("Answer\nuser", { keepTrailingOpenLine: true })).toBe("Answer\nuser");
    expect(stripChatTemplateSpill("Answer\nuser\n", { keepTrailingOpenLine: true })).toBe("Answer");
  });

  it("drops web tool JSON lines so a following role line after the think close goes too", () => {
    const text = [
      '{"name": "web_search", "arguments": {"query": "Chicago Bears NFC Championship appearances record"}}',
      "</think>",
      "",
      '{"name": "web_fetch", "arguments": {"url": "https://www.espn.com/nfl/team/_/name/chic/bears#championships"}}',
      '{"name": "web_fetch", "arguments": {"url": "https://www.espn.com/nfl/team/_/name/chic/bears#record-championships"}}',
      "user",
      "The search results indicate that the Chicago Bears have appeared in the NFC Championship 5 times.",
    ].join("\n");
    const stripped = stripChatTemplateSpill(text);
    expect(stripped).toContain("The search results indicate that the Chicago Bears have appeared in the NFC Championship 5 times.");
    expect(stripped).not.toContain("web_search");
    expect(stripped).not.toContain("web_fetch");
    expect(stripped).not.toMatch(/^user$/m);
    const stringArgs = '{"name":"web_search","arguments":"{\\"query\\":\\"weather\\"}"}';
    expect(stripChatTemplateSpill(stringArgs)).not.toContain("web_search");
    expect(stripChatTemplateSpill('{"name":"web_search","arguments":"[1]"}')).toContain("web_search");
    expect(stripChatTemplateSpill('{"name":"web_search","arguments":"1"}')).toContain("web_search");
    expect(stripChatTemplateSpill('{"name":"web_search","arguments":"{"}')).toContain("web_search");
  });

  it("keeps a fenced web tool JSON example", () => {
    const text = [
      "Example:",
      "```",
      '{"name": "web_fetch", "arguments": {"url": "https://example.com/"}}',
      "```",
    ].join("\n");
    expect(stripChatTemplateSpill(text)).toBe(text);
  });

  it("keeps blank lines inside a fenced sample and still collapses them outside", () => {
    const fenced = ["```", "line", "", "", "line", "```"].join("\n");
    expect(stripChatTemplateSpill(fenced)).toBe(fenced);
    expect(stripChatTemplateSpill("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("presentAssistantText", () => {
  it('copies a trailing user line that the reply still shows', () => {
    const text = 'The label for this turn is\nuser';
    const shown = presentAssistantText({
      text,
      streaming: false,
      assumeReasoning: false,
      prefilledThink: false,
    });
    expect(shown.visibleContent).toBe(text);
    expect(assistantClipboardText(text, { prefilledThink: false, streaming: false })).toBe(text);
    expect(assistantClipboardText('Answer\nuser', { prefilledThink: true, streaming: true })).toBe('Answer\nuser');
    expect(assistantClipboardText('Answer\nuser\n', { prefilledThink: true, streaming: false })).toBe('Answer');
  });

  it('copies an assistant reply without a spilled role line', () => {
    const text = 'Reasoning\n</think>\nuser\nThe record is 3-2.';
    const copied = assistantClipboardText(text, { prefilledThink: false, streaming: false });
    expect(copied).toContain('Reasoning');
    expect(copied).toContain('The record is 3-2.');
    expect(copied).not.toMatch(/^user$/m);
  });

  it("keeps a prefilled think block out of the answer when the token budget ends it", () => {
    const result = presentAssistantText({
      text: "The user wants a comparison. June 2026 has not happened.",
      streaming: false,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(result.visibleContent).toBe("");
    expect(result.thinkingContent).toEqual(["The user wants a comparison. June 2026 has not happened."]);
    expect(result.stoppedBeforeAnswer).toBe(true);
  });

  it("holds prefilled reasoning while the reply is still streaming", () => {
    const result = presentAssistantText({
      text: "Still reasoning",
      streaming: true,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(result.visibleContent).toBe("");
    expect(result.thinkingContent).toEqual(["Still reasoning"]);
    expect(result.stoppedBeforeAnswer).toBe(false);
  });

  it("hides spilled role lines between the think close and the answer", () => {
    const result = presentAssistantText({
      text: "The user is asking about the Cubs.\n</think>\n\nuser\n\nuser\n\nBased on my search, 2021 was 74 and 88.",
      streaming: false,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(result.thinkingContent).toEqual(["The user is asking about the Cubs."]);
    expect(result.visibleContent).toBe("Based on my search, 2021 was 74 and 88.");
    expect(result.stoppedBeforeAnswer).toBe(false);
  });

  it("shows the answer once a prefilled model closes the think tag", () => {
    const result = presentAssistantText({
      text: "worked through it\n</think>\n\nThe forecast is rain.",
      streaming: false,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(result.visibleContent).toBe("The forecast is rain.");
    expect(result.thinkingContent).toEqual(["worked through it"]);
    expect(result.stoppedBeforeAnswer).toBe(false);
  });

  it("keeps playground status lines in the answer area", () => {
    const result = presentAssistantText({
      text: "Searching the public web: chicago weather",
      streaming: true,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(result.visibleContent).toBe("Searching the public web: chicago weather");
    expect(result.thinkingContent).toEqual([]);
    expect(result.stoppedBeforeAnswer).toBe(false);
  });

  it("keeps a live Reading status in the answer area while the send is active", () => {
    const result = presentAssistantText({
      text: "Reading example.com",
      streaming: true,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(result.visibleContent).toBe("Reading example.com");
    expect(result.thinkingContent).toEqual([]);
    expect(result.stoppedBeforeAnswer).toBe(false);
  });

  it("shows an error or stop-during note after prefilled reasoning instead of a cutoff", () => {
    const error = presentAssistantText({
      text: "still reasoning\n\n[Error: network down]",
      streaming: false,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(error.visibleContent).toBe("[Error: network down]");
    expect(error.thinkingContent).toEqual(["still reasoning"]);
    expect(error.stoppedBeforeAnswer).toBe(false);

    const during = "[Stopped during web retrieval. An already-started network request may have completed.]";
    const stopped = presentAssistantText({
      text: `still reasoning\n\n${during}`,
      streaming: false,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(stopped.visibleContent).toBe(during);
    expect(stopped.thinkingContent).toEqual(["still reasoning"]);
    expect(stopped.stoppedBeforeAnswer).toBe(false);

    const only = presentAssistantText({
      text: "[Error: network down]",
      streaming: false,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(only.visibleContent).toBe("[Error: network down]");
    expect(only.thinkingContent).toEqual([]);
    expect(only.stoppedBeforeAnswer).toBe(false);

    const template = "This model cannot use web search yet. The upstream template fails when tools are sent, so this reply stopped.";
    const model = presentAssistantText({
      text: `still reasoning\n\n${template}`,
      streaming: false,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(model.visibleContent).toBe(template);
    expect(model.thinkingContent).toEqual(["still reasoning"]);
    expect(model.stoppedBeforeAnswer).toBe(false);
  });

  it("still shows a finished stop note instead of hiding it as reasoning", () => {
    const note = "[Stopped after web retrieval. An already-started network request may have completed.]";
    const result = presentAssistantText({
      text: note,
      streaming: false,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(result.visibleContent).toBe(note);
    expect(result.thinkingContent).toEqual([]);
    expect(result.stoppedBeforeAnswer).toBe(false);
  });

  it("does not treat a finished prefilled reply that starts with Reading as a status", () => {
    const result = presentAssistantText({
      text: "Reading the question and comparing the dates.",
      streaming: false,
      assumeReasoning: false,
      prefilledThink: true,
    });
    expect(result.visibleContent).toBe("");
    expect(result.thinkingContent).toEqual(["Reading the question and comparing the dates."]);
    expect(result.stoppedBeforeAnswer).toBe(true);
  });

  it("hides web tool JSON a model wrote as text, including when there is no think tag", () => {
    const withThink = [
      '{"name": "web_search", "arguments": {"query": "Chicago Bears NFC Championship appearances record"}}',
      "</think>",
      "",
      '{"name": "web_fetch", "arguments": {"url": "https://www.espn.com/nfl/team/_/name/chic/bears#championships"}}',
      "user",
      "The search results indicate that the Chicago Bears have appeared in the NFC Championship 5 times.",
    ].join("\n");
    const shown = presentAssistantText({
      text: withThink,
      streaming: false,
      assumeReasoning: false,
      prefilledThink: false,
    });
    expect(shown.visibleContent).toBe("The search results indicate that the Chicago Bears have appeared in the NFC Championship 5 times.");
    expect(shown.thinkingContent.join("\n")).not.toContain("web_search");
    expect(shown.visibleContent).not.toContain("web_fetch");
    expect(shown.visibleContent).not.toMatch(/^user$/m);
    const bare = presentAssistantText({
      text: '{"name":"web_search","arguments":{"query":"bears"}}\nThe record is 3-2.',
      streaming: false,
      assumeReasoning: false,
      prefilledThink: false,
    });
    expect(bare.visibleContent).toBe("The record is 3-2.");
    expect(bare.visibleContent).not.toContain("web_search");
  });

  it("shows an untagged answer from a reasoning model once streaming ends", () => {
    const result = presentAssistantText({
      text: "The square is red.",
      streaming: false,
      assumeReasoning: true,
      prefilledThink: false,
    });
    expect(result.visibleContent).toBe("The square is red.");
    expect(result.thinkingContent).toEqual([]);
    expect(result.stoppedBeforeAnswer).toBe(false);
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
