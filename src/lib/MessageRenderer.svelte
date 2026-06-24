<script lang="ts">
  import { onMount } from "svelte";

  export let content: string = "";
  export let role: "user" | "assistant" = "assistant";

  let renderedHtml = "";

  onMount(async () => {
    // Lazy-load marked only when needed
    const { marked } = await import("marked");

    if (role === "assistant" && content) {
      try {
        const html = await Promise.resolve(
          marked(content, {
            breaks: true,
            gfm: true,
          }),
        );
        renderedHtml = html;
      } catch (e) {
        console.warn("Markdown parse error:", e);
        renderedHtml = `<p>${escapeHtml(content)}</p>`;
      }
    } else {
      renderedHtml = `<p>${escapeHtml(content)}</p>`;
    }
  });

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

  function copyToClipboard() {
    navigator.clipboard.writeText(content);
  }
</script>

<div class="message-renderer {role}">
  {#if role === "assistant"}
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
  }

  .message-renderer.assistant :global(pre) {
    background: #1a1a1e;
    border-left: 3px solid #3b82f6;
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    margin: 0.75em 0;
  }

  .message-renderer.assistant :global(code) {
    background: #222226;
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
    color: #fff;
    font-weight: 600;
  }

  .message-renderer.assistant :global(em) {
    color: #ddd;
  }

  .message-renderer.assistant :global(h1),
  .message-renderer.assistant :global(h2),
  .message-renderer.assistant :global(h3) {
    margin: 1em 0 0.5em 0;
    color: #fff;
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
    color: #3b82f6;
    text-decoration: underline;
    cursor: pointer;
  }

  .message-renderer.assistant :global(a:hover) {
    color: #60a5fa;
  }

  .message-renderer.assistant :global(blockquote) {
    border-left: 3px solid #555;
    padding-left: 12px;
    margin: 0.75em 0;
    color: #aaa;
  }

  .message-renderer.assistant :global(table) {
    border-collapse: collapse;
    margin: 0.75em 0;
    font-size: 0.9em;
  }

  .message-renderer.assistant :global(th),
  .message-renderer.assistant :global(td) {
    border: 1px solid #333;
    padding: 6px 8px;
    text-align: left;
  }

  .message-renderer.assistant :global(th) {
    background: #222226;
    font-weight: 600;
  }

  .message-renderer p {
    margin: 0;
  }

  .rendered-markdown {
    line-height: 1.6;
  }

  .copy-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    padding: 2px 6px;
    font-size: 0.7rem;
    background: #333;
    color: #999;
    border: 1px solid #444;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .message-renderer:hover .copy-btn {
    opacity: 1;
  }

  .copy-btn:hover {
    background: #444;
    color: #ccc;
  }
</style>
