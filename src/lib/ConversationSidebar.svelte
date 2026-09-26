<script context="module" lang="ts">
  export interface Conversation {
    id: string;
    title: string;
    createdAt: number;
    messageCount: number;
    /** Imported from the pre-v2 global thread, which had no provable owner in the old index. */
    recovered?: boolean;
    /**
     * The pre-v2 index recorded a turn count for this conversation but never stored the turns
     * themselves. Showing "0 messages" here would read as deletion, so the claimed count is
     * shown and labelled instead.
     */
    messagesUnavailable?: boolean;
    unavailableMessageCount?: number;
  }
</script>

<script lang="ts">
  import { truncateConversationTitle } from "./conversation-sidebar";

  export let conversations: Conversation[] = [];
  export let currentConversationId: string | null = null;
  export let onNewChat: () => void = () => {};
  export let onSelectConversation: (id: string) => void = () => {};
  export let onDeleteConversation: (id: string) => void = () => {};
  export let onExport: () => void = () => {};
  export let exportBusy = false;

  function formatTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }
</script>

<div class="conversation-sidebar">
  <div class="sidebar-header">
    <h3>Conversations</h3>
    <div class="sidebar-header-actions">
      <button
        class="export-btn"
        title="Save a copy of every conversation to a file, including any that Flint could not read"
        disabled={exportBusy}
        onclick={onExport}
      >
        {exportBusy ? "Saving…" : "Export"}
      </button>
      <button class="new-chat-btn" title="New conversation" onclick={onNewChat}>
        ➕ New
      </button>
    </div>
  </div>

  <div class="conversations-list">
    {#if conversations.length === 0}
      <div class="empty-state">No conversations yet</div>
    {:else}
      {#each conversations as conv (conv.id)}
        <div
          class="conversation-item"
          class:active={conv.id === currentConversationId}
          onclick={() => onSelectConversation(conv.id)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelectConversation(conv.id);
            }
          }}
          role="button"
          tabindex="0"
          title="Select conversation"
        >
          <div class="conv-title" title={conv.title}>
            {truncateConversationTitle(conv.title)}
          </div>
          <div class="conv-meta">
            {#if conv.messagesUnavailable}
              <span
                class="conv-unavailable"
                title="An earlier version of Flint recorded this conversation's title and message count but never stored its messages, so they are not available here. It kept a single chat history, which Flint imports separately as a recovered conversation; some of these messages may be in it, but which conversation they belonged to was never recorded."
              >
                {conv.unavailableMessageCount ?? 0} earlier messages unavailable
              </span>
              {#if conv.messageCount > 0}
                • {conv.messageCount} since
              {/if}
            {:else}
              {conv.messageCount} messages
            {/if}
            • {formatTime(conv.createdAt)}
          </div>
          {#if conv.recovered}
            <div
              class="conv-badge"
              title="Recovered from the single chat history kept by an earlier version of Flint. It could not be matched to a conversation in the old list."
            >
              Recovered
            </div>
          {/if}
          <button
            type="button"
            class="delete-btn"
            title="Delete conversation"
            onclick={(e) => {
              e.stopPropagation();
              onDeleteConversation(conv.id);
            }}
          >
            ✕
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .conversation-sidebar {
    width: 280px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar-header {
    padding: 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .sidebar-header h3 {
    margin: 0;
    font-size: 0.95rem;
    color: var(--fg);
  }

  .new-chat-btn {
    padding: 4px 8px;
    background: var(--button-bg);
    color: white;
    border: none;
    border-radius: 3px;
    font-size: 0.75rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .new-chat-btn:hover {
    background: color-mix(in srgb, var(--accent) 80%, #000);
  }

  .sidebar-header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .export-btn {
    padding: 4px 8px;
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.75rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .export-btn:hover:not(:disabled) {
    background: var(--panel-hover, rgba(127, 127, 127, 0.12));
  }

  .export-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .conversations-list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-width: 0;
  }

  .empty-state {
    padding: 20px 12px;
    text-align: center;
    color: var(--muted);
    font-size: 0.85rem;
  }

  .conversation-item {
    width: 100%;
    box-sizing: border-box;
    text-align: left;
    padding: 12px 44px 12px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.15s;
    position: relative;
    background: none;
    border: none;
    color: inherit;
    min-width: 0;
  }

  .conversation-item:hover {
    background: var(--subtle-bg);
  }

  .conversation-item.active {
    background: var(--panel-bg);
    border-left: 3px solid var(--accent);
    padding-left: 9px;
  }

  .conv-title {
    font-size: 0.9rem;
    color: var(--fg);
    margin-bottom: 4px;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .conv-meta {
    font-size: 0.7rem;
    color: var(--muted);
  }

  /* Not styled as an error: the data is genuinely gone, but nothing is wrong right now. */
  .conv-unavailable {
    font-style: italic;
  }

  .conv-badge {
    display: inline-block;
    margin-top: 4px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.65rem;
    color: var(--muted);
  }

  .delete-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 1rem;
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition:
      opacity 0.2s,
      color 0.2s;
  }

  .conversation-item:hover .delete-btn {
    opacity: 1;
  }

  .delete-btn:hover {
    color: var(--danger);
  }
</style>
