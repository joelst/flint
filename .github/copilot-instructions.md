# Copilot instructions for Flint

Full human guide: [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md). Doc index: [docs/README.md](../docs/README.md). Living release plan: [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md). Open follow-ups: [docs/BACKLOG.md](../docs/BACKLOG.md).

Facts only — no history. Record what is true now; `git log` and `CHANGELOG.md` hold the rest.

## Project shape
- Flint is a Tauri 2 desktop app with a Svelte 5 + TypeScript frontend.
- The frontend runs as a SPA (`src/routes/+layout.ts` sets `ssr = false`) because Tauri has no Node SSR runtime.
- Most app behavior lives in `src/routes/+page.svelte`; `src/lib/sdk.ts` is the main abstraction boundary for Foundry Local actions.
- Production model/service work goes through `sidecar/foundry-sidecar.js` over stdio JSON lines; the Rust layer is intentionally thin.
- Vite externalizes `foundry-local-sdk`, `foundry-local-sdk-winml`, and Node builtins so the web bundle stays buildable.

## Commands (short)
- `npm install` · `npm run tauri dev` · `npm run check` · `npm test` · `npm run tauri:build` · `npm run verify:bundle` · `npm run setup:winml`
- Rust: `cd src-tauri && cargo check`
- Coverage gate: `npm run test:coverage`, thresholds 88/72 over `src/lib/*` + `sidecar/*` in `vite.config.js` — add new pure modules to `coverage.include`.

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

## Audio / STT
- Foundry Local returns **no timing data**: `transcribe()` has no `segments` and `duration` is always 0; `transcribeStreaming()` emits one chunk per word with no timings; live-session `start_time`/`end_time` are declared in the SDK types but the native core always returns null; live sessions are Nemotron-only and throw for Whisper.
- Timestamps in Flint are **derived from silence detection** (`src/lib/audio-segmentation.ts`) and are approximate — never label them as model output.
- Long audio uses ~28 s windows snapped to detected pauses; short clips make Whisper hallucinate, so do not transcribe per-utterance.
- Audio reaching `transcribeAudio` must be **real WAV**. The sidecar renames uploads to `.wav` (the decoder is strict) but renaming does not convert, so `sidecar/audio-format.js` sniffs magic bytes before a model loads.

## Packaging / release
- Release builds run `tauri build --target <triple>` → output is `src-tauri/target/<triple>/release`, not `target/release`. Pass `npm run verify:bundle -- --target <triple>`; add `--require-build` to fail on a missing output tree instead of skipping.
- CI and release both run `verify:bundle` and `smoke:node`. Keep them passing — packaging bugs are invisible to unit tests.
- Updater endpoint is `releases/latest/download/latest.json`. Never use a `{{current_version}}` URL (it resolves to the version already installed). Drafts and pre-releases are invisible to `releases/latest`.

## Tauri / Rust
- Keep Rust thin; if you add invoke handlers, update capabilities and frontend call sites.
- Bundle Foundry SDK assets + sidecar together when changing runtime files.

## Versioning
- Version in three places: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- Code PRs: `npm run changeset` → commit `.changeset/*.md`. CI enforces changesets on code changes.
- `npm run version` → changeset version + `scripts/sync-versions.cjs`.
- Releases: push `v*` tag. Details: [docs/RELEASE.md](../docs/RELEASE.md).
- Docs-only PRs: skip changeset if CI allows.
