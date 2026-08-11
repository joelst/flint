# Flint Release Roadmap (0.1 → 1.0)

**Last updated:** 2026-08-06 (rev. 7 — packaging/rebind on main; docs & Help; 0.3.x tag still open)  
**Original date:** 2026-06-24  
**Scope:** Living release roadmap — tracks readiness decisions, known limitations, and per-release objectives from MVP 0.1 through 1.0. This is the **only** living release planner for scorecards and milestone scope. Day-to-day product sequencing (docs, help, 1.0 bar) lives in [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md).

---

## Release Status Dashboard

| Release | Branch | Version | Status |
|---|---|---|---|
| **0.1** | `mvp-0.1-alpha` | 0.1.0 | ✅ Released (dogfood baseline) |
| **0.2** | merged → `main` | 0.2.0 | ✅ Released (security hardening + lane routing) |
| **0.3** | `main` | **0.3.3** (tree) | 🟡 **Feature-complete**; packaging + rebind + network Apply + Help/README landed. **Public `v*` tag** still needs secrets, dogfood, release workflow dry-run |
| **0.4** | Not started | — | 📋 Planned (see §5; pick few flagships after 0.3 tag) |
| **1.0** | Not started | — | 📋 Planned (no end-user Node on PATH; signed installs; help locked — [PRODUCT_PLAN §E](./docs/PRODUCT_PLAN.md)) |

### 0.3.x packaging & product (landed on `main` after scorecard below)

| Item | Status |
|---|---|
| Foundry natives in installers (`ensure:foundry`, target-aware) | ✅ |
| Flattened resources; **Flint.exe**; production sidecar paths | ✅ |
| Service rebind on network Apply & restart (singleton clear) | ✅ |
| Drop unsupported `x86_64-apple-darwin` release target | ✅ |
| README “why Flint” + CLI vs full SDK catalog | ✅ |
| In-app **Help** + first-run coach | ✅ |
| Short [USER_GUIDE.md](./docs/USER_GUIDE.md) | ✅ (docs track) |

---

## 0.3 Progress Scorecard (features as of 2026-07-08; packaging notes 2026-08-06)

All planned 0.3 **product** work is complete (plus bonus features). Code version is **0.3.3**. Remaining gate for a **public release tag** is release mechanics and dogfood — not more 0.3 features.

| Success Criterion | Status | Notes |
|---|---|---|
| Model pool (multi-model concurrent load + pool visible in Monitor) | ✅ Complete | `Map<alias,{catModel,variantId}>`, `ensureModel`, HTTP routing by variantId |
| Access log (IPC requests in Monitor tab + `~/.flint/logs/`) | ✅ Complete | Ring buffer (500 entries) + 7-day disk rotation |
| Audit trail (8 destructive/config commands produce `type:audit` entries) | ✅ Complete | `init`, `download`, `load`, `unload`, `deleteModel`, `startService`, `stopService`, `setLogLevel` |
| Monitoring view (pool table, resource gauge, access log table, export) | ✅ Complete | Monitor tab with live polling, CSV/JSON export |
| Network config (bind address + port configurable in Settings) | ✅ Complete | 127.0.0.1 default preserved; warning banner for non-loopback |
| Keyboard shortcuts (send, new chat, view navigation, push-to-talk, `?` ref panel) | ✅ Complete | Ctrl/Cmd+1–5, B, N, `,`, Space, Enter; shortcut reference modal |
| Auto-start (default chat + audio model pre-selected on launch) | ✅ Complete | `tauri-plugin-autostart` integrated; OS login-item toggle |
| Vision: multiple images (up to 4, thumbnail strip, drag-and-drop) | ✅ Complete | `attachedImages[]` state, paste + drag-and-drop, vision-gated |
| Model comparison / bake-off (two models side-by-side, ratings, export) | ✅ Complete | Compare tab, parallel non-streaming runs, thumbs up/down, markdown export |
| Purview SDK governance memo | ✅ Complete | `docs/PURVIEW_GOVERNANCE.md` |
| Integration snippets / tool onboarding | ✅ Complete | Integrations tab, data-driven catalog, OS toggle, copy buttons |
| CI/CD: release pipeline scaffolding + updater plugin infrastructure | ⚠️ Partial | Workflow + packaging fixes on `main`; **operator secrets / pubkey / tag** still the gate |
| Version on `main` | ✅ 0.3.3 | Changesets used for later patches; hand-written `[0.3.0]` section exists in CHANGELOG |

### Bonus — delivered beyond original 0.3 scope

| Feature | Status | Notes |
|---|---|---|
| Host-aware chat context (`flint-context.ts`) | ✅ Complete | Compact identity line every turn + expanded Foundry/Flint fact sheet gated on app-intent regex; de-dupes against persona; unit-tested (`flint-context.test.ts`) |
| Guarded web-fetch → chat context (`fetchUrl`) | ✅ Complete | Sidecar command: http/https-only, private/loopback SSRF block, size cap, `@mozilla/readability` + `jsdom` article extraction, access-log audit entry. SDK method + chat URL-detection chips + context injection. Type-checks clean; release build produced `Flint_0.3.0_x64_en-US.msi`. **This is a down-payment on 0.4 RAG** (the "inject external content as context" pipeline). |
| Acceleration-aware model update notifications | ✅ Complete | Cached variants are compared only with newer catalog variants in the same SDK model-name/runtime track, preventing CPU/GPU/NPU cross-grade suggestions. Models view shows update counts and direct per-variant downloads. |

### Remaining blockers for a public 0.3.x tag (in dependency order)

1. **Updater signing key** — generate / confirm `plugins.updater.pubkey` and private key secret (see [docs/RELEASE.md](./docs/RELEASE.md)).
2. **GitHub Actions secrets** — Windows code-signing cert + password (and macOS secrets if shipping Mac).
3. **Release workflow dry-run** — `workflow_dispatch` with an RC version before a real `v*` tag.
4. **Clean-machine dogfood** — install, Node-missing UX, model download/chat, service start, network Apply & restart, Integrations copy.
5. **Tag `v0.3.3`** (or chosen 0.3.x) — produces draft GitHub Release with installers.

Product sequencing while ops runs: [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md).

---

## 1) MVP 0.1 Readiness Review (against original MVP plan)

Original MVP expectation (from `FLINT_DESIGN_SPEC.md` and the archived `docs/archive/MVP_FEATURE_COMPLETION_PLAN.md`) was:

- Model management (catalog/search/download/load/unload)
- Streaming chat UX
- Audio transcription
- Diagnostics + endpoint snippets
- Local-first posture and basic testability

### Status Snapshot

| Area | Current State | Readiness |
|---|---|---|
| Models | Catalog + filtering + download/load/unload are present; STT and vision filtering are metadata-driven; model detail panel (task/context/capabilities) is available | **Ready** |
| Chat | Streaming works; stop/cancel path exists; conversation sidebar + markdown renderer + thinking trace UX implemented | **Ready** |
| Audio | Mic + file transcription flow implemented via sidecar service endpoint; STT model selection present | **Ready** |
| Diagnostics | Service status/start/stop + endpoint display + copy snippets present; execution provider inventory and acceleration preference are exposed; full diagnostics export is still basic | **Partial** |
| Sidecar | Ready signal, status, load/download/chat/transcribe, cancel request support all implemented | **Ready** |
| Security baseline | Local-first defaults, HTML sanitization in renderer, sidecar stderr/stdout capture | **Partial** |
| Testing baseline | Vitest foundation + core unit tests + sidecar protocol test + coverage thresholds | **Ready (basic)** |

### Decision

**Yes — declare MVP 0.1 ready for release as a practical MVP baseline** (dogfood/public preview grade), with explicit documented limitations below.

This is not "feature complete forever"; it is a valid 0.1 checkpoint with clear follow-up scope for 0.2.

---

## 2) Known Limitations for MVP 0.1

### Product / UX limitations

- Diagnostics export is still lightweight and not a full support bundle workflow.
- Cache management is partially wired (remove/clear behavior needs final hard wiring and validation end-to-end).
- Some advanced chat ergonomics (deep per-conversation controls, richer controls around system prompt policies) remain basic.

### Multi-endpoint limitations

- Current architecture is effectively **single active local endpoint / active model path** for most user flows.
- Chat and audio flows can contend for the active model/service selection.

### Security limitations

- Tauri shell capability currently allows `node` spawn/stdin with broad `args: true`, increasing attack surface.
- Markdown sanitization is custom and conservative, but should be hardened with explicit security tests and CSP-level verification.
- No explicit sidecar command allowlist enforcement beyond command parsing logic.

### Testing limitations

- Test coverage is intentionally foundational (unit + sidecar contract baseline), not full UI/E2E confidence.
- Coverage thresholds currently target core modules under test, not entire app runtime surfaces.
- No performance/load tests for concurrent endpoint or model switching scenarios yet.

---

## 3) MVP 0.2 Plan (rubber-ducked and scope-locked)

### MVP 0.2 objectives

- Harden trust boundaries (renderer + sidecar + shell permissions).
- Support practical multi-endpoint use without full scheduler complexity.
- Raise confidence with deterministic tests and CI quality gates.
- Investigate tool calling as a Foundry Local capability surfaced through Flint, not as a separate Flint-native tool runtime.
- Add realtime voice dictation into the chatbox so speech can become text input without a record-then-transcribe detour.

### What is explicitly in 0.2 (must-have)

1. **Security boundary hardening**
   - Replace broad shell invocation surface with least-privilege settings.
   - Introduce strict sidecar command schema validation (type/shape/limits).
   - Enforce explicit command allowlist and reject unknown fields.
   - Add renderer sanitization regression tests and validate CSP/WebView posture.

2. **Minimal multi-endpoint architecture (no scheduler yet)**
   - Add endpoint profiles (name/type/base URL/auth/routing role).
   - Add explicit lane routing:
     - chat lane -> selected chat endpoint
     - audio lane -> selected audio endpoint
   - Keep model-to-endpoint strategy simple: one active model per endpoint lane.

3. **Testing and quality gates**
   - Expand sidecar contract tests (error paths, malformed payloads, cancellation timing).
   - Add deterministic Tauri smoke flow in CI: launch -> init -> model list -> chat -> audio happy path.
   - Increment coverage thresholds and widen include scope per milestone.

4. **Tool-calling security + UX investigation**
   - Map which tool-capable scenarios are actually provided by Foundry Local / OpenAI-compatible endpoints.
   - Define what Flint owns: endpoint setup, profile management, snippets, visibility, and auditability.
   - Decide how user confirmation, allowlisting, and prompt-injection protections should behave before any agent-like execution is exposed.

5. **Realtime voice input**
   - Add push-to-talk / live dictation support that inserts partial speech-to-text into the chatbox.
   - Reuse the existing transcription pipeline where possible, but optimize for low-latency incremental text updates.
   - Keep the existing record-and-transcribe flow as the fallback path.

### Deferred from 0.2 (post-0.2/1.0+)

- Endpoint scheduler (sticky routing + fallback orchestration).
- Role-like controls for shared environments.
- LRU unload/admission control engine.
- Full telemetry dashboard (latency percentiles, memory trends, error analytics).
- Hardware matrix automation in CI (CPU/GPU/NPU) beyond manual/nightly validation.

### Milestones and sequencing

1. **M1 — Contract freeze + scope lock**
   - Version sidecar protocol contract and define validation rules.
   - Publish explicit 0.2 non-goals.

2. **M2 — Security hardening**
   - Implement shell capability reduction.
   - Implement sidecar schema + allowlist enforcement.
   - Add sanitization/CSP regression tests.

3. **M3 — Multi-endpoint foundation**
   - Implement endpoint profiles and secure local storage for credentials.
   - Implement explicit chat/audio lane routing.
   - Verify no chat/audio model thrash in normal workflows.

4. **M4 — Reliability + CI confidence**
   - Expand sidecar contract tests (cancel/error/malformed/large payload).
   - Add/solidify deterministic Tauri smoke test in CI.
   - Raise coverage gate and widen target modules.

5. **M5 — Optional stretch (only if ahead)**
   - Basic endpoint health snapshot in diagnostics export.
   - Initial observability counters (queue depth, active lane/endpoint).

### MVP 0.2 exit criteria (verifiable)

- **Security:** least-privilege shell capability model in place; sidecar rejects invalid/unknown payloads.
- **Architecture:** chat and audio can run on different configured endpoints in same session without forced lane contention.
- **Reliability:** cancellation and invalid payload behavior are deterministic and tested.
- **Quality:** CI runs unit + contract + smoke tests; coverage threshold increased from 0.1 baseline.
- **Tooling:** tool-calling boundaries are documented, and the Flint/Foundry Local split is explicit in docs and UI copy.
- **Voice:** dictation can feed the chatbox in real time, with a clear fallback to the current transcription flow.

### MVP 0.2 Status: ✅ RELEASED (v0.2.0)

All exit criteria met. Merged to `main` as v0.2.0 via PR #2. Security hardening, lane routing, reliability improvements, and version/changeset infrastructure are all in place.

---

## 4) MVP 0.3 Plan

> **Status (2026-07-08): Feature-complete on `mvp-0.3` branch. See the [0.3 Progress Scorecard](#03-progress-scorecard-as-of-2026-07-08) at the top of this document for the detailed grade. All core and stretch items are done; the remaining gate is cutting the signed release.**
>
> Items 3 (Vision multi-image) and 4 (Model comparison) were originally listed as 0.4 scope but were pulled into the 0.3 sprint and completed. Items A (Audit log export) and B (Network config UI) were similarly pulled from 0.4 and completed.

### 0.3 objectives

- Generalize the two-lane model into a flexible model pool so any number of models (chat, audio, or otherwise) can be resident simultaneously based on hardware availability.
- Add a real-time monitoring view that surfaces who is using the local endpoint, what resources are consumed, and what the runtime is doing.
- Begin network security management: access controls and per-client logging for the local OpenAI-compatible service.
- Research and define the routing architecture before committing to a scheduler design.
- Easy setup options to configure Foundry Local as backend for OpenClaw, Claude Code, etc.

### Open research item: routing architecture

Routing in Flint touches several layers and needs deliberate design before any scheduler is built:

- **Request routing**: when multiple models are loaded, which one handles an incoming request? Options include explicit user selection (current), capability-based auto-routing (vision requests → vision model, audio → STT model), and queue-depth-based routing (route to the least-busy loaded model).
- **Endpoint routing**: when the user has both a local Foundry model and a remote Azure endpoint configured, which endpoint gets a given conversation? Sticky-by-conversation, explicit per-chat selection, or rule-based (e.g. "use local unless prompt exceeds context length")?
- **Fallback routing**: if the primary model is evicted or the endpoint is unreachable, automatically retry on a configured secondary. Requires health-check awareness.
- **Load balancing**: if multiple instances of Foundry Local are running (or multiple endpoints are healthy), distribute load across them. Likely only relevant for team/shared deployments; probably post-1.0.

**Recommended approach for 0.3**: do the spike on model pool behavior first (section 1 below), then design the capability-based auto-routing rules as the only new routing in 0.3. Defer the full scheduler (sticky, fallback, load balancing) to 0.4 or later once the pool behavior is understood empirically.

### What is in 0.3 (proposed)

0. **Integration snippets / tool onboarding** (first milestone — easiest user-visible win)
   - Dedicated **Integrations** nav section listing AI coding tools that can use Flint's local OpenAI-compatible endpoint.
   - **Reference model**: Ollama's [integrations page](https://docs.ollama.com/integrations) — same shape (categorized tool cards with copy-paste setup), but Flint does **not** ship CLI installers / one-line install scripts. Snippets only; the user runs the tool install themselves.
   - Data-driven catalog (`src/lib/integrations.ts`) with per-tool:
     - Name, description, category, status (`verified` / `community` / `research-needed` / `unsupported`).
     - OS-specific setup snippets (Windows PowerShell + macOS/Linux bash).
     - Required env vars / config-file paths / CLI flags.
     - Known limitations (e.g. requires translation proxy for non-OpenAI-protocol tools).
     - Upstream docs link for verification.
   - Card UI with OS toggle, copy buttons, expandable "limitations" panel, status badge.
   - **Initial verified entries (target for first cut)**: Continue.dev, generic OpenAI SDK.
   - **Community-reported entries**: GitHub Copilot for VS Code (native Foundry Local support), OpenClaw via LiteLLM proxy.
   - **Research-needed scaffolds (banner says "unverified")**: OpenCode, Codex CLI, Cline, Hermes Agent, Droid, Pi.
   - **Documented as unsupported / proxy-required**: Claude Code (Anthropic protocol — needs LiteLLM translation proxy), GitHub Copilot **CLI** (GH-proprietary backend, distinct from the VS Code extension), OpenAI Codex App (hosted, not redirectable).
   - **Out of scope for 0.3**: auto-run "install for me" buttons that would write to user shell configs / VS Code settings. Snippets only — preserves the least-privilege shell capability work from 0.2.

0b. **Local API-key proxy and multi-model routing** (research)

   - Many OpenAI-compat clients enforce non-empty / well-formed API keys; "dummy" strings work in some clients and fail in others (header validation, key prefix checks, etc.). Some agentic tools also expect bearer tokens for sub-features (telemetry endpoints, billing checks) that fail noisily against a local endpoint that has no auth surface.
   - **Investigate**: bundling a tiny optional auth-proxy in front of Flint's local endpoint that (a) accepts any key matching a user-issued local token, (b) optionally translates OpenAI → Anthropic protocol for Claude Code, (c) issues per-tool tokens visible in a "local API keys" UI for audit/revoke.
   - **Two-for-one opportunity**: the same proxy layer could also provide the **request-routing fabric** called for in item 1 (model pool) and the routing-research block — LiteLLM-style proxies natively support cross-backend routing rules (capability-based, fallback, sticky). If Flint already runs a local proxy, the routing layer is "free."
   - **Candidate stack**: LiteLLM (mature, already widely referenced for OpenClaw + Azure Foundry recipes).
   - **Trade-offs to weigh explicitly before adopting**:
     - **Pro**: solves dummy-keys, protocol translation, multi-backend routing, audit-able local tokens — all in one component already battle-tested across the ecosystem.
     - **Pro**: removes the need for Flint to write a routing layer from scratch (less Flint code = less Flint security surface).
     - **Con**: pulls in a Python runtime and its full transitive dependency tree (FastAPI, uvicorn, Pydantic, provider SDKs). Each is its own CVE surface to track.
     - **Con**: LiteLLM ships frequent releases with breaking changes; bundling pins us to coordinating updates or shipping a wide version range.
     - **Con**: violates the current "bundle is ~20 MB, runtime is just Foundry Local + Node sidecar" footprint promise. Embedding Python is a category change for Flint's install size and threat model.
   - **Decision needed before implementation**: is this Flint-owned (bundled sub-process, integrated UI) or a documented external dependency (linked recipe, opt-in install)? Strong lean toward **documented external dependency** for 0.3 — keeps Flint small and lets the security-conscious user opt into the proxy explicitly. Bundling is a 0.4-or-later conversation, contingent on the routing layer becoming a must-have rather than a nice-to-have.
   - **Direct-integration first; no compatibility hacks**: where a client supports a standard OpenAI base-URL override (e.g. OpenClaw per its [local-models docs](https://open-claw.bot/docs/gateway/local-models/#other-openai-compatible-local-proxies)), Flint documents the direct path. Where a client is wire-bound to a different protocol (e.g. Claude Code → Anthropic Messages API), we mark it **unsupported** and point users at OpenAI-compatible alternatives. We do not ship translation-proxy workarounds that "kinda work" — a lossy bridge to Claude Code (no prompt caching, broken extended thinking, fragile tool-use) is worse than a clear "use a different client" message.

0c. **Governance & telemetry research — Microsoft Purview SDK**

   - Investigate the Microsoft Purview SDK / APIs for capturing useful governance data about Flint usage in managed environments (model-load events, endpoint access patterns, prompt/response audit hooks where the user opts in).
   - **Goals**: surface enterprise-relevant signals (which models were loaded, by which user, what data crossed the local endpoint, retention) without breaking Flint's local-first / no-telemetry-by-default posture.
   - **Constraints**:
     - All Purview reporting must be off by default and gated by explicit per-machine policy (consistent with 0.4 enterprise controls).
     - Must respect the security organization instruction not to ship customer PII or employee pay/HR data through generated reports.
     - Prompt/response content is the most sensitive surface — default to metadata-only (event types, counts, model aliases, timestamps) unless the operator opts content in.
   - **Deliverable in 0.3**: a short design memo answering: which Purview ingestion path (Activity Log API, Audit log, Information Protection labels), what metadata schema to emit, and what the opt-in UX looks like. Implementation lands no earlier than 0.4 enterprise controls.

1. **Model pool (replaces named lanes)**
   - Replace `lane.chat` / `lane.audio` with a `Map<alias, LoadedModel>` pool in the sidecar.
   - `ensureModel(alias)` loads into the pool if absent; all callers (chat, audio, dictation) request by alias.
   - Keep the current lane routing hints (`lane?: 'chat' | 'audio'`) as soft labels for routing preference, not hard ownership.
   - Hardware-aware admission: before loading, estimate model VRAM footprint from catalog metadata and compare against available headroom. Fail gracefully with a clear "not enough memory" message rather than silent eviction.
   - Hot-switch: when the user switches chat models, the old model stays resident until explicitly unloaded or memory pressure forces eviction. No forced unload on switch.
   - **Prerequisite spike — COMPLETE. Verdict: `optimistic-pool-works`.** Both models (phi-4-mini 4.9 GB + mistral-7b 4.2 GB) loaded simultaneously at 10.37 GB RSS with no eviction. HTTP routing works; chat-A-2 (185 ms) was faster than chat-A-1 (231 ms) confirming A stayed resident. Full results: [docs/pool-spike-results/pool-spike-2026-06-26T05-38-18-941Z.md](./docs/pool-spike-results/pool-spike-2026-06-26T05-38-18-941Z.md). Protocol: [docs/POOL_SPIKE.md](./docs/POOL_SPIKE.md); script: [sidecar/scripts/pool-spike.mjs](./sidecar/scripts/pool-spike.mjs).
   - **Design finding — HTTP endpoint routes by variant ID, not alias.** `model: "phi-4-mini"` returns HTTP 400; `model: "Phi-4-mini-instruct-generic-cpu:5"` returns HTTP 200. The `ModelPool` must store `Map<alias, { model, variantId }>` and use the variant ID in all HTTP requests to the local service. External tools connecting to Flint's endpoint also need the variant ID — the Integrations tab snippets must document how to discover it.
   - **Sidecar bug — `startWebService` call signature**: `foundry-sidecar.js` currently calls `manager.startWebService({ port })` but in the installed SDK version `startWebService()` takes no arguments and returns void; the actual endpoint URLs are read from `manager.urls` after the call. The `{ port }` argument is silently ignored, and the port/fallback-URL chain in the sidecar accidentally works only because it falls back to the hardcoded `http://localhost:${port}/v1` string. Fix this as part of the pool redesign: remove the argument, read `manager.urls` afterward, and surface the real bound URL in `getStatus`.

2. **Monitoring view** (new nav section)
   - Live snapshot of the model pool: each loaded model with alias, lane hint, estimated VRAM, and last-used timestamp.
   - Token counters: cumulative input/output tokens per model per session (tracked in sidecar, surfaced via `getStatus`).
   - Memory gauge: reported or estimated resident memory per loaded model; aggregate vs. available.
   - Active request indicator: whether a stream is in progress, which model, elapsed time.
   - Client access log: for each request to the local service, log the source IP / process hint, timestamp, model, and request type (chat/audio/other). Display as a rolling table in the monitoring view.
   - Depends on network security work below to make client identity trustworthy.

3. **Network security and access logging** (prerequisite for meaningful monitoring)
   - Bind the local service to `127.0.0.1` only by default (reject connections from other hosts unless explicitly configured).
   - Add a per-request access log in the sidecar: `{ ts, sourceIp, method, path, modelAlias, durationMs, tokensIn, tokensOut }`.
   - Expose the access log via a sidecar command (`getAccessLog`) and surface it in the monitoring view.
   - Optional allowlist: let the user configure which IPs or local process names may connect. Block others with a 403.
   - Note: process identification from an HTTP request is not reliably available cross-platform; surface IP + user-agent as a best-effort proxy. Document the limitation clearly in the UI.

4. **Keyboard shortcuts**
   - Global shortcuts for send, new chat, model switch, push-to-talk dictation, view navigation.
   - Configurable bindings stored in settings; displayed in a shortcuts reference panel.

5. **Auto-start and default model configuration**
   - Set one or more models to load automatically when Flint launches.
   - Optional OS-level startup: register Flint as a login item (Windows startup / macOS Login Items) so the endpoint is available before the user opens the window.
   - Per-model startup role: mark a model as "default chat" or "default audio" so the UI pre-selects it without manual intervention.

6. **CI/CD and installer improvements**
   - Build signed installers (Windows MSIX/EXE, macOS DMG with notarization) in CI.
   - Automated version bump and changelog generation on tag.
   - Delta/auto-update channel so users get patch releases without manual reinstall.

### Deferred from 0.3 to later

- Full endpoint scheduler (sticky routing, fallback, health-check-based failover).
- Persistent telemetry storage across sessions (token trend graphs, memory history).
- Role-based access controls for shared-machine or shared-network scenarios.
- Azure AI Foundry cloud connections (still high-priority but now **unblocked** after 0.3 security foundation).
- Inline image previews inside chat thread message bubbles (vision attach works; bubble display deferred).
- Async streaming model comparison (synchronous comparison shipped in 0.3; streaming side-by-side deferred).
- Auto-update UX: in-app "Check for updates" flow deferred until pre-1.0.

---

## 5) MVP 0.4 Plan (outline)

> **Note (2026-07-08):** Several items that were originally listed here were pulled forward into the 0.3 sprint and are now **complete**:
> - ✅ Vision multi-image + drag-and-drop (shipped in 0.3)
> - ✅ Model comparison / bake-off (shipped in 0.3)
> - ✅ Enterprise controls: audit log export (shipped in 0.3)
> - ✅ Enterprise controls: network config UI / bind address (shipped in 0.3)
> - 🟡 **RAG "external content → context" pipeline partially started** — the 0.3 web-fetch feature (`fetchUrl` + chat URL-context injection) already builds the fetch → sanitize → inject-as-context path. 0.4 RAG extends this from single-URL to indexed local files. See RAG item below.
>
> The 0.4 scope below reflects the updated plan after these pull-ins.

### 0.4 objectives

Expand Flint's inference capabilities into retrieval-augmented generation and tool-calling. Add the remaining enterprise control layer. Land Azure AI Foundry cloud connections, now unblocked by the 0.3 security foundation.

### What is in 0.4 (proposed)

1. **Tool calling — execution layer**
   - 0.2 documented the boundary (Foundry Local emits `tool_calls`; Flint does not execute). 0.4 adds opt-in execution inside Flint for a limited, user-confirmed tool set.
   - User defines an allowlist of tools (shell commands, file reads, HTTP calls). Each tool invocation requires explicit one-time or session-scoped confirmation.
   - Visible audit trail: every tool execution logged with inputs, outputs, and which model requested it.
   - Prompt-injection guard: heuristic scan of model output before executing any tool call.
   - Non-goal: autonomous multi-step agent loops without confirmation. Every tool execution is a manual gate.

### Open architectural decision: agent loops — Flint-native vs. upstream delegation

**The question**: should Flint ever run autonomous multi-step agent loops (model calls a tool, sees the result, calls another tool, repeats without user confirmation per step), or should that always be delegated to purpose-built tools like OpenClaw and Scout?

**Recommendation: delegate to upstream tools, with one narrow exception.**

Reasons to delegate:

- OpenClaw, Scout, and similar tools are purpose-built for agentic workflows: they have loop management, tool registries, sandboxing, permission models, and observability that would take significant effort to replicate well.
- Flint's architecture (Tauri desktop app, sidecar process) is optimized for interactive use, not long-running headless agent processes. A multi-minute autonomous loop running inside Flint while the user does something else is a poor fit.
- Duplicating agent loop logic creates a fragmented ecosystem where users have to choose between Flint-agents and OpenClaw-agents for the same models. Better to make Flint the best possible backend for OpenClaw and Scout to connect to.
- Security surface: every tool execution step that doesn't require confirmation is an attack surface. Flint's local-first posture makes this risk higher, not lower.

The narrow exception — **user-initiated linear chains**:
A linear chain (run prompt A → pipe output into prompt B → show final result, with user triggering each step) is meaningfully different from an autonomous loop. If demand exists, Flint could support 2–3 step user-confirmed pipelines as a UI feature without building a general agent runtime. This would look like a "chain" tab, not an "agent" mode.

**Decision to make before 0.4 tool calling work begins**: confirm with OpenClaw and Scout maintainers whether there are integration gaps that only a Flint-native execution layer could fill. If the answer is no, keep the manual-gate model and improve the endpoint/tool-call visibility surface instead.

2. **RAG (retrieval-augmented generation)**
   - **Already started in 0.3**: the `fetchUrl` web-fetch pipeline (guarded fetch → Readability extraction → inject as chat context) is the single-source version of this. 0.4 generalizes it to a persistent, indexed knowledge base.
   - Index local folders or files into an embedded vector store (e.g. sqlite-vec or a lightweight HNSW store).
   - At query time, retrieve relevant chunks and inject into the system/context window before sending to the model — reuse the 0.3 context-injection path rather than building a new one.
   - UI: attach a knowledge base to a conversation; show which chunks were retrieved and their sources (the web-fetch chips are the UI precedent).
   - Scope: local files only for 0.4. Remote/URL indexing deferred — but single-URL fetch already ships in 0.3.

3. **Workspace export / import**
   - Export a workspace bundle: selected models list, endpoint profiles, personas, conversation history, settings.
   - Import a bundle to restore or migrate to another machine.
   - Credentials (auth tokens) excluded from export bundles; user must re-enter on import.

4. **Azure AI Foundry cloud connections** *(unblocked by 0.3 security foundation)*
   - Add endpoint profiles for Azure AI Foundry (name/type/base URL/auth/routing role).
   - Connect to cloud-hosted models alongside local Foundry Local models in the same session.
   - Surface cloud endpoints in the model catalog and lane routing UI.
   - Credential storage: secure local storage (OS keychain) — no credentials in localStorage or on disk in plaintext.

5. **Enterprise controls (remaining after 0.3 pull-ins)**
   - Per-model or per-endpoint allow/deny rules; optional API key requirement for the local service.
   - Policy file: machine-level JSON config that can be pre-deployed by IT to enforce defaults before user launch.
   - Purview SDK implementation — memo is done (`docs/PURVIEW_GOVERNANCE.md`); implement the ingestion path and opt-in UX defined there.
   - Persistent token trend graphs and memory history across sessions.

6. **Vision polish** *(deferred from 0.3)*
   - Inline image preview thumbnails rendered inside the chat thread message bubbles (multi-attach works; bubble display was deferred).

7. **Auto-update UX** *(deferred from 0.3 CI/CD work)*
   - In-app "Check for updates" button calling the updater plugin APIs (`check()`, `downloadAndInstall()`).
   - Release notes modal surfacing the changelog.
   - The updater infrastructure (plugin, pubkey, endpoint) is already wired in 0.3 bundles — this is the user-facing layer.

8. **Full endpoint scheduler** *(deferred from 0.3)*
   - Sticky routing, fallback, and health-check-based failover.
   - Route chat to local when context fits; escalate to cloud endpoint when prompt exceeds local context length.

### Deferred from 0.4 to later

- Multi-user or shared-server deployment mode.
- Async streaming model comparison (show responses as they stream side-by-side).
- Load balancing across multiple Foundry Local instances.

---

## 6) Additional Future Milestones (post-0.4 ideas)

1. **Plugin-style connector framework**
   - Add provider adapters (Azure/OpenAI-compatible, additional local runtimes) behind one interface.
2. **Conversation intelligence**
   - Per-conversation endpoint pinning, retry policy, and export/import.
3. **Performance toolkit**
   - Benchmark mode for model + endpoint comparisons (latency, throughput, memory).
4. **User onboarding**
   - Guided setup for endpoint profiles and tool integration recipes.
5. **Model catalog details v2 (backlog)**
   - Expand model details modal with full upstream metadata, benchmark notes, and platform-specific acceleration compatibility matrix (Windows/macOS/Linux).
   - Replace heuristic memory guidance with measured baseline telemetry per model/provider where available.
   - Add an inventory view that can list all models with per-model disk usage and supported acceleration providers.
6. **Deferred hardening items (queued)**
   - Add defensive environment guards for `DOMParser` / `NodeFilter` in message sanitization so utility calls remain safe if reused in non-browser execution contexts.
   - Improve sidecar audio input reliability by validating actual WAV bytes (or adding explicit transcoding) instead of relying on filename extension conventions.
   - Broaden coverage gating beyond the current narrow include list so new SDK/sidecar logic changes affect quality gates by default.

---

## 7) What Release 1.0 Should Look Like

Release 1.0 should represent **production-grade local AI operations**, not just "working features."

### 1.0 release criteria

1. **Security**
   - Principle-of-least-privilege shell/capability model in place.
   - Security test suite for renderer/sidecar boundaries.
2. **Reliability**
   - Multi-endpoint manager with robust recovery and health checks.
   - Deterministic cancellation and timeout behavior across all request types.
3. **Testing**
   - Mature pyramid: unit + component + contract + E2E smoke/regression.
   - CI quality gates with meaningful coverage and stability thresholds.
4. **Observability**
   - Rich diagnostics export, operational metrics, endpoint health history.
5. **UX maturity**
   - Clear endpoint routing controls, memory/capacity UX, polished onboarding.
6. **Integrations**
   - Stable OpenClaw/other tooling integration docs and verified recipes.
7. **Documentation**
   - Deployment/admin guide, troubleshooting runbook, versioned release notes.

### 1.0 statement

If 0.1 is "usable MVP" and 0.2 is "hardened + scalable architecture", then **1.0 is "operationally trustworthy."**

---

## 8) Immediate Next Steps (as of 2026-07-08)

### Ship 0.3 (this week)

> Version is already `0.3.0` in all three files, so the old "bump" steps are replaced by "commit the outstanding work + reconcile the changelog." The signing/secrets steps are unchanged and remain the true blockers.

| Step | Action | Owner | Status |
|---|---|---|---|
| 1 | Commit outstanding 0.3 product work | Dev | ✅ Done |
| 2 | Hand-write `CHANGELOG.md` **0.3.0** section | Dev | ✅ Done |
| 3 | Generate Tauri updater signing key: `npx tauri signer generate -w ~/.tauri/flint.key` | Dev | ⬜ |
| 4 | Replace `PLACEHOLDER` pubkey in `src-tauri/tauri.conf.json` | Dev | ⬜ |
| 5 | Fix updater endpoint to real `owner/repo` | Dev | ✅ `joelst/flint` |
| 6 | Self-signed Windows PFX → GitHub secrets (`WINDOWS_CERTIFICATE` + password) | Dev | ⬜ |
| 7 | Test release workflow: `workflow_dispatch` with `0.3.0-rc1` | Dev | ⬜ |
| 8 | Fix any pipeline issues from step 7 | Dev | ⬜ |
| 9 | PR `mvp-0.3` → `main`; CI green; merge | Dev | ⬜ |
| 10 | Tag `v0.3.0` → signed release build | Dev | ⬜ |
| 11 | Review draft release; publish | Dev | ⬜ |

Also landed for dogfood UX: **Node.js 22+ preflight** before sidecar spawn + Learn/fact-sheet honesty. **0.4 Spike A Go:** release builds **bundle Node 22** via Tauri `externalBin` (`npm run ensure:node` / `smoke:node`) — PATH Node is fallback ([docs/spikes/node-bundle-spike.md](./docs/spikes/node-bundle-spike.md)). **Later:** optional thin `flint` control CLI (not Ollama/Foundry clone); targeted Rust bridge for selected commands.

### Start 0.4 planning (after 0.3 ships)

1. **Plan in this file** — add a **0.4 Progress Scorecard** (same shape as the 0.3 scorecard above) with objectives, status, and ordered work. Prefer **not** creating a separate `SPRINT_PLAN_0.4.md` unless execution detail would bloat this roadmap past readability; if a sprint file is spun out, keep a single file and still use this roadmap as SSoT for status. Historical 0.3 sprint docs live under `docs/archive/`.
2. **Prioritize 0.4 items** — recommended ordering based on dependency and impact:
   - **P1**: Azure AI Foundry cloud connections (highest user demand; now unblocked)
   - **P1**: Auto-update UX (infrastructure is ready; just the UI layer)
   - **P2**: RAG with local file indexing
   - **P2**: Enterprise controls remaining (policy file, per-endpoint allow/deny, Purview implementation)
   - **P3**: Workspace export/import
   - **P3**: Tool calling (requires architecture decision first — see agent loops section)
3. **Branch**: create `mvp-0.4` from `main` after 0.3 merges.
4. **Architecture decision**: before tool calling work begins, resolve the agent loop delegation question (Flint-native vs. OpenClaw) — this gates item ordering in 0.4.
5. **Deferred product-copy items** (Learn tab, flint-context fact sheet): [docs/BACKLOG.md](./docs/BACKLOG.md).
