import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [sveltekit()],

  // Externalize the Foundry SDK to avoid browser/Node builtin issues during build.
  // Real usage should move to Tauri commands or sidecar for production.
  optimizeDeps: {
    exclude: ['foundry-local-sdk', 'foundry-local-sdk-winml']
  },
  build: {
    rollupOptions: {
      external: [
        /foundry-local-sdk/,
        'fs', 'path', 'url', 'module',
        'node:fs', 'node:path', 'node:url', 'node:module',
        'node:fs/promises'
      ]
    }
  },
  // Prevent Vite from trying to bundle the SDK's Node-only internals
  ssr: {
    external: ['foundry-local-sdk']
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}', 'sidecar/**/*.{test,spec}.{js,ts}'],
    environment: 'jsdom',
    css: false,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: /** @type {'v8'} */ ('v8'),
      reporter: ['text', 'html'],
      include: [
        'src/lib/personas.ts',
        'src/lib/message-rendering.ts',
        'src/lib/conversation-sidebar.ts',
        'src/lib/ipc-contracts.ts',
      ],
      thresholds: {
        lines: 65,
        functions: 65,
        branches: 45,
        statements: 65
      }
    }
  }
}));
