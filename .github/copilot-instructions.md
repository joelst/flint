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
- Coverage gate: `npm run test:coverage`, thresholds lines 97 / functions 94 / branches 84 / statements 95 over an opt-in `coverage.include` list in `vite.config.js` — new pure modules are ungated until added there.

## Working style
- Prefer the SDK/sidecar path in `src/lib/sdk.ts`; do not import Foundry Local into the web bundle.
- Sidecar protocol is JSON-lines; new commands update `src/lib/sdk.ts` (and IPC contracts if needed) **and** `sidecar/foundry-sidecar.js`. In the sidecar a command must be added in **three** places — `KNOWN_COMMANDS`, `FIELD_TYPES`, `COMMAND_SCHEMA` — plus any extra checks at the end of `validateCommand`.
- SPA/client-only only — no SSR assumptions.
- Keep Tauri resources in sync (`src-tauri/tauri.conf.json` + `scripts/verify-bundle.cjs`).
- On Windows prefer `foundry-local-sdk-winml`.
- Extract logic into pure `src/lib/*.ts` modules with tests rather than testing `+page.svelte`, which is `@ts-nocheck` and unverified by the compiler — a stale call site there produces no error.
- A new guard's test is not trusted until it has been seen to **fail**: revert the guard, confirm red, restore. Several guards here passed for the wrong reason until checked this way.
- Coverage is gated over an opt-in `coverage.include` list in `vite.config.js`; add each new pure module or it is ungated.

## Service and gateway
- The native core initializes **once per process**: a second `FoundryLocalManager.create()` throws `Foundry Local Core is already initialized`, even after clearing the singleton. Never re-create the manager, and never set `webServiceUrls` outside `init`.
- Consequently the native service picks its own port. Read it from `manager.urls[0]` after `startWebService()`; readiness is `GET /status` on that port (`startWebService()` returning proves nothing).
- Bound each native `/status` readiness attempt by the remaining overall startup deadline and discard its response body. A zero deadline performs no request. This finite control-plane deadline must not be applied to inference traffic.
- The port and bind address the user configures belong to Flint's proxy in `sidecar/gateway.js`, which forwards to the native port. `sharedEndpoint` is the proxy's address.
- Autoload is reactive: forward first, and only on the exact `400 ... is not loaded` retry once after loading. Never check "is it loaded" up front, and never retry twice.
- Only **cached** models are resolvable for autoload (`sidecar/model-registry.js`), so a stray identifier cannot start a download. Call `invalidateModelIndex()` wherever the cached set changes.
- `catalog.getModel()` accepts **only** the friendly alias; the id in `/v1/models` throws. Loading needs `{alias, variantId}` — dropping the variant loads the wrong build.
- The HTTP router is the mirror image: it routes **variant ids only** (with or without `:<version>`) and rejects the alias with "is not loaded" even while that model is resident. The gateway therefore rewrites the replayed body to the variant id the loader reports, and caches that mapping. A request must never be replayed under the client's own alias.
- Loading by alias resolves whichever variant suits the registered EPs, so it is only known after the load — `load()` returns it.
- Execution providers are **not** registered automatically: `ensureAccelerators` (→ `downloadAndRegisterEps`) must run or only `CPUExecutionProvider` is available and every CUDA variant fails to load. The app calls it at startup; scripts and probes must call it too.
- Within one alias the pool holds a single variant: requesting another triggers unload-then-load, so a model is never resident twice. Different aliases coexist; residency is bounded only by memory unless eviction is enabled.
- Proxied traffic is deliberately absent from the access log: `writeToDisk()` appends synchronously and would stall the event loop.
- Proxied requests never reach the sidecar's chat path, so the pool cannot see them. `createGateway({onActivity})` brackets each whole exchange (buffer → forward → autoload → replay) with one start/end pair; without it a model streaming a long completion looks idle and can be evicted mid-generation.
- Gateway responses buffered for `/status` rewriting or first-pass autoload-error inspection are capped before concatenation. Declared or streamed overflow returns 502 and cannot trigger autoload; bodyless HTTP responses are not rejected solely for a declared length above the cap. Ordinary and replayed inference responses remain streamed and uncapped.
- Service starts and stops are serialized **inside the sidecar as well as in `src/lib/sdk.ts`**. A failed start owns rollback until cleanup finishes, so it cannot tear down a newer successful transition.
- A failed replacement start unconditionally clears `sharedEndpoint`/`upstreamPort` and awaits best-effort teardown of the partial gateway and native listener while preserving the original start error. A teardown failure means listener termination is unconfirmed; never describe endpoint withdrawal as proof that the listener stopped.
- SDK 1.2.4's `stopWebService()` sends `stop_service` only when `manager.urls` is non-empty. If `start_service` opened a listener but URL decoding/publication failed, stop it through the manager's existing `coreInterop.executeCommand('stop_service')`; do not gate that fallback on `stopWebService` existing.
- A requested execution-provider preference is optional only when the runtime exposes no compatible setter. If one or more supported setters reject the request and none succeeds, fail the start and run partial-start cleanup rather than reporting success.
- Initialize the manager without HTTP autostart. After hydration, startup order is atomic memory policy, awaited accelerator registration, optional non-destructive service ensure, then requested model preloads.
- The complete page startup is single-flight, including synchronous failures. Explicit Stop revokes authorization for deferred service startup and remaining preloads.
- `managerInstance` means a manager exists in the current sidecar process; `managerReady` means catalog/readiness establishment completed for the live generation. Recovery must reuse the existing manager, never initialize the process-global native core twice.
- Publish runtime readiness only while the owning sidecar generation is still live and ready. Guard both initial and recovery refreshes against recursive initialization.
- `downloadAndRegisterEps()` can partially succeed with `success: false`; preserve `registeredEps`/`failedEps` instead of converting the result into an exception. CPU registration alone is not hardware acceleration.
- Accelerator readiness, model-load acknowledgements, and service-start acknowledgements belong to the sidecar generation that received their bytes. Capture ownership immediately before `write()`, then re-check it after every confirmation await before publishing success.
- When an explicit startup variant has known non-CPU provider metadata, preload it only if that provider is registered in the current readiness snapshot. Unknown metadata proceeds to the runtime load and may fail there; alias-only loads remain runtime-resolved, and CPU-compatible loads continue after partial accelerator failure.

## Memory watchdog / pool eviction
- Eviction (`sidecar/pool-eviction.js`) is two independent rules, **both off by default**: idle-unload (timeout floored at 60 s) and a max-resident cap (1–32). Configure via the `setEvictionConfig` command; per-model `pinned`/`normal`/`low` via `setModelPriorities`.
- Never evicted: `priority === 'pinned'` or `inFlight > 0` — pinned models stay resident even with idle-unload on. Order is `low` before `normal`, then least-recently-used, then alias. Missing `lastUsedAt` counts as just-used, never as never-used.
- `ensureModel` sweeps with `admitting: 1` **before** loading, so the cap frees room ahead of committing memory. `runEvictionSweep` re-checks `inFlight` at execution time because the plan is drawn before the async unloads.
- `poolStatus` returns `lastUsedAt`/`inFlight`/`priority` per entry plus an `eviction` block.
- The watchdog (`src/lib/memory-watchdog.ts`) is pure and evaluated in the frontend; `poolStatus` memory telemetry is **system-wide** (`os.totalmem() - os.freemem()`), not Flint's, so alerts are gated on Flint having resident models and the copy must not blame Flint.
- Sustain is elapsed time, not sample count (cadence varies 5 s → 60 s). A `maxSampleGapMs` gap, or a change to the config signature, marks the sample discontinuous and restarts the window so sleep/resume or an edited threshold cannot fire instantly.
- Separate RAM (90%) and VRAM (95%) thresholds — a GPU legitimately runs hot during inference. Clearing needs `threshold - clearMarginPct` hysteresis.
- On Apple Silicon accelerators are omitted entirely: unified memory would double-count the same bytes and raise two alerts for one problem.
- The watchdog polls even when `document.hidden` — that is exactly when it matters.

## UI and state
- Svelte 5 runes in `+page.svelte` (`// @ts-nocheck` there is intentional).
- `flint-chat-persist` holds app-level settings **and** the pre-v2 thread frozen at launch; conversations live in the v2 archive (see *Conversations and storage*).
- STT/vision filtering is metadata-driven (`task`, `capabilities`, aliases).
- Diagnostics/Integrations endpoint display must match sidecar service state.

## Conversations and storage
- Conversations live in `localStorage` under `flint-conversations-v2` (`src/lib/conversation-repository.ts`), with `…-v2.backup` holding bytes that could not be parsed.
- `flint-chat-persist` **is** rewritten on every save, but its `chatMessages` is captured once at launch (`legacyThreadAtLaunch`) and written back **verbatim**: it is the only remaining copy of the pre-v2 thread, kept for rollback and as the migration source if the archive commit failed. Never extend it with live messages (that would double every message against the ~5 MB budget) and never drop it while rewriting the key.
- `flint-chats-v1` is retired only by an explicit `retireLegacyKeys` call, never automatically, and `canRetireLegacyKeys` permits it only after a migration that lost nothing.
- One key, replaced atomically, is the whole commit point — the reason the store is `localStorage` rather than IndexedDB. A failed write is surfaced, never retried silently.
- Never write to storage before hydration completes; a read-modify-write on an unhydrated state replaces a blob that was never read.
- Per-conversation settings resolve against a baseline (`src/lib/conversation-settings.ts`). An **empty `modelAlias` means absence, not a choice** — in both the seeder and the resolver, because the caller deliberately does not blank the picker on an empty resolution, so an empty override would leak the previous conversation's model.
- `localStorage.key(i)` returns null rather than throwing when the set changes mid-walk, and a removal paired with an addition leaves `length` unchanged. Index-based enumeration therefore proves nothing on its own: list through `listKeys`, list **twice**, and compare the sets before concluding a key is absent.

## Operation outcomes
- `fetchUrl` uses one deadline for both headers and body. Response bytes are streamed and capped before parsing; unused error or overflow bodies are cancelled, bodyless success is valid, and deliberate UTF-8 truncation drops an incomplete trailing character.
- IPC transport deadlines are exhaustive by command and apply only to finite read-only queries. Start the timer when the pending request is published so startup waits count; expiry must remove the entry, prevent later dispatch, and ignore late replies. Keep outer deadlines longer than legitimate nested probe budgets. Inference and effectful operations remain unbounded because transport expiry does not establish native cancellation or outcome.
- `src/lib/operation-outcome.ts` classifies every sidecar command by effect. `COMMAND_EFFECTS` is an exhaustive `Record<SidecarCommandName, …>`, not a set plus complement, so a new command does not compile until it is classified; a contract test reads the sidecar's command list as text to catch drift.
- **A rejected `write()` is not evidence.** It resolves when bytes reach the pipe and says nothing about what the child already read. Only `'not-dispatched'` proves an operation did not happen; never automatically replay anything else.
- **Settling a request must revoke its permission to dispatch.** Settle-once protects the promise's answer, not against doing the work after answering — re-check ownership after every await, and immediately before `write()`.
- Publish the pending entry only **after** its promise exists, or cancelling inside `onAssignedId` finds a placeholder `reject` and strands the caller forever.
- Convenience service starts carry authorization per request and the guard is evaluated **inside** the transition lock; a check before queuing lets two starts both pass, and clearing a shared latch releases every start queued behind it.
- A Stop acknowledgement is not a quiescence guarantee: the sidecar handles commands concurrently and clears the gateway reference before awaiting shutdown.
- Model-load failures **throw**; the returned outcome describes the *service* only. Returning `'failed'` for a load is indistinguishable from a failed start, and callers then announce a model ready that never loaded.
- Report only what Flint can establish. Interrupted generation may already have been persisted (streaming writes deltas and autosave keeps them), so never claim nothing was saved; long audio counts failed and uncertain segments and only a clean run reports completion.

## Audio / STT
- Foundry Local returns **no timing data**: `transcribe()` has no `segments` and `duration` is always 0; `transcribeStreaming()` emits one chunk per word with no timings; live-session `start_time`/`end_time` are declared in the SDK types but the native core always returns null; live sessions are Nemotron-only and throw for Whisper.
- Flint therefore surfaces **no timestamps at all**. There is no segmentation module; do not cite one. Any timestamp feature must be built and labelled as derived, never as model output.
- Long audio is chunked in `transcribeLongAudio` (`+page.svelte`) into fixed **28 s windows with 4 s overlap**, stitched by longest word-overlap between a chunk's tail and the next chunk's head. The overlap exists because the ONNX/GenAI backend only reliably processes a limited prefix of a long file; short clips make Whisper hallucinate, so do not transcribe per-utterance.
- That merge is text-only heuristic recovery: it counts failed and uncertain chunks and the caller must qualify the transcript rather than report an unqualified success.
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
- `tauri-plugin-dialog`'s open/save **grants the chosen path to the fs scope at runtime** (`s.allow_file`), so a user-picked export destination needs no static `fs:scope` entry. Do not pre-authorize Downloads/Documents: that grants a whole directory instead of one file.
- `fs:allow-write-text-file` must keep its own `deny` on `$RESOURCE/**`. The resource scope is read-only reach for locating the sidecar and SDK, and the frontend must never be able to rewrite `foundry-sidecar.js`, which Node is then spawned to execute.
- In `tauri-plugin-fs`, command scopes union with the global scope and `is_forbidden` is evaluated before `is_allowed`, so a per-command deny wins without affecting other commands.
- Bundle Foundry SDK assets + sidecar together when changing runtime files.

## Versioning
- Version in three places: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- Code PRs: `npm run changeset` → commit `.changeset/*.md`. CI enforces changesets on code changes.
- Keep a changeset **one or two lines**, describing the user-visible effect. Detail belongs in the commit message and PR body; changesets are concatenated into `CHANGELOG.md`.
- The **empty form** (`---`/`---` plus prose) is valid and produces no version bump — use it for docs-only PRs that CI still gates.
- CI runs only on PRs targeting `main`/`master`, so a **stacked PR gets no checks** until its base lands and it is retargeted. Validate stacked work locally.
- `npm run version` → changeset version + `scripts/sync-versions.cjs`.
- Releases: push `v*` tag. Details: [docs/RELEASE.md](../docs/RELEASE.md).
- Docs-only PRs: skip changeset if CI allows.
