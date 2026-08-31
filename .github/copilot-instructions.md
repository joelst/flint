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

## Endpoint / models (probed 2026-08-30, SDK 1.2.4, CLI 0.10.3)
- The service **does** serve OpenAI-shaped `GET /v1/models` (200). `/openai/models` and `/foundry/list` are **404** — docs referencing them are stale.
- `/v1/models` lists **cached models only**, with no loaded/unloaded state. `id` is the variant *without* the version suffix (`qwen3-0.6b-generic-cpu`); `parent` is the friendly alias.
- **Alias routing works**: `model: "qwen3-0.6b"` succeeds, as do the variant with and without `:version`. The old pool-spike claim that clients must send variant IDs is obsolete.
- Streaming works: SSE with a `[DONE]` terminator and `usage` included. `usage` is present on non-streamed calls too.
- Responses carry **non-standard** fields (`IsDelta`, `Successful`, `HttpStatusCode`, and both `delta` and `message` in one choice). Strict OpenAI clients may reject them.
- A model must be **loaded first** — otherwise requests fail `400 Model is not loaded`. Load via `catModel.load()` (there is no `manager.loadModel()`).
- The catalog has **zero embedding models** (97 chat / 21 vision / 10 ASR of 128), so hiding them in the UI is a no-op; `/v1/embeddings` exists but needs a BYOM model. 75 of 128 declare `supportsToolCalling` — treat that as catalog-declared, not verified.

## Model cache / BYOM
- Cache root comes from `appName`: Flint uses `~/.flint`, the Foundry CLI uses `~/.foundry`. They do **not** share models, and duplication is real (15.3 GB measured).
- `modelCacheDir` selects a **single** root — it is a cache *switcher*, not an additive search path. Setting it to a custom dir hides the normal catalog.
- **BYOM works today**: a directory holding `genai_config.json` + `inference_model.json` (`{"Name":"<name>:<ver>", "PromptTemplate":{…}}`) and no `download.tmp` is discovered by `getCachedModels()` as `providerType: "Local"`, `uri: local://<name>`, resolvable by alias. The native scanner is recursive.
- **Directory junctions inside the cache root are traversed**, surfacing models stored elsewhere with alias/provider/version intact — no copying and no writes to the foreign directory. Delete the link, never the target.
- `addCatalog` / `registerModel` (the HuggingFace catalog API) exist in **neither** JS SDK 1.2.4 nor 2.0.0 — they appear to be C#-only. Flint must own import logic.
- Foundry Local is **ONNX-only (onnxruntime-genai)**; it does not run GGUF.
- `PromptTemplate` uses the literal `{Content}` placeholder (roles: `system`, `user`, `assistant`, `prompt`). A template missing it **does not error** — the model loads and silently drops message text, so validate before writing.
- Almost no public ONNX repo ships `inference_model.json` (2 of 301 surveyed on HF); Flint authors it. A model's `chat_template.jinja` wins over its architecture, because a fine-tune can keep the architecture while changing turn markers.
- `.flint-import.json` in a model dir is the ownership marker: only marked dirs may be modified or deleted by Flint. Catalog dirs and junctions (linked models) must never be rewritten.
- Prompt template rules live in `sidecar/prompt-template.js`, which imports **nothing** (not even Node builtins) so the browser bundle and the sidecar validate identically. `byom-import.js` re-exports it; `src/lib/sdk.ts` re-exports it to the UI. Adding a Node import there would break the web build.
- Locally added models (imported or linked) are identified in the UI by `info.uri` starting with `local://`.
- `listModels` returns `family` and `createdAt` (unix **seconds**, sometimes null) — those are the sortable fields. Sorting lives in `src/lib/model-sort.ts`, not in `+page.svelte`.

## Tauri / Rust
- Keep Rust thin; if you add invoke handlers, update capabilities and frontend call sites.
- Bundle Foundry SDK assets + sidecar together when changing runtime files.

## Versioning
- Version in three places: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- Code PRs: `npm run changeset` → commit `.changeset/*.md`. CI enforces changesets on code changes.
- `npm run version` → changeset version + `scripts/sync-versions.cjs`.
- Releases: push `v*` tag. Details: [docs/RELEASE.md](../docs/RELEASE.md).
- Docs-only PRs: skip changeset if CI allows.
