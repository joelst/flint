# Flint reliability execution plan

**Status:** Phase 0, Phase 1A, Phase 1B, and Phase 2 foundation stages are delivered in Flint 0.7.0. Post-0.7.0 execution focuses on outstanding runtime hardening, post-0.7.0 patch/minor capabilities, and long-term milestones.

**Scope:** Post-0.7.0 reliability and capability roadmap across supported platforms (Windows and macOS Apple Silicon).

**Release ownership:** [CHANGELOG.md](../CHANGELOG.md) owns version assignments and release history. [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) owns the forward plan through 1.0. This document owns post-0.7.0 implementation sequencing and acceptance gates. [BACKLOG.md](./BACKLOG.md) holds deferred work.

## Post-0.7.0 execution priorities

Following the 0.7.0 foundation release, follow-up work (targetable in 0.7.x patches or 0.8.0) focuses on:

1. **Installed-path recovery & lifecycle verification**
   - Implement native system tray Open/Quit and renderer-independent failed-quit recovery in the Rust desktop layer.
   - Packaged-app testing across Windows and macOS: verify single-instance focus/restore, tray Open/Quit, macOS Dock reopen, renderer-independent recovery, and clean exit.
   - Expand Rust supervisor integration tests against actual packaged bundles.

2. **Endpoint & agent compatibility enhancements**
   - User-facing endpoint behavioral conformance self-test (validating OpenAI API envelope, streaming termination, live tool-call generation vs catalog declarations).
   - BYOM `/v1/embeddings` pipeline to unlock RAG workflows and external indexing tools.
   - Verified recipes for external coding agents (Continue, Cline, OpenClaw).

3. **Audio format decoding & transcription resilience**
   - Transcode broader container formats (WebM/Opus, MP3) in-browser to 16 kHz mono PCM WAV without bundle bloat.
   - Revisit word-level timestamps when upstream Foundry SDK timing capabilities land.

4. **Updater UI & installation lifecycle**
   - In-app download, progress tracking, restart-to-update, and defer flows in the About/Settings views.

5. **Throughput metrics & observability**
   - Detailed inference telemetry (TTFT, prompt tok/s, decode tok/s, load time) surfaced truthfully across gateway and UI paths.

## Acceptance gates for post-0.7.0 workstreams

Each post-0.7.0 workstream must satisfy these concrete acceptance criteria before shipping:

- **Installed-path & lifecycle gate:** Native system tray Open/Quit and macOS Dock reopen restore the main window across packaged Windows and macOS builds; single-instance launch refocuses existing instance; process termination cleanly tears down the sidecar without orphaned processes; and recovery controls operate independently if the renderer webview fails.
- **Endpoint & agent integration gate:** User-facing self-test verifies `/v1/models` envelope, model ID reuse in chat completions, streaming termination with `[DONE]`, disconnect cancellation, `usage` token count reconciliation with output, verified generation of valid `tool_calls` structures on actual tool-definition prompts (distinguishing verified behavior from catalog-declared `supportsToolCalling` metadata), and verified integration recipes pinned to tested client versions (Continue, Cline, OpenClaw).
- **BYOM embeddings gate:** User-imported ONNX embedding models serve `/v1/embeddings` requests end-to-end with verified vector dimensionality and numeric output.
- **Audio transcoding gate:** Client-side WebM/Opus and MP3 decoding converts to 16 kHz mono PCM WAV before ingestion without increasing application bundle size.
- **Updater UX gate:** In-app updater displays download progress, notifies when an update is ready to apply, prompts to restart, and supports user deferral.
- **Inference telemetry gate:** Diagnostics and UI display accurate model load time, time to first token (TTFT), prompt tokens/sec, decode tokens/sec, and resolved provider/variant tags without ambiguous aggregated rates.

## Decisions

<a id="workstream-c-thin-native-ownership----expedited"></a>
### Native ownership and runtime architecture

1. **Expedite a thin Rust lifecycle and process-supervision layer.** Native code owns single-instance behavior, tray Open/Quit, macOS Reopen, and exactly one runtime child. A failed renderer must not remove recovery controls.
2. **Do not expedite a wholesale Foundry-to-Rust rewrite.** Keep the existing sidecar as the sole owner of the native Foundry manager, catalog, pool, and execution providers while correcting its behavior. Preserve native crash isolation from the desktop process.
3. **Do not wait for Rust to fix data loss or runtime correctness.** Hydration, request ownership, service transitions, streaming leases, pins, and honest failure reporting are independently shippable fixes on the existing transport.
4. **Linux-only work is deferred.** Preserve existing Ubuntu checks and platform mappings. Continue Linux-specific work only if it is already part of another feature; do not open a new Linux workstream until Windows/macOS release bars are complete.
5. **Separate corrections from new features.** Make existing controls effective and truthful first. Richer options follow the correctness gates they depend on.
6. **Use small, reversible changes.** Do not combine a data-format migration, transport cutover, SDK upgrade, and model-policy change in one release.

## Rubber-duck decisions

| Challenge | Decision |
|---|---|
| Would rewriting the backend fix conversation loss? | No. Correct hydration, storage identity, and asynchronous ownership in the frontend first. |
| Should the emergency fix introduce a new database? | No. Stop destructive writes immediately; give the subsequent storage migration its own compatibility gate. |
| Does keeping old storage make every downgrade safe? | No. Define a supported rollback version that understands the new format, including conversations created after migration. |
| Does a timeout or Stop acknowledgement mean inference stopped? | No. Separate caller completion from native-operation completion. Retain resource protection until completion is established or the owning process is gone. |
| Can a missing heartbeat prove the sidecar crashed? | Not while synchronous native work can block its event loop. Distinguish unresponsive from exited; avoid restart loops and duplicate work. |
| Would moving inference into Tauri prevent all windows disappearing? | It can do the opposite: a native fault would enter the desktop process. Keep inference in a supervised process even if its implementation later becomes Rust. |
| Can a worker thread initialize another Foundry manager? | Not safely as a workaround for the process-global native core. Keep one manager owner; do not duplicate ownership across Node workers. |
| Can the old and new transports both run during migration? | Not as concurrent runtime owners. Select one transport at startup and switch only after the previous child is confirmed stopped. |
| What happens when every model is busy, pinned, or of unknown residency? | Queue within a declared bound or refuse admission clearly. Never bypass protection or assume memory was released. |
| Is fixing hidden-tab polling sufficient for background protection? | No. Sampling/evaluation must survive a failed renderer; native notification delivery must not depend on the hidden webview. |
| Do signing credentials block correctness fixes? | They block the relevant signed distribution, not implementation or approved local testing. Do not weaken release signing or bypass managed-device policy. |
| Can shared packaging work become a Linux release project? | No. Fix host-versus-target selection for existing targets; defer Linux formats, matrices, distro qualification, and release claims. |

## Post-0.7.0 workstreams & capabilities

| Capability | Target scope | Prerequisites |
|---|---|---|
| **Installed-path lifecycle qualification** | Packaged tray/quit, dock reopen, crash recovery, and single-instance verification on Windows/macOS. | Rust supervisor (Phase 2 delivered). |
| **Endpoint behavioral self-test** | Diagnostic tool in UI testing OpenAI envelope, model-ID reuse, streaming chunk validity, cancellation, and live tool-call generation vs declarations. | Gateway proxy & initial normalization (Phase 1B delivered; broader conformance in progress). |
| **BYOM embeddings route** | End-to-end `/v1/embeddings` endpoint using user-imported ONNX embedding models. | BYOM import + SDK embedding client. |
| **Audio transcoding expansion** | Client-side WebM/Opus and MP3 decoding to 16 kHz PCM WAV without heavy bundles. | Web Audio / lightweight WASM decoder. |
| **Updater UX** | In-app download progress, ready-to-restart prompts, and deferral options. | Rust update events + Settings view. |
| **Inference telemetry** | Accurate TTFT, prompt/decode tokens per second, and provider tags in UI and logs. | Sidecar metrics reporting. |

### Source anchors

- Data/requests: `src/routes/+page.svelte`, `src/lib/conversation-repository.ts`, `src/lib/conversation-store.ts`, `src/lib/conversation-session.ts`, `src/lib/conversation-settings.ts`, `src/lib/conversation-export.ts`, `src/lib/chat-request.ts`.
- Runtime transport: `src/lib/sdk.ts`, `src/lib/operation-outcome.ts`, `src/lib/sdk-transport.ts`.
- Service/inference: `sidecar/foundry-sidecar.js`.
- Pool/gateway: `sidecar/gateway.js`, `sidecar/pool-eviction.js`.
- Models/import: `sidecar/byom-import.js`, `sidecar/prompt-template.js`, `sidecar/model-registry.js`.
- Audio/memory: `sidecar/audio-format.js`, `src/lib/memory-watchdog.ts`, and `transcribeLongAudio` in `src/routes/+page.svelte`.
- Desktop/packaging: `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `scripts/verify-bundle.cjs`, `scripts/smoke-bundled-node.cjs`, `vite.config.js`.

Follow symbols rather than line numbers; the review-baseline line ranges these anchors originally carried no longer track the tree.

## Gate for reconsidering a Rust runtime replacement

Revisit only after the critical data/runtime findings have been corrected and native supervision is stable:

- Supported Rust/native bindings cover the required Windows/macOS catalog, variants, EPs, streaming, multimodal, audio, and model/cache operations.
- The same behavioral contract covers both implementations, including partial failure, cancellation uncertainty, and process recovery.
- A bounded prototype demonstrates a material benefit in responsiveness, reliability, startup, or distribution cost. Language preference alone is not sufficient evidence.
- There is still one manager/pool authority, and native failure remains isolated from the desktop process. `spawn_blocking` alone is not process crash isolation.
- Cutover/rollback does not require simultaneous cache/data migration, duplicate runtimes, or replaying uncertain operations.

The near-term destination is a **native desktop supervisor with a reliable, replaceable runtime process**, not a deadline-driven removal of Node.
