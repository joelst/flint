# Copilot instructions for Flint

## Project shape
- Flint is a Tauri 2 desktop app with a Svelte 5 + TypeScript frontend.
- The frontend runs as a SPA (`src/routes/+layout.ts` sets `ssr = false`) because Tauri has no Node SSR runtime.
- Most app behavior lives in `src/routes/+page.svelte`; `src/lib/sdk.ts` is the main abstraction boundary for Foundry Local actions.
- Production model/service work goes through `sidecar/foundry-sidecar.js` over stdio JSON lines; the Rust layer is intentionally thin.
- Vite externalizes `foundry-local-sdk`, `foundry-local-sdk-winml`, and Node builtins so the web bundle stays buildable.

## Build, check, and packaging
- Install deps: `npm install`
- Dev app: `npm run tauri dev`
- Frontend/type check: `npm run check`
- Frontend watch check: `npm run check:watch`
- Web build: `npm run build`
- Tauri package build: `npm run tauri:build`
- Post-build bundle verification: `node scripts/verify-bundle.cjs`
- Windows accelerator setup: `npm run setup:winml`
- Rust check for Tauri code: `cd src-tauri && cargo check`
- Targeted validation while editing one frontend file: `npm run check -- --watch`

## Working style in this repo
- Prefer the SDK/sidecar path in `src/lib/sdk.ts` instead of importing Foundry Local directly into the web bundle.
- Keep the sidecar protocol JSON-line based; if you add commands, update both `src/lib/sdk.ts` and `sidecar/foundry-sidecar.js`.
- Preserve the SPA/client-only model; avoid SSR assumptions or server-side data loading patterns.
- Keep Tauri bundle resources in sync with runtime needs (`src-tauri/tauri.conf.json` and `scripts/verify-bundle.js`).
- On Windows, prefer `foundry-local-sdk-winml`; the repo already treats it as the acceleration-oriented variant.

## UI and state conventions
- `src/routes/+page.svelte` uses Svelte 5 runes (`$state`, `$derived`, `$effect`) and is annotated with `// @ts-nocheck`.
- Chat history, selected model, and system prompt are persisted in `localStorage` under `flint-chat-persist`.
- Model loading/downloading should refresh catalog state afterward so the UI stays in sync.
- STT and vision model selection should stay metadata-driven (`task`, `capabilities`, aliases), not hardcoded to a fixed family list.
- The diagnostics UI exposes the local OpenAI-compatible endpoint; keep that flow aligned with the sidecar service state.

## Tauri and Rust conventions
- `src-tauri/src/lib.rs` currently only initializes the opener plugin and does not expose custom invoke handlers.
- If you add Rust commands, update the Tauri permissions/capabilities and keep the frontend call sites in sync.
- Tauri config already bundles Foundry SDK assets and the sidecar; adjust both when adding/removing runtime files.

## Versioning & Changesets (PR-driven)
- App version lives in **three** places and must stay in sync:
  `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
- Use **changesets** so that PRs drive the next version:
  1. Make your code changes.
  2. Run: `npm run changeset`
  3. Answer the prompts (choose `patch` / `minor` / `major` and write a short summary).
  4. Commit the generated `.changeset/xxxx.md` file as part of the PR.
- CI will fail PRs that modify code without a changeset (this is how "PRs set the version").
- `npm run version` runs `changeset version` + syncs the version to all three files.
- A GitHub Action watches pushes to main and will automatically open a "Version Packages" PR when changesets are present.
- Releases are still triggered by pushing a `v*` tag (the tag workflow sets the version from the tag as a fallback and builds with tauri-action).
- For pure docs / internal / CI-only changes you can still create a changeset with "none" or skip if CI allows it.
