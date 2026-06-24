<script context="module" lang="ts">
  export interface Conversation {
    id: string;
    title: string;
    createdAt: number;
    messageCount: number;
  }
</script>

<script lang="ts">
  export let conversations: Conversation[] = [];
  export let currentConversationId: string | null = null;
  export let onNewChat: () => void = () => {};
  export let onSelectConversation: (id: string) => void = () => {};
  export let onDeleteConversation: (id: string) => void = () => {};

  function truncateTitle(title: string, maxLen: number = 40): string {
    return title.length > maxLen ? title.substring(0, maxLen) + "…" : title;
  }

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
    <button class="new-chat-btn" title="New conversation" onclick={onNewChat}>
      ➕ New
    </button>
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
            {truncateTitle(conv.title)}
          </div>
          <div class="conv-meta">
            {conv.messageCount} messages • {formatTime(conv.createdAt)}
          </div>
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
    background: #111114;
    border-right: 1px solid #2a2a30;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar-header {
    padding: 12px;
    border-bottom: 1px solid #2a2a30;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .sidebar-header h3 {
    margin: 0;
    font-size: 0.95rem;
  }

  .new-chat-btn {
    padding: 4px 8px;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 3px;
    font-size: 0.75rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .new-chat-btn:hover {
    background: #2563eb;
  }

  .conversations-list {
    flex: 1;
    overflow-y: auto;
  }

  .empty-state {
    padding: 20px 12px;
    text-align: center;
    color: #666;
    font-size: 0.85rem;
  }

  .conversation-item {
    width: 100%;
    text-align: left;
    padding: 12px;
    border-bottom: 1px solid #2a2a30;
    cursor: pointer;
    transition: background 0.15s;
    position: relative;
    background: none;
    border: none;
    color: inherit;
  }

  .conversation-item:hover {
    background: #1f1f24;
  }

  .conversation-item.active {
    background: #2a2a32;
    border-left: 3px solid #3b82f6;
    padding-left: 9px;
  }

  .conv-title {
    font-size: 0.9rem;
    color: #eee;
    margin-bottom: 4px;
    word-break: break-word;
    white-space: normal;
  }

  .conv-meta {
    font-size: 0.7rem;
    color: #666;
  }

  .delete-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    background: none;
    border: none;
    color: #666;
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
    color: #f87171;
  }
</style>
