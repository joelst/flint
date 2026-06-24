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

## 3) MVP 0.2 Plan

## Theme A — Security hardening

1. **Shell capability reduction**
   - Replace broad `node + args:true` permission with narrowly scoped invocation.
   - Prefer a dedicated Rust command wrapper for sidecar lifecycle where feasible.

2. **Command boundary hardening**
   - Introduce strict sidecar command schema validation (input shape, types, limits).
   - Enforce explicit allowlist per command and reject unknown fields.

3. **Output safety**
   - Add security regression tests for markdown/html sanitization.
   - Verify CSP and WebView settings for script injection resistance.

4. **Operational safety**
   - Add structured audit events for model load/unload, service start/stop, and endpoint profile changes.

## Theme B — Testing expansion

1. **Component testing**
   - Stabilize Svelte component test harness and restore direct component interaction tests.

2. **Sidecar contract testing**
   - Expand protocol tests to include error-path, cancellation timing, malformed payload, and large-response behavior.

3. **E2E smoke tests**
   - Add a minimal Tauri smoke flow: launch -> initialize -> model list -> chat send -> audio transcribe happy path.

4. **Acceleration validation matrix**
   - Add repeatable tests for execution provider detection, accelerator install/update flow, and preference propagation behavior.
   - Validate expected behavior for CPU-only, GPU-ready, and NPU-ready environments.

5. **Quality gates**
   - Raise coverage thresholds in increments and widen include scope each milestone.

## Theme C — Multi-endpoint architecture

### Goal

Support multiple local/remote endpoints concurrently (local Foundry endpoint(s), Azure/OpenAI-compatible endpoints, and tool-specific endpoints such as OpenClaw integrations).

### Proposed model

1. **Endpoint Profiles**
   - Each profile stores: name, type, base URL, auth mode, active model policy, max concurrency, memory budget hint.
   - Examples:
     - `Local Chat (Foundry @5272)`
     - `Local Audio (Foundry @5273)`
     - `OpenClaw Tool Endpoint`
     - `Azure AI Foundry Endpoint`

2. **Endpoint Manager**
   - Central scheduler routes requests by task type (chat/audio/tooling) and endpoint health.
   - Supports sticky routing (conversation pinned to endpoint) and fallback routing.

3. **Model-to-endpoint strategy**
   - Option A: one model per endpoint (simpler, clearer memory accounting).
   - Option B: shared endpoint pool with dynamic model switching (higher churn risk).
   - 0.2 recommendation: start with **Option A**.

### User management impact

- Introduce **workspace profiles** (single-user desktop first) to isolate:
  - endpoint credentials
  - model defaults
  - conversation routing preferences
- Add role-like controls for shared environments (future):
  - admin (manage endpoints/secrets)
  - user (consume endpoints only)

### Memory requirements & management

1. **Per-endpoint memory budget**
   - Track configured and observed memory per endpoint.
2. **Admission control**
   - Refuse or queue model loads that exceed configured budget.
3. **LRU unload policy**
   - Auto-unload inactive models to free memory.
4. **Telemetry**
   - Report RSS/VRAM/NPU usage, load times, queue depth, and OOM events.
5. **UX**
   - Live "capacity meter" with warnings before model switch/load.

### Monitoring plan

- Endpoint dashboard with:
  - health status
  - latency percentiles
  - active sessions
  - memory trend
  - error rate
- Diagnostics export includes endpoint profile inventory + health snapshots.

### Why this helps OpenClaw and other tools

- Tooling endpoints can be isolated from chat/audio workloads.
- Enables stable integrations with dedicated credentials and throughput limits.
- Reduces model thrash by separating "interactive chat" and "tool-runner" lanes.

---

## 4) Additional Future Milestones (post-0.2 ideas)

1. **Plugin-style connector framework**
   - Add provider adapters (Azure/OpenAI-compatible, additional local runtimes) behind one interface.
2. **Conversation intelligence**
   - Per-conversation endpoint pinning, retry policy, and export/import.
3. **Enterprise ops pack**
   - Policy enforcement, signed diagnostics, audit retention settings.
4. **Performance toolkit**
   - Benchmark mode for model + endpoint comparisons (latency, throughput, memory).
5. **User onboarding**
   - Guided setup for endpoint profiles and tool integration recipes.
6. **Model catalog details v2 (backlog)**
   - Expand model details modal with full upstream metadata, benchmark notes, and platform-specific acceleration compatibility matrix (Windows/macOS/Linux).
   - Replace heuristic memory guidance with measured baseline telemetry per model/provider where available.
   - Add an inventory view that can list all models with per-model disk usage and supported acceleration providers.

7. **Deferred hardening items (queued)**
   - Add defensive environment guards for `DOMParser` / `NodeFilter` in message sanitization so utility calls remain safe if reused in non-browser execution contexts.
   - Improve sidecar audio input reliability by validating actual WAV bytes (or adding explicit transcoding) instead of relying on filename extension conventions.
   - Broaden coverage gating beyond the current narrow include list so new SDK/sidecar logic changes affect quality gates by default.

---

## 5) What Release 1.0 Should Look Like

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
