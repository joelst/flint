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
  import IconActionButton from "./IconActionButton.svelte";
  import PanelCollapseButton from "./PanelCollapseButton.svelte";

  export let conversations: Conversation[] = [];
  export let currentConversationId: string | null = null;
  export let onNewChat: () => void = () => {};
  export let onSelectConversation: (id: string) => void = () => {};
  export let onDeleteConversation: (id: string) => void = () => {};
  export let onExport: () => void = () => {};
  export let exportBusy = false;
  export let collapsed = false;
  export let onToggleCollapsed: () => void = () => {};

  $: exportTip = exportBusy
    ? "Saving…"
    : "Save a copy of every conversation to a file, including any that Flint could not read";

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

<div class="conversation-sidebar" class:collapsed={collapsed}>
  <div class="sidebar-header" class:collapsed={collapsed}>
    <PanelCollapseButton
      collapsed={collapsed}
      collapseLabel="Collapse conversations"
      expandLabel="Expand conversations"
      onclick={onToggleCollapsed}
    />
    {#if !collapsed}
      <h3>Conversations</h3>
    {/if}
    <div class="sidebar-header-actions">
      <span class="action-tip" title={exportTip}>
        <IconActionButton
          name="download"
          label="Export conversations"
          title={exportTip}
          disabled={exportBusy}
          onclick={onExport}
        />
      </span>
      <IconActionButton name="plus" label="New conversation" filled onclick={onNewChat} />
    </div>
  </div>

  {#if !collapsed}
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
          <div class="conv-body">
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
          </div>
          <IconActionButton
            name="trash"
            label="Delete conversation"
            danger
            onclick={(e) => {
              e.stopPropagation();
              onDeleteConversation(conv.id);
            }}
          />
        </div>
      {/each}
    {/if}
  </div>
  {/if}
</div>

<style>
  .conversation-sidebar {
    width: 280px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex: none;
  }
  .conversation-sidebar.collapsed {
    width: 3.25rem;
  }

  .sidebar-header {
    padding: 8px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sidebar-header.collapsed {
    flex-direction: column;
  }

  .sidebar-header h3 {
    margin: 0;
    flex: 1;
    min-width: 0;
    font-size: 0.95rem;
    color: var(--fg);
  }

  .sidebar-header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sidebar-header.collapsed .sidebar-header-actions {
    flex-direction: column;
  }

  .action-tip {
    display: inline-flex;
  }
  /* Disabled controls do not show a title in WebView2, so the wrapper owns it. */
  .action-tip :global(button:disabled) {
    pointer-events: none;
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
    padding: 8px 8px 8px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.15s;
    background: none;
    border: none;
    color: inherit;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .conv-body {
    flex: 1;
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

</style>
