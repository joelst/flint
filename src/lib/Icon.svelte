<script lang="ts">
  type Props = {
    name: string;
    size?: number | string;
    class?: string;
    /** Accessible label. When set, the icon is announced by screen readers (role="img"). Omit for purely decorative use. */
    label?: string;
  };
  const { name, size = 16, class: cls = '', label }: Props = $props();
</script>

<!--
  Flat monochrome stroke icons (Lucide/Heroicons style).
  All use currentColor, viewBox 0 0 24 24, stroke-based unless noted.
-->
<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={cls}
  aria-hidden={label ? undefined : true}
  role={label ? 'img' : undefined}
  aria-label={label}
>
  {#if name === 'mic'}
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" x2="12" y1="19" y2="22"/>
  {:else if name === 'mic-off'}
    <line x1="2" x2="22" y1="2" y2="22"/>
    <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/>
    <path d="M5 10v2a7 7 0 0 0 12 5"/>
    <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/>
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>
    <line x1="12" x2="12" y1="19" y2="22"/>
  {:else if name === 'stop'}
    <!-- Solid square — no stroke needed -->
    <rect x="6" y="6" width="12" height="12" rx="1.5" stroke="none" fill="currentColor"/>
  {:else if name === 'send'}
    <path d="m22 2-7 20-4-9-9-4Z"/>
    <path d="M22 2 11 13"/>
  {:else if name === 'x'}
    <path d="M18 6 6 18"/>
    <path d="m6 6 12 12"/>
  {:else if name === 'check'}
    <path d="M20 6 9 17l-5-5"/>
  {:else if name === 'warning'}
    <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
    <path d="M12 9v4"/>
    <path d="M12 17h.01"/>
  {:else if name === 'bot'}
    <path d="M12 8V4H8"/>
    <rect width="16" height="12" x="4" y="8" rx="2"/>
    <path d="M2 14h2"/>
    <path d="M20 14h2"/>
    <path d="M15 13v2"/>
    <path d="M9 13v2"/>
  {:else if name === 'user'}
    <circle cx="12" cy="8" r="4"/>
    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
  {:else if name === 'masks'}
    <!-- Persona / theatre masks -->
    <path d="M2 12a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V7h-5a8 8 0 0 0-5 2 8 8 0 0 0-5-2H2Z"/>
    <path d="M6 11c1.5 0 3 .5 3 2-1.5 0-3-.5-3-2Z"/>
    <path d="M18 11c-1.5 0-3 .5-3 2 1.5 0 3-.5 3-2Z"/>
  {:else if name === 'camera'}
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/>
    <circle cx="12" cy="13" r="3"/>
  {:else if name === 'moon'}
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
  {:else if name === 'sun'}
    <circle cx="12" cy="12" r="4"/>
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
  {:else if name === 'monitor'}
    <rect width="20" height="14" x="2" y="3" rx="2"/>
    <path d="M8 21h8"/>
    <path d="M12 17v4"/>
  {:else if name === 'folder'}
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
  {:else if name === 'scroll'}
    <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/>
    <path d="M19 3H8.5a2.5 2.5 0 0 0 0 5H19a2 2 0 0 0 0-4Z"/>
  {:else if name === 'book'}
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>
  {:else if name === 'note'}
    <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/>
    <polyline points="15 3 15 9 21 9"/>
  {:else if name === 'loader'}
    <path d="M21 12a9 9 0 1 1-6.22-8.56"/>
  {:else if name === 'pin'}
    <path d="M12 17v5"/>
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z"/>
  {:else if name === 'pin-off'}
    <line x1="2" x2="22" y1="2" y2="22"/>
    <path d="M12 17v5"/>
    <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>
    <path d="M15 9.34V6a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0-1.73 1"/>
  {:else if name === 'zap'}
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" fill="currentColor" stroke="none"/>
  {/if}
</svg>
