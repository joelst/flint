<script lang="ts">
  import { extractThinkingTrace, sanitizeAssistantHtml } from "./message-rendering";

  export let content: string = "";
  export let role: "user" | "assistant" = "assistant";
  /** True while this specific message is actively receiving stream deltas. */
  export let isStreaming: boolean = false;
  /**
   * True when the active model is tagged as a reasoning model. Some chat templates (e.g.
   * Qwen3-family) inject the opening <think> tag into the prompt prefix rather than the
   * generated text, so only the closing tag ever appears in `content` — meaning nothing is
   * detected as "thinking" until that closing tag streams in. Without this flag, the raw
   * chain-of-thought would render as a normal answer for the whole time it's in flight, then
   * abruptly vanish into the Thinking toggle. When set, content with no thinking tags yet is
   * tentatively treated as reasoning while still streaming, and released as a normal answer
   * on completion if no tag ever appeared.
   */
  export let assumeReasoning: boolean = false;
  /**
   * Identifies which logical message this instance is rendering (e.g. `${conversationId}:
   * ${messageId}`). `MessageRenderer` instances are created in an unkeyed `{#each}` (Chat) or
   * reused across runs for the same Arena slot, so Svelte can reuse one component instance for
   * what is, logically, a completely different message. Without this, `userToggledThinking`/
   * `showThinking` (component-local state) would silently bleed from one message to the next
   * that happens to land in the same position/slot. Defaults to a constant so callers that
   * never render more than one logical message through the same instance (there are none today)
   * are unaffected.
   */
  export let messageKey: string | number = 0;

  let renderedHtml = "";
  let thinkingBlocks: string[] = [];
  let showThinking = false;
  let userToggledThinking = false;
  let markedParser: ((src: string, options?: any) => string | Promise<string>) | null =
    null;
  let renderVersion = 0;
  let pendingRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMessageKey: string | number | undefined = undefined;

  $: {
    if (messageKey !== lastMessageKey) {
      lastMessageKey = messageKey;
      // A new logical message: never let the previous message's manual toggle or auto-expand
      // state, or its rendered output, leak into this one, even if it happens to render in the
      // same component instance. Cleared synchronously (not left to the debounced re-render) so
      // a brand-new message never visibly flashes the previous message's content first.
      userToggledThinking = false;
      showThinking = false;
      thinkingBlocks = [];
      renderedHtml = "";
    }
  }

  $: void queueRender(role, content, isStreaming, assumeReasoning, messageKey);

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
    streaming: boolean,
    reasoning: boolean,
  ): Promise<void> {
    if (currentRole !== "assistant") {
      if (currentVersion === renderVersion) {
        renderedHtml = `<p>${escapeHtml(safeContent)}</p>`;
        thinkingBlocks = [];
        showThinking = false;
        userToggledThinking = false;
      }
      return;
    }

    const extracted = extractThinkingTrace(safeContent);
    let { visibleContent } = extracted;
    let { thinkingContent } = extracted;
    // No tag detected yet: if this model is known to reason and the stream is still going,
    // hold the raw text as tentative "thinking" rather than showing it as the final answer.
    // A settled message (isStreaming false) always falls through here untouched, so a model
    // that never actually emits a closing tag still shows its answer normally once done.
    if (streaming && reasoning && thinkingContent.length === 0 && visibleContent) {
      thinkingContent = [visibleContent];
      visibleContent = "";
    }
    thinkingBlocks = thinkingContent;
    if (!userToggledThinking) {
      // Auto-expand while there is reasoning but no answer yet; auto-collapse once the
      // answer starts arriving. The user's own toggle always wins after that.
      showThinking = thinkingBlocks.length > 0 && !visibleContent;
    }
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

  /**
   * `_key` (messageKey) is intentionally unused in the body: its only purpose is as a reactive
   * dependency, so a message-identity change always re-renders even when `role`/`content`/
   * `isStreaming`/`assumeReasoning` are all otherwise identical to the previous message that
   * happened to render through this same instance (e.g. two conversations sharing an identical
   * reply). Without it, the synchronous reset above would leave the view blank until one of the
   * other props next changed.
   */
  function queueRender(
    currentRole: "user" | "assistant",
    currentContent: string,
    streaming: boolean,
    reasoning: boolean,
    _key: string | number,
  ): void {
    const currentVersion = ++renderVersion;
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
    }

    const scheduleDelayMs = currentRole === "assistant" ? 40 : 0;
    pendingRenderTimer = setTimeout(() => {
      pendingRenderTimer = null;
      void renderContent(currentVersion, currentRole, String(currentContent || ""), streaming, reasoning);
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
            userToggledThinking = true;
          }}
          title={showThinking ? "Hide model reasoning" : "Show model reasoning"}
        >
          {showThinking ? "▼" : "▶"} Thinking ({thinkingBlocks.length}){isStreaming && !renderedHtml ? "…" : ""}
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
    color: var(--fg);
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
