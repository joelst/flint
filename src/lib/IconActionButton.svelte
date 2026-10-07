<script lang="ts">
  import Icon from "./Icon.svelte";

  type Props = {
    name: string;
    label: string;
    title?: string;
    disabled?: boolean;
    /** Filled circle, the same control as New suite. */
    filled?: boolean;
    danger?: boolean;
    size?: number;
    onclick?: (event: MouseEvent) => void;
  };

  const {
    name,
    label,
    title = undefined,
    disabled = false,
    filled = false,
    danger = false,
    size = 16,
    onclick,
  }: Props = $props();
</script>

<button
  type="button"
  class="icon-action"
  class:filled
  class:danger
  {disabled}
  aria-label={label}
  title={title ?? label}
  {onclick}
>
  <Icon {name} {size} />
</button>

<style>
  .icon-action {
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 999px;
    background: var(--panel-bg, transparent);
    color: var(--fg, inherit);
    border: 1px solid var(--border, #ccc);
    cursor: pointer;
  }
  .icon-action.filled {
    width: 2rem;
    height: 2rem;
    background: var(--button-bg, #1d4ed8);
    color: #fff;
    border: none;
  }
  .icon-action.danger {
    color: var(--danger, #dc3545);
    border-color: color-mix(in srgb, var(--danger, #dc3545) 45%, var(--border, #ccc));
  }
  .icon-action:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent, #3b82f6) 12%, var(--panel-bg, #fff));
  }
  .icon-action.filled:hover:not(:disabled) {
    background: color-mix(in srgb, var(--button-bg, #1d4ed8) 85%, #000);
  }
  .icon-action.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger, #dc3545) 12%, var(--panel-bg, #fff));
  }
  /* A disabled button is not a hover target in WebView2, so the wrapper owns the tooltip. */
  .icon-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }
</style>
