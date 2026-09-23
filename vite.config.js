import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [sveltekit()],

  // Externalize the Foundry SDK to avoid browser/Node builtin issues during build.
  // Real usage should move to Tauri commands or sidecar for production.
  optimizeDeps: {
    exclude: ['foundry-local-sdk']
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
    include: ['src/**/*.{test,spec}.{js,ts}', 'sidecar/**/*.{test,spec}.{js,ts}', 'scripts/**/*.{test,spec}.{js,ts}'],
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
        'src/lib/ipc-deadlines.ts',
        'src/lib/progress-stall.ts',
        'src/lib/node-runtime.ts',
        'src/lib/sidecar-paths.ts',
        'src/lib/flint-context.ts',
        'src/lib/chat-persistence.ts',
        'src/lib/url-chips.ts',
        'src/lib/conversation-store.ts',
        'src/lib/conversation-repository.ts',
        'src/lib/comparison-history.ts',
        'src/lib/compare-slot-outcome.ts',
        'src/lib/chat-usage.ts',
        'src/lib/benchmark-suite.ts',
        'src/lib/benchmark-repository.ts',
        'src/lib/benchmark-run.ts',
        'src/lib/benchmark-runner.ts',
        'src/lib/benchmark-progress.ts',
        'src/lib/benchmark-draft.ts',
        'src/lib/benchmark-export.ts',
        'src/lib/benchmark-results.ts',
        'src/lib/benchmark-suite-summary.ts',
        'src/lib/benchmark-lifecycle.ts',
        'src/lib/benchmark-priority-lease.ts',
        'src/lib/benchmark-generation-guard.ts',
        'src/lib/benchmark-exclusive-retry.ts',
        'src/lib/pending-call-tracker.ts',
        'src/lib/conversation-title.ts',
        'src/lib/conversation-session.ts',
        'src/lib/conversation-settings.ts',
        'src/lib/conversation-export.ts',
        'src/lib/operation-outcome.ts',
        'src/lib/chat-request.ts',
        'src/lib/startup-sequence.ts',
        'src/lib/endpoint-model-classification.ts',
        'src/lib/endpoint-load-target.ts',
        'src/lib/endpoint-self-test-residency.ts',
        'src/lib/endpoint-self-test.ts',
        'src/lib/sidecar-stderr.ts',
        'src/lib/accelerator-readiness.ts',
        'src/lib/provider-recheck-status.ts',
        'src/lib/status-message.ts',
        'sidecar/protocol-stdout.js',
        'sidecar/chat-transport.js',
        'sidecar/audio-format.js',
        'sidecar/model-updates.js',
        'sidecar/byom-import.js',
        'sidecar/prompt-template.js',
        'sidecar/service-lifecycle.js',
        'sidecar/execution-provider.js',
        'sidecar/execution-provider-cache.js',
        'sidecar/native-service.js',
        'sidecar/fetch-response.js',
        'src/lib/model-sort.ts',
        'sidecar/gateway-http.js',
        'sidecar/model-registry.js',
        'sidecar/activity-booking.js',
        'sidecar/gateway.js',
        'src/lib/memory-watchdog.ts',
        'sidecar/pool-eviction.js',
        'sidecar/async-log-writer.js',
        'sidecar/monotonic-wait.js',
        'sidecar/chat-response.js',
        'sidecar/inference-metrics.js',
        'sidecar/foundry-runtime-pin.js',
        'sidecar/health-ring.js',
        'sidecar/cache-inventory.js',
        'scripts/release-metadata.cjs',
        'scripts/verify-ipc-contracts.cjs',
        'scripts/verify-markdown-links.cjs',
      ],
      // Set just below the level the included files actually achieve, so the
      // gate catches regressions instead of rubber-stamping them. Raise these
      // as files are added rather than leaving slack.
      thresholds: {
        lines: 97,
        functions: 94,
        branches: 84,
        statements: 95
      }
    }
  }
}));
