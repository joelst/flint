<script lang="ts">
  type Props = {
    collapsed: boolean;
    collapseLabel: string;
    expandLabel: string;
    onclick?: () => void;
  };

  const { collapsed, collapseLabel, expandLabel, onclick }: Props = $props();
</script>

<button
  type="button"
  class="panel-collapse-btn"
  aria-label={collapsed ? expandLabel : collapseLabel}
  title={collapsed ? expandLabel : collapseLabel}
  aria-expanded={!collapsed}
  {onclick}
>
  <!-- Same panel glyph as the app sidebar, shared by Playground chats and Benchmark suites. -->
  <svg
    class="panel-collapse-icon"
    class:collapsed
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" stroke-width="1.8" />
    <path d="M9.5 5.5V18.5" stroke="currentColor" stroke-width="1.8" />
    <path d="M13 8.5H17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    <path d="M13 12H17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    <path d="M13 15.5H17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
  </svg>
</button>

<style>
  .panel-collapse-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    flex: none;
    background: none;
    color: var(--fg, inherit);
    opacity: 0.7;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .panel-collapse-btn:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--sidebar-bg, transparent) 70%, var(--panel-bg, transparent));
  }
  .panel-collapse-icon {
    width: 18px;
    height: 18px;
    display: block;
    transition: transform 0.2s ease;
  }
  .panel-collapse-icon.collapsed {
    transform: scaleX(-1);
  }
  @media (prefers-reduced-motion: reduce) {
    .panel-collapse-icon {
      transition: none;
    }
  }
</style>
