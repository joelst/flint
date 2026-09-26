<script lang="ts">
  import { endBoundaryLabel, formatClockTime, type TranscriptBoundary } from './transcript-format';

  let {
    startSec,
    endSec,
    endBoundary,
  }: {
    startSec: number;
    endSec: number;
    endBoundary?: TranscriptBoundary;
  } = $props();

  const label = $derived(endBoundaryLabel(endBoundary));
</script>

<span class="segment-time" class:snapped={endBoundary === 'pause-snapped'}>
  <span class="segment-time-range">{formatClockTime(startSec)} – {formatClockTime(endSec)}</span>
  {#if label}
    <span class="segment-boundary-label">{label}</span>
  {/if}
</span>

<style>
  .segment-time {
    display: flex;
    flex-direction: column;
    padding-top: 2px;
    color: var(--muted);
    font-family: monospace;
    font-size: 0.75rem;
  }

  .segment-time.snapped {
    color: var(--accent);
  }

  .segment-time-range {
    white-space: nowrap;
  }

  .segment-boundary-label {
    font-size: 0.65rem;
    white-space: normal;
    color: var(--fg);
  }
</style>
