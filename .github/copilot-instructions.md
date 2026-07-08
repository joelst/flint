# Copilot instructions for Flint

Full human guide: [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md). Doc index: [docs/README.md](../docs/README.md). Living release plan: [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md). Deferred copy/docs follow-ups: [docs/BACKLOG.md](../docs/BACKLOG.md).

## Project shape
- Flint is a Tauri 2 desktop app with a Svelte 5 + TypeScript frontend.
- The frontend runs as a SPA (`src/routes/+layout.ts` sets `ssr = false`) because Tauri has no Node SSR runtime.
- Most app behavior lives in `src/routes/+page.svelte`; `src/lib/sdk.ts` is the main abstraction boundary for Foundry Local actions.
- Production model/service work goes through `sidecar/foundry-sidecar.js` over stdio JSON lines; the Rust layer is intentionally thin.
- Vite externalizes `foundry-local-sdk`, `foundry-local-sdk-winml`, and Node builtins so the web bundle stays buildable.

## Commands (short)
- `npm install` · `npm run tauri dev` · `npm run check` · `npm test` · `npm run tauri:build` · `npm run verify:bundle` · `npm run setup:winml`
- Rust: `cd src-tauri && cargo check`

## Working style
- Prefer the SDK/sidecar path in `src/lib/sdk.ts`; do not import Foundry Local into the web bundle.
- Sidecar protocol is JSON-lines; new commands update `src/lib/sdk.ts` (and IPC contracts if needed) **and** `sidecar/foundry-sidecar.js`.
- SPA/client-only only — no SSR assumptions.
- Keep Tauri resources in sync (`src-tauri/tauri.conf.json` + `scripts/verify-bundle.cjs`).
- On Windows prefer `foundry-local-sdk-winml`.

## UI and state
- Svelte 5 runes in `+page.svelte` (`// @ts-nocheck` there is intentional).
- Chat persistence: `localStorage` key `flint-chat-persist`.
- STT/vision filtering is metadata-driven (`task`, `capabilities`, aliases).
- Diagnostics/Integrations endpoint display must match sidecar service state.

## Tauri / Rust
- Keep Rust thin; if you add invoke handlers, update capabilities and frontend call sites.
- Bundle Foundry SDK assets + sidecar together when changing runtime files.

## Versioning
- Version in three places: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- Code PRs: `npm run changeset` → commit `.changeset/*.md`. CI enforces changesets on code changes.
- `npm run version` → changeset version + `scripts/sync-versions.cjs`.
- Releases: push `v*` tag. Details: [docs/RELEASE.md](../docs/RELEASE.md).
- Docs-only PRs: skip changeset if CI allows.
