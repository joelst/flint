// Wraps @tauri-apps/plugin-autostart. Uses dynamic import + guard so the
// module can be safely referenced even if not in a Tauri context (e.g. plain
// browser or certain debug scenarios). The OS autostart setting is hidden in
// Vite dev mode.
async function plugin() {
  const inTauri =
    typeof window !== 'undefined' &&
    ((window as any).__TAURI__ != null || (window as any).__TAURI_INTERNALS__ != null);
  if (!inTauri) {
    return {
      enable: async () => {},
      disable: async () => {},
      isEnabled: async (): Promise<boolean> => false,
    };
  }
  return import(/* @vite-ignore */ '@tauri-apps/plugin-autostart').catch(() => ({
    enable: async () => {},
    disable: async () => {},
    isEnabled: async (): Promise<boolean> => false,
  }));
}

export const enable = (): Promise<void> => plugin().then(m => m.enable());
export const disable = (): Promise<void> => plugin().then(m => m.disable());
export const isEnabled = (): Promise<boolean> => plugin().then(m => m.isEnabled());
