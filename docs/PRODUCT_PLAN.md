# Flint reliability execution plan

**Status:** Phase 0, Phase 1A, Phase 1B, and Phase 2 foundation stages are delivered in Flint 0.7.0. Post-0.7.0 waves land as **0.9.0**, the first stable channel release, so the in-app updater can be proven before **1.0.0**. 0.8.0 is unused. No 1.0 date until that upgrade dogfood and remaining process gates in [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) are done.

**Scope:** 1.0 production is Windows. macOS Apple Silicon remains evaluation-only (unsigned). Linux is deferred.

**Release ownership:** [CHANGELOG.md](../CHANGELOG.md) owns version assignments and release history. [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) owns the forward plan through 1.0 and the 1.0 release bar. This document owns 1.0 implementation sequencing and acceptance gates. [BACKLOG.md](./BACKLOG.md) holds deferred and post-1.0 work.

## 1.0 execution waves

Waves 1 and 2 may overlap. Wave 4 may overlap with 2/3. Wave 8 is the ship, not a development dump. If Wave 2 slips, do not compensate with embeddings, RAG, or a scheduler.

### Wave 1 — Security and CI

Rubber-duck: this is not a security product. The boundary already exists; 1.0 requires it audited, named, and gated. `npm ci` deletes `node_modules` then extracts packages *after* root `preinstall`, so a restore in `preinstall` is wiped. CI uses `npm run ci:deps` to restore `runtime/foundry-native-cache` after extract and before the SDK `skipIfPresent` installer. `updater:allow-download-and-install` stays because Wave 8 is in the same 0.9.0. PATH `node -v` stays (post-1.0 spawn-surface). CLI version checks are out — packaged users have no CLI.

- Prune unused grants: opener plugin (renderer never imported it); `$RESOURCE` read scope (sidecar paths are native `trusted_runtime_paths`); redundant `core:tray:default` / `core:menu:default` (already in `core:default`). Keep `$RESOURCE` write deny. Comment each survivor.
- Dedicated `src/lib/security-boundary.test.ts` that fails CI if opener/spawn/kill return, `$RESOURCE` reads return, shell execute is more than `node -v`, IPC allowlists drift, or BYOM `isInsideRoot` accepts a traversal.
- Cache `runtime/foundry-native-cache` in CI/release. CI runs `npm run ci:deps` (extract packages, restore cache, `npm rebuild`) so the SDK `skipIfPresent` installer sees the cores. Root `preinstall` restore cannot survive `npm ci`'s extract-after-preinstall order.
- Pin `foundry-local-sdk` to `1.2.4`. Warn (do not fail) at sidecar `init` when loaded SDK/core versions differ from that pin.

### Wave 2 — Native lifecycle and conversation integrity

Rubber-duck: a Svelte tray created on first close is not renderer-independent. Native tray must exist from **app start**. Close-to-hide stays a frontend setting. Native Quit currently does not flush conversations — that is the handshake PR, not the tray PR. Stream-by-conversation-id does not touch Rust and is a third PR.

- Native tray Open/Quit installed at startup (`src-tauri/src/tray.rs`). Frontend no longer creates a `TrayIcon`.
- `ExitRequested` prevents exit, emits `flint-quit-flush`, waits for `ack_quit_flush` or 2s, then exits. Renderer death cannot hang quit. Hide/blur/pagehide stays a best-effort extra.
- Stream updates follow the originating conversation id (`applyMessagePatch` when that chat is not visible). Stop applies to the visible conversation only.

### Wave 3 — Cancellation and timeout certainty

Foundry has no abort API. 1.0 closes honesty and fencing, not a fake Stop.

- Chat streaming: Stop settles the caller; native loop keeps consuming until stream end or child exit; UI already says the background may finish.
- Compare: no Stop control. The running state says the run cannot be cancelled — wait for slots.
- Audio: transcription cannot be stopped once started; the Transcribe button says so while in flight.
- Gateway disconnect already destroys upstream. The embeddings **path** is in 0.9.0 (Wave 9). Full RAG stays after 1.0.

### Wave 4 — Observability

- Gateway access log is metadata only (`source: 'gateway'`, no bodies). TTFT/tok/s are null when unobservable. Monitor table and CSV show TTFT / prompt tok/s / decode tok/s.
- Bounded health ring (`getHealthRing`) records init and service start/stop. Diagnostics export includes it.

### Wave 5 — Endpoint trust

- Diagnostics **Test local endpoint** checks envelope, chat round-trip, stream `[DONE]`, usage (blocked if absent), disconnect abort, and tool_calls (pass or explicit not-verified). Catalog `supportsToolCalling: false` skips the tools prompt.
- Model details show **Flint-verified** from the last self-test in this session, distinct from catalog declarations.
- Continue/Cline/OpenClaw: do not invent version pins. Continue stays `verified` with “version not pinned”; Cline remains Unverified; OpenClaw remains community until a recorded dogfood.

### Wave 6 — Operator docs and UX qualification

- Operator runbook: [ADMIN.md](./ADMIN.md). USER_GUIDE sidecar troubleshooting matches bundled Node.
- Empty/error copy: catalog empty on Models and first-run; Chat shows “No chat model loaded.” Packaged Windows walk of the checklist is still a Wave 7 dogfood tick.

**1.0 UX checklist**

- First-run coach covers runtime → model → chat → optional endpoint and is recoverable from Help.
- Settings → Network bind/port apply-and-restart and WSL mirrored-vs-NAT copy are truthful.
- Monitor exposes RAM/VRAM gauges, eviction/pin controls, and access-log export.
- Catalog failure, sidecar failure, and "no chat model loaded" are visible empty/error states rather than success-shaped UI.

### Wave 7 — Packaged smoke and dogfood

- CI (Windows): after the debug Tauri build, `FLINT_RUNTIME_SMOKE=1` launches `Flint.exe` and exits 0 when the sidecar phase is `ready` (`npm run smoke:runtime`). Does not load a model.
- Process still required: signed clean-machine install, download/load/chat/stop/quit/relaunch. macOS: recorded `install-macos.sh` boot as evaluation evidence.

### Wave 8 — Updater and first stable (0.9.0)

- About: Install / progress / Restart to update / Later against the wired updater plugin.
- Publish **0.9.0** as `channel=stable` (not a prerelease, draft still reviewed by a human) so `releases/latest` resolves. That is the upgrade test from 0.7.0 evaluation. Rollback: previous installer, documented in [RELEASE.md](./RELEASE.md).
- **1.0.0** is a later stable, after that upgrade is proven and 0.9.0 bugfixes land. Do not skip 0.9.0.

### Wave 9 — Embeddings path (in 0.9.0)

Embedding-model path, not RAG. Ships in 0.9.0 with the rest of the post-0.7.0 waves.

- Gateway classifies `/v1/embeddings` and autoloads like chat (proven in tests). Chat JSON/SSE normalization stays chat-only.
- BYOM import detects embedding folders and does not require a chat prompt template.
- Sidecar `embedTexts` uses `createEmbeddingClient()` with the same pool inFlight fencing as chat. Batches are bounded (32 strings, 8k chars each).
- Diagnostics self-test **blocks** embeddings when no embedding model is present; **passes** when `POST /v1/embeddings` returns a numeric vector.
- One recorded BYOM recipe is still a spike: do not fake a Continue indexer verification.

## Acceptance gates for 1.0 workstreams

Each wave must satisfy its gate before that slice ships in 0.9.0. Extra audio-decoder work has no 0.9.0/1.0 gate.

- **Security gate:** Capability JSON is pruned and commented; the boundary suite fails if unused dangerous grants return or sidecar allowlisting/IPC/BYOM containment regress.
- **Installed-path and lifecycle gate:** Native tray Open restores the main window and Quit terminates the app on packaged Windows; macOS Dock reopen restores the main window (already native); single-instance launch refocuses the existing instance; process termination tears down the sidecar child without orphans; recovery controls operate if the renderer webview fails; quit waits for a conversation-flush ack or a bounded timeout.
- **Cancellation gate:** Every in-bar request type has an honest certainty (cancelled / unknown / complete). Stop never claims native quiescence. Resource protection holds until native completion or the child is gone.
- **Observability gate:** Diagnostics and Monitor display load time, TTFT, prompt tok/s, decode tok/s, and resolved provider/variant without an aggregated "tokens/sec"; gateway samples appear in the access log when observable; diagnostics export includes the health ring.
- **Endpoint and agent integration gate:** User-facing self-test verifies `/v1/models` envelope, model ID reuse in chat completions, streaming termination with `[DONE]`, disconnect cancellation, `usage` when the model emits it, and either valid `tool_calls` or an explicit not-verified label. Continue, Cline, and OpenClaw recipes are pinned to tested client versions.
- **UX gate:** The checklist in Wave 6 holds on a packaged Windows build.
- **Docs gate:** Operator runbook exists and is indexed; USER_GUIDE sidecar troubleshooting matches bundled Node.
- **Updater UX gate:** In-app updater displays download progress, notifies when an update is ready, prompts to restart, and supports deferral.
- **Ship gate (0.9.0):** Publish 0.9.0 as stable so `releases/latest` resolves; record a 0.7.0-evaluation → 0.9.0 in-app updater install. Rollback note in RELEASE.md.
- **Ship gate (1.0.0):** Signed Windows clean-machine dogfood recorded; 0.9.0 upgrade proven; 1.0.0 published stable.

## Decisions

<a id="workstream-c-thin-native-ownership----expedited"></a>
### Native ownership and runtime architecture

1. **Expedite a thin Rust lifecycle and process-supervision layer.** Native code owns single-instance behavior, macOS Reopen, tray Open/Quit from startup, the quit-flush handshake, and exactly one runtime child.
2. **Do not expedite a wholesale Foundry-to-Rust rewrite.** Keep the existing sidecar as the sole owner of the native Foundry manager, catalog, pool, and execution providers while correcting its behavior. Preserve native crash isolation from the desktop process.
3. **Do not wait for Rust to fix data loss or runtime correctness.** Hydration, request ownership, service transitions, streaming leases, pins, and honest failure reporting are independently shippable fixes on the existing transport.
4. **Linux-only work is deferred.** Preserve existing Ubuntu checks and platform mappings. Continue Linux-specific work only if it is already part of another feature; do not open a new Linux workstream until the Windows 1.0 production bar is complete.
5. **Separate corrections from new features.** Make existing controls effective and truthful first. Richer options follow the correctness gates they depend on.
6. **Use small, reversible changes.** Do not combine a data-format migration, transport cutover, SDK upgrade, and model-policy change in one release.
7. **1.0 is one local endpoint.** Drop the multi-endpoint manager from the 1.0 bar. Sticky routing, failover, and cloud escalate stay unscheduled in BACKLOG. Azure connections stay post-1.0.
8. **1.0 production is Windows.** macOS Apple Silicon stays evaluation-only (unsigned + install script). Apple Developer ID notarization is a post-1.0 calendar item, not a 1.0 code workstream. Signing Flint.app does not un-quarantine the SDK's ad-hoc dylib.

## Rubber-duck decisions

| Challenge | Decision |
|---|---|
| Would rewriting the backend fix conversation loss? | No. Correct hydration, storage identity, and asynchronous ownership in the frontend first. |
| Should the emergency fix introduce a new database? | No. Stop destructive writes immediately; give the subsequent storage migration its own compatibility gate. |
| Does keeping old storage make every downgrade safe? | No. Define a supported rollback version that understands the new format, including conversations created after migration. |
| Does a timeout or Stop acknowledgement mean inference stopped? | No. Separate caller completion from native-operation completion. Retain resource protection until completion is established or the owning process is gone. Foundry has no abort API; 1.0 closes honesty and fencing, not a fake Stop. |
| Can a missing heartbeat prove the sidecar crashed? | Not while synchronous native work can block its event loop. Distinguish unresponsive from exited; avoid restart loops and duplicate work. |
| Would moving inference into Tauri prevent all windows disappearing? | It can do the opposite: a native fault would enter the desktop process. Keep inference in a supervised process even if its implementation later becomes Rust. |
| Can a worker thread initialize another Foundry manager? | Not safely as a workaround for the process-global native core. Keep one manager owner; do not duplicate ownership across Node workers. |
| Can the old and new transports both run during migration? | Not as concurrent runtime owners. Select one transport at startup and switch only after the previous child is confirmed stopped. |
| What happens when every model is busy, pinned, or of unknown residency? | Queue within a declared bound or refuse admission clearly. Never bypass protection or assume memory was released. |
| Is fixing hidden-tab polling sufficient for background protection? | No. Sampling/evaluation must survive a failed renderer; native notification delivery must not depend on the hidden webview. |
| Do signing credentials block correctness fixes? | They block the relevant signed distribution, not implementation or approved local testing. Do not weaken release signing or bypass managed-device policy. |
| Can shared packaging work become a Linux release project? | No. Fix host-versus-target selection for existing targets; defer Linux formats, matrices, distro qualification, and release claims. |
| Does 1.0 require the seven roadmap criteria as originally written? | No. The bar is operationally trustworthy **local** operations. Keep the seven headings; the content must be doable or not-done. |
| Is the multi-endpoint manager a 1.0 requirement? | No. `EndpointProfile` CRUD is unused. Scheduler/failover/cloud escalate stay Future features. Criterion 2 is one local endpoint with honest cancellation, recovery, and health. |
| Is unsigned macOS part of the 1.0 production promise? | No. Evaluation-only. 1.0 production is Windows. |
| Must 1.0 ship a time-series health store? | No. Bounded in-process health ring plus diagnostics export. |
| Is UX maturity missing? | No. It was unscoped. Coach, Network/WSL, and Monitor memory UX exist; 1.0 qualifies them. |
| Must we component-test `+page.svelte`? | No. Keep extracting into `src/lib/*.ts`. 1.0 testing is unit + contract + sidecar E2E + one packaged Windows smoke. |
| Is BYOM `/v1/embeddings` a 1.0 blocker? | No. Catalog has zero embedding models. 1.0.0 recipes are chat completions. The embeddings **path** ships in 0.9.0 (Wave 9). Full RAG stays after 1.0. |
| Broader WebM/Opus/MP3 decoder for 1.0? | No. Browser `decodeAudioData` → 16 kHz WAV already ships. Document supported formats. Word-level timestamps stay upstream-blocked. |
| Must CI install the MSI to ship 1.0? | No, if clean-machine dogfood is recorded. Staged-layout smoke in CI; msiexec automation is later. |
| Is the updater broken? | Unexercised, not unwired. `releases/latest` 404s because 0.7.0 is a prerelease. **0.9.0** is the first stable publish and the upgrade-test; **1.0.0** follows after that works. |
| Native tray vs frontend tray? | Native tray from app start, not a Svelte tray created on first close. Dock Reopen is already native. Quit-flush handshake is separate. |
| Conversation data loss on quit? | 1.0. Native `ExitRequested` → flush → ack. |
| In-flight generation dropped on conversation switch? | 1.0. Route by originating conversation id. |
| Settings baseline editor, export path proof, inventory re-take, Compare without HTTP? | Post-1.0. |
| "No end-user Node"? | Already true for packaged builds. Further spawn-surface shrinkage is post-1.0. |

## 1.0 workstreams

| Capability | Target scope | Wave |
|---|---|---|
| **Capability audit and boundary suite** | Pruned `default.json` plus a dedicated security suite. | 1 |
| **CI Foundry native cache and SDK pin** | Cache nuget payload; exact SDK pin; startup warning. | 1 |
| **Native tray and quit flush** | Renderer-independent Open/Quit; `ExitRequested` handshake. | 2 |
| **Conversation-id stream routing** | Background generation finishes in its archive. | 2 |
| **Cancel/timeout certainty** | Honest certainty on chat, gateway, audio, compare. | 3 |
| **Gateway metrics and health ring** | TTFT/tok/s in UI and logs; bounded health history in diagnostics. | 4 |
| **Behavioral self-test and verified recipes** | In-app runner; catalog vs verified labels; pinned Continue/Cline/OpenClaw. | 5 |
| **Operator runbook and UX qualification** | Admin doc + checklist holes only. | 6 |
| **Packaged Windows smoke and dogfood** | Staged-exe ready-check in CI; recorded clean-machine install. | 7 |
| **Updater install UX and first stable** | Progress/restart/defer; **0.9.0** on `releases/latest`. | 8 |
| **Embeddings path** | Gateway autoload, BYOM without chat template, `embedTexts`. | 9 |

Post-1.0 (not in the table): extra audio decoders, word-level timestamps, multi-endpoint scheduler, Azure connections, curated ONNX catalog, Apple notarization, Linux, full RAG. 1.0.0 is bugfixes after the 0.9.0 upgrade is proven.

### Source anchors

- Data/requests: `src/routes/+page.svelte`, `src/lib/conversation-repository.ts`, `src/lib/conversation-store.ts`, `src/lib/conversation-session.ts`, `src/lib/conversation-settings.ts`, `src/lib/conversation-export.ts`, `src/lib/chat-request.ts`.
- Runtime transport: `src/lib/sdk.ts`, `src/lib/operation-outcome.ts` (transport tests: `src/lib/sdk-transport.test.ts`).
- Service/inference: `sidecar/foundry-sidecar.js`.
- Pool/gateway: `sidecar/gateway.js`, `sidecar/pool-eviction.js`, `sidecar/inference-metrics.js`.
- Models/import: `sidecar/byom-import.js`, `sidecar/prompt-template.js`, `sidecar/model-registry.js`.
- Audio/memory: `sidecar/audio-format.js`, `src/lib/memory-watchdog.ts`, and `transcribeLongAudio` in `src/routes/+page.svelte`.
- Desktop/packaging: `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `scripts/verify-bundle.cjs`, `scripts/smoke-bundled-node.cjs`, `vite.config.js`.
- Integrations: `src/lib/integrations.ts`.

Follow symbols rather than line numbers; the review-baseline line ranges these anchors originally carried no longer track the tree.

## Gate for reconsidering a Rust runtime replacement

Revisit only after the critical data/runtime findings have been corrected and native supervision is stable:

- Supported Rust/native bindings cover the required Windows/macOS catalog, variants, EPs, streaming, multimodal, audio, and model/cache operations.
- The same behavioral contract covers both implementations, including partial failure, cancellation uncertainty, and process recovery.
- A bounded prototype demonstrates a material benefit in responsiveness, reliability, startup, or distribution cost. Language preference alone is not sufficient evidence.
- There is still one manager/pool authority, and native failure remains isolated from the desktop process. `spawn_blocking` alone is not process crash isolation.
- Cutover/rollback does not require simultaneous cache/data migration, duplicate runtimes, or replaying uncertain operations.

The near-term destination is a **native desktop supervisor with a reliable, replaceable runtime process**, not a deadline-driven removal of Node.
