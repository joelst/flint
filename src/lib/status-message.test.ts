import { describe, expect, it } from "vitest";

import { errorText, failureLogLine, failureNotice, summarizeFailure } from "./status-message";

const NATIVE_LOAD_ERROR = new Error(
  [
    "Failed to load model gemma-4-e2b-it: JSON Error: Invalid value at line 1 column 1",
    "   at Microsoft.AI.Foundry.Local.Core.ModelLoader.Load(String alias)",
    "   at Microsoft.AI.Foundry.Local.Core.Pool.Ensure(String alias)",
  ].join("\n"),
);

describe("summarizeFailure", () => {
  it("keeps the CUDA status line short and moves the advice into a notice", () => {
    const detail = "genai_model_instance.cc:204 failed to load model smollm3-3b-cuda-gpu:1: " +
      "Failed to create allocator for CUDA: No requested allocator available";
    const error = new Error(
      `This did not complete. Any part of it that had already been done was not undone. ${detail}\n    at loadModel`,
    );
    const summary = summarizeFailure("Load failed", error);
    expect(summary).toMatch(/^Load failed: CUDA could not initialize a GPU allocator/);
    expect(summary.length).toBeLessThan(100);
    expect(summary).not.toContain("genai_model_instance");
    expect(summary).not.toContain("Any part");
    expect(failureLogLine("Load failed", error)).toContain(detail);

    const notice = failureNotice("Load failed", error);
    expect(notice?.title).toBe("Load failed: CUDA allocator unavailable");
    expect(notice?.advice).toContain("CUDA GPU");
    expect(notice?.advice).toContain("Recheck Providers");
    expect(notice?.advice).not.toContain("genai_model_instance");
  });

  it("offers no notice for failures the status line already covers", () => {
    expect(failureNotice("Load failed", NATIVE_LOAD_ERROR)).toBeNull();
    expect(failureNotice("Load failed", null)).toBeNull();
  });

  it("keeps the whole sentence rather than truncating to the visible width", () => {
    const detail = "a".repeat(400);
    const line = summarizeFailure("Load failed", new Error(detail));
    expect(line).toBe(`Load failed: ${detail}`);
  });

  it("prefers the JSON Error sentence over the managed stack", () => {
    expect(summarizeFailure("Load failed", NATIVE_LOAD_ERROR)).toBe(
      "Load failed: Invalid value",
    );
  });

  it("drops managed stack frames when there is no JSON Error sentence", () => {
    const error = new Error(
      "Model is not loaded\n   at Microsoft.AI.Foundry.Local.Core.Pool.Ensure(String alias)",
    );
    expect(summarizeFailure("Load failed", error)).toBe("Load failed: Model is not loaded");
  });

  it("drops JavaScript stack frames", () => {
    const error = new Error("boom\n    at loadModel (file:///app/sdk.js:12:5)");
    expect(summarizeFailure("Load failed", error)).toBe("Load failed: boom");
  });

  it("collapses newlines so the status stays one line", () => {
    const error = new Error("first part\nsecond part");
    expect(summarizeFailure("Load failed", error)).toBe("Load failed: first part second part");
  });

  it("does not repeat a prefix the error already carries", () => {
    expect(summarizeFailure("Load failed", new Error("Load failed: no such model"))).toBe(
      "Load failed: no such model",
    );
  });

  it("falls back to the prefix for an empty error", () => {
    expect(summarizeFailure("Load failed", undefined)).toBe("Load failed");
    expect(summarizeFailure("Load failed", new Error(""))).toBe("Load failed");
  });

  it("caps a pathological message before it reaches a DOM attribute", () => {
    const line = summarizeFailure("Load failed", new Error("x".repeat(9000)));
    expect(line.length).toBe(2000);
    expect(line.endsWith("…")).toBe(true);
  });

  it("accepts a non-Error value", () => {
    expect(summarizeFailure("Load failed", "plain string")).toBe("Load failed: plain string");
  });
});

describe("failureLogLine", () => {
  it("keeps the full native text for the app log", () => {
    const logged = failureLogLine("Load failed", NATIVE_LOAD_ERROR);
    expect(logged).toContain("Microsoft.AI.Foundry.Local.Core.ModelLoader.Load");
    expect(logged.startsWith("Load failed: Failed to load model")).toBe(true);
  });

  it("is the bare prefix when there is nothing to report", () => {
    expect(failureLogLine("Load failed", null)).toBe("Load failed");
  });
});

describe("errorText", () => {
  it("reads message, then falls back to the value itself", () => {
    expect(errorText(new Error("nope"))).toBe("nope");
    expect(errorText("nope")).toBe("nope");
    expect(errorText({ message: "" })).toBe("");
    expect(errorText(undefined)).toBe("");
  });
});
