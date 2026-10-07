<script lang="ts">
  let {
    showTimestampedTranscript = $bindable(),
    segmentCount,
  }: {
    showTimestampedTranscript: boolean;
    segmentCount: number;
  } = $props();
</script>

<div class="transcript-toggle">
  <button
    type="button"
    class="small"
    class:secondary={showTimestampedTranscript}
    aria-pressed={!showTimestampedTranscript}
    onclick={() => (showTimestampedTranscript = false)}>Plain text</button
  >
  <button
    type="button"
    class="small"
    class:secondary={!showTimestampedTranscript}
    aria-pressed={showTimestampedTranscript}
    onclick={() => (showTimestampedTranscript = true)}
    >Estimated times ({segmentCount})</button
  >
</div>

<style>
  .transcript-toggle {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }

  button {
    padding: 6px 12px;
    background: var(--button-bg);
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.85rem;
  }

  button.small {
    font-size: 0.75rem;
    padding: 2px 8px;
    color: #fff;
  }

  button.secondary {
    background: var(--panel-bg);
    color: var(--fg);
    border: 1px solid color-mix(in srgb, var(--fg) 35%, var(--border));
  }
</style>
