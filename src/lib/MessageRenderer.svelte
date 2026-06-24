<script lang="ts">
  import { extractThinkingTrace, sanitizeAssistantHtml } from "./message-rendering";

  export let content: string = "";
  export let role: "user" | "assistant" = "assistant";

  let renderedHtml = "";
  let thinkingBlocks: string[] = [];
  let showThinking = false;
  let markedParser: ((src: string, options?: any) => string | Promise<string>) | null =
    null;
  let renderVersion = 0;
  let pendingRenderTimer: ReturnType<typeof setTimeout> | null = null;

  $: void queueRender(role, content);

  function escapeHtml(text: string): string {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  async function renderContent(
    currentVersion: number,
    currentRole: "user" | "assistant",
    safeContent: string,
  ): Promise<void> {
    if (currentRole !== "assistant") {
      if (currentVersion === renderVersion) {
        renderedHtml = `<p>${escapeHtml(safeContent)}</p>`;
        thinkingBlocks = [];
        showThinking = false;
      }
      return;
    }

    const { visibleContent, thinkingContent } = extractThinkingTrace(safeContent);
    thinkingBlocks = thinkingContent;
    if (!visibleContent) {
      if (currentVersion === renderVersion) {
        renderedHtml = "";
      }
      return;
    }

    try {
      if (!markedParser) {
        const { marked } = await import("marked");
        markedParser = marked;
      }
      const html = await Promise.resolve(
        markedParser(visibleContent, {
          breaks: true,
          gfm: true,
        }),
      );
      if (currentVersion === renderVersion) {
        renderedHtml = sanitizeAssistantHtml(html);
      }
    } catch (e) {
      console.warn("Markdown parse error:", e);
      if (currentVersion === renderVersion) {
        renderedHtml = `<p>${escapeHtml(visibleContent)}</p>`;
      }
    }
  }

  function copyToClipboard() {
    navigator.clipboard.writeText(content);
  }

  function queueRender(currentRole: "user" | "assistant", currentContent: string): void {
    const currentVersion = ++renderVersion;
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
    }

    const scheduleDelayMs = currentRole === "assistant" ? 40 : 0;
    pendingRenderTimer = setTimeout(() => {
      pendingRenderTimer = null;
      void renderContent(currentVersion, currentRole, String(currentContent || ""));
    }, scheduleDelayMs);
  }

</script>

<div class="message-renderer {role}">
  {#if role === "assistant"}
    {#if thinkingBlocks.length > 0}
      <div class="thinking-block">
        <button
          class="thinking-toggle"
          type="button"
          onclick={() => {
            showThinking = !showThinking;
          }}
          title={showThinking ? "Hide model reasoning" : "Show model reasoning"}
        >
          {showThinking ? "▼" : "▶"} Thinking ({thinkingBlocks.length})
        </button>
        {#if showThinking}
          <div class="thinking-content">
            {#each thinkingBlocks as block, i}
              <pre>{block}</pre>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <div class="rendered-markdown">
      {@html renderedHtml}
    </div>
    <button class="copy-btn" title="Copy message" onclick={copyToClipboard}
      >📋 Copy</button
    >
  {:else}
    <p>{content}</p>
    <button class="copy-btn" title="Copy message" onclick={copyToClipboard}
      >📋 Copy</button
    >
  {/if}
</div>

<style>
  .message-renderer {
    position: relative;
    width: 100%;
  }

  .message-renderer.assistant :global(p) {
    margin: 0.5em 0;
    color: var(--fg);
  }

  .message-renderer.assistant :global(pre) {
    background: var(--subtle-bg);
    border-left: 3px solid var(--accent);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    margin: 0.75em 0;
  }

  .message-renderer.assistant :global(code) {
    background: var(--input-bg);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
  }

  .message-renderer.assistant :global(pre code) {
    background: none;
    padding: 0;
    border-radius: 0;
  }

  .message-renderer.assistant :global(strong) {
    color: var(--fg);
    font-weight: 600;
  }

  .message-renderer.assistant :global(em) {
    color: var(--muted);
  }

  .message-renderer.assistant :global(h1),
  .message-renderer.assistant :global(h2),
  .message-renderer.assistant :global(h3) {
    margin: 1em 0 0.5em 0;
    color: var(--fg);
    font-weight: 600;
  }

  .message-renderer.assistant :global(h1) {
    font-size: 1.3em;
  }

  .message-renderer.assistant :global(h2) {
    font-size: 1.15em;
  }

  .message-renderer.assistant :global(h3) {
    font-size: 1em;
  }

  .message-renderer.assistant :global(ul),
  .message-renderer.assistant :global(ol) {
    margin: 0.75em 0;
    padding-left: 2em;
  }

  .message-renderer.assistant :global(li) {
    margin: 0.25em 0;
  }

  .message-renderer.assistant :global(a) {
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }

  .message-renderer.assistant :global(a:hover) {
    color: color-mix(in srgb, var(--accent) 70%, #fff);
  }

  .message-renderer.assistant :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 12px;
    margin: 0.75em 0;
    color: var(--muted);
  }

  .message-renderer.assistant :global(table) {
    border-collapse: collapse;
    margin: 0.75em 0;
    font-size: 0.9em;
  }

  .message-renderer.assistant :global(th),
  .message-renderer.assistant :global(td) {
    border: 1px solid var(--border);
    padding: 6px 8px;
    text-align: left;
  }

  .message-renderer.assistant :global(th) {
    background: var(--subtle-bg);
    font-weight: 600;
  }

  .message-renderer p {
    margin: 0;
    color: var(--fg);
  }

  .rendered-markdown {
    line-height: 1.6;
  }

  .thinking-block {
    margin-bottom: 0.6rem;
  }

  .thinking-toggle {
    width: 100%;
    text-align: left;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--subtle-bg);
    color: var(--muted);
    cursor: pointer;
    font-size: 0.85rem;
  }

  .thinking-toggle:hover {
    color: var(--fg);
    background: color-mix(in srgb, var(--subtle-bg) 80%, var(--panel-bg));
  }

  .thinking-content {
    margin-top: 0.35rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--input-bg);
    padding: 0.45rem 0.5rem;
  }

  .thinking-content pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 0.8rem;
    line-height: 1.4;
  }

  .copy-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    padding: 2px 6px;
    font-size: 0.7rem;
    background: var(--subtle-bg);
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .message-renderer:hover .copy-btn {
    opacity: 1;
  }

  .copy-btn:hover {
    background: var(--panel-bg);
    color: var(--fg);
  }
</style>
