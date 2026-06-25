# Flint Release Roadmap (0.1 -> 1.0)

**Date:** 2026-06-24
**Scope:** Readiness decision for MVP 0.1, known limitations, MVP 0.2 plan, and 1.0 definition.

---

## 1) MVP 0.1 Readiness Review (against original MVP plan)

Original MVP expectation (from `FLINT_DESIGN_SPEC.md` and `MVP_FEATURE_COMPLETION_PLAN.md`) was:

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

---

## 4) MVP 0.3 Plan

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

1. **Model pool (replaces named lanes)**
   - Replace `lane.chat` / `lane.audio` with a `Map<alias, LoadedModel>` pool in the sidecar.
   - `ensureModel(alias)` loads into the pool if absent; all callers (chat, audio, dictation) request by alias.
   - Keep the current lane routing hints (`lane?: 'chat' | 'audio'`) as soft labels for routing preference, not hard ownership.
   - Hardware-aware admission: before loading, estimate model VRAM footprint from catalog metadata and compare against available headroom. Fail gracefully with a clear "not enough memory" message rather than silent eviction.
   - Hot-switch: when the user switches chat models, the old model stays resident until explicitly unloaded or memory pressure forces eviction. No forced unload on switch.
   - **Prerequisite spike**: confirm whether Foundry Local will keep two chat-class models resident simultaneously without silently evicting one. If it evicts, design budget-aware proactive eviction instead of optimistic pooling. Run this spike before designing the pool API.

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
- Azure AI Foundry cloud connections (still high-priority but blocked on 0.3 security foundation).

---

## 5) MVP 0.4 Plan (outline)

### 0.4 objectives

Expand Flint's inference capabilities beyond single-turn chat into multi-modal, retrieval-augmented, and comparative workflows. Add the enterprise control layer that makes shared and managed deployments viable.

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
A linear chain (run prompt A → pipe output into prompt B → show final result, with user triggering each step) is meaningfully different from an autonomous loop. It is closer to the model bake-off feature (0.4) than to agentic execution. If demand exists, Flint could support 2–3 step user-confirmed pipelines as a UI feature without building a general agent runtime. This would look like a "chain" tab, not an "agent" mode.

**Decision to make before 0.4 tool calling work begins**: confirm with OpenClaw and Scout maintainers whether there are integration gaps that only a Flint-native execution layer could fill. If the answer is no, keep the manual-gate model and improve the endpoint/tool-call visibility surface instead.

2. **RAG (retrieval-augmented generation)**
   - Index local folders or files into an embedded vector store (e.g. sqlite-vec or a lightweight HNSW store).
   - At query time, retrieve relevant chunks and inject into the system/context window before sending to the model.
   - UI: attach a knowledge base to a conversation; show which chunks were retrieved and their sources.
   - Scope: local files only for 0.4. Remote/URL indexing deferred.

3. **Vision — multi-image and previews**
   - Extend the existing single-image attach to support multiple images per message.
   - Inline image preview thumbnails in the chat thread before and after submission.
   - Drag-and-drop image attachment directly into the chat input area.
   - Scope-gated by catalog: only surfaces for models whose capability flags include vision.

1. **Model comparison / bake-off**
   - Run a single prompt simultaneously against two or more loaded models and display responses side-by-side.
   - Optional scoring: rate each response (thumbs up/down or 1–5) to build a local preference log.
   - Export comparison results as markdown or JSON for external analysis.
   - Depends on the 0.3 model pool — multiple models must be resident simultaneously for this to be low-latency.

2. **Workspace export / import**
   - Export a workspace bundle: selected models list, endpoint profiles, personas, conversation history, settings.
   - Import a bundle to restore or migrate to another machine.
   - Credentials (auth tokens) excluded from export bundles; user must re-enter on import.

3. **Enterprise controls and policy engine**
   - Network configuration: choose bind address, port, and allowed CIDR ranges for the local service.
   - Access policies: per-model or per-endpoint allow/deny rules; optional API key requirement for the local service.
   - Audit log export: structured JSON/CSV export of the access log (from 0.3 monitoring) with retention settings.
   - Policy file: machine-level JSON config that can be pre-deployed by IT to enforce defaults before user launch.

### Deferred from 0.4 to later

- Azure AI Foundry cloud connections.
- Multi-user or shared-server deployment mode.
- Persistent token trend graphs and memory history across sessions.

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
