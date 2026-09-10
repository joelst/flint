# Flint Release Roadmap

**Scope:** The current probe-backed plan through 1.0, and the 1.0 release bar.
Day-to-day implementation sequencing and acceptance gates live in
[docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md). Open follow-up items live in
[docs/BACKLOG.md](./docs/BACKLOG.md). Per-release detail lives in
[CHANGELOG.md](./CHANGELOG.md); project positioning and non-goals live in
[FLINT_DESIGN_SPEC.md](./FLINT_DESIGN_SPEC.md).

---

## Plan: current → 1.0

Measured 2026-08-30 against SDK 1.2.4, Foundry CLI 0.10.3, and the live HTTP service.
Numbers below are probe results, not estimates.

### What the endpoint actually does (probed, contradicts prior assumptions)

| Behavior | Result |
| --- | --- |
| `GET /v1/models` | **200, OpenAI-shaped** `{data:[…]}`. Not missing, as docs implied. |
| `GET /openai/models`, `/foundry/list` | **404** — documented routes are stale. |
| Model `id` in the list | Variant **without** version suffix (`qwen3-0.6b-generic-cpu`); `parent` carries the friendly alias. |
| Routing by friendly alias | **Works** (`qwen3-0.6b` → 200). The old pool-spike note requiring variant IDs is obsolete. |
| Streaming | **Works** — SSE, `[DONE]` terminator, and `usage` included in the stream. |
| `usage` on non-streamed calls | Present. |
| `POST /v1/embeddings` | Route **exists** (GET returns 405). |
| Model not pre-loaded | **400 `Model is not loaded`** — closed by Flint's gateway auto-load-on-demand. |
| `/v1/models` contents | **Cached models only** (35 of 128), and no loaded/unloaded state. |

**The single real agent-compat gap — now closed.** A client read `/v1/models`, picked an ID,
POSTed, and got `400 Model is not loaded`; nothing in the OpenAI protocol lets a client load
a model, and Foundry exposes no HTTP load route. Flint owns the model pool, so it now owns
the port: the gateway forwards to the native service and, on that exact rejection, loads and
replays once. Measured end to end: cold request 200 in 15 s, warm 707 ms with no reload,
unknown model a clean 400 with no download.

### Next: compatibility gateway

Gateway work only. The tool-execution layer does **not** share this milestone.

- Conformance self-test that checks *behavior*, not route existence: does `/v1/models`
  return the OpenAI envelope; can a returned ID be passed straight back to chat; does
  streaming deliver a first token and terminate; does disconnect cancel generation; does
  `usage` reconcile with output; does a tool-capable model emit valid `tool_calls`.
- Stable model IDs across restarts; surface both alias and resolved variant.
- Response-shape normalisation. The service returns non-standard extras (`IsDelta`,
  `Successful`, `HttpStatusCode`, and both `delta` and `message` in the same choice) that
  strict clients may reject.
- `/v1/embeddings` served end-to-end — requires a BYOM embedding model, because the
  Foundry catalog ships **zero** (97 chat, 21 vision, 10 ASR of 128). `createEmbeddingClient()`
  exists in 1.2.4; only the model is missing. This is what unlocks RAG and Continue's indexer.
- Verified integration recipes for OpenClaw, Cline, and Continue, pinned to tested client
  versions. OpenClaw accepts any non-empty placeholder API key on loopback and
  health-checks `GET /v1/models`.
- Surface `supportsToolCalling` (75 of 128) and `contextLength`, labelled
  **catalog-declared** vs **Flint-verified**. A catalog flag is not a guarantee.

### Then: curated model acquisition

A **Flint-validated ONNX catalog**, not a generic HuggingFace browser: pinned repo and
revision, tested execution provider, required files, disk/memory footprint, chat-template
source, tool-calling status, last-tested core version. Arbitrary repo import stays behind
an "unverified" advanced option.

Survey data (HF API, top 1000 onnx + text-generation by downloads): **166 ship
`genai_config.json`**; 81% modified within a year, so the ecosystem is active, not fallow.
But only **29 exceed 100 downloads/month** and **2 exceed 1000** — a live but thin niche
dominated by AMD Ryzen AI builds (193 of 301 in a recency-sorted sample), with
`onnx-community` and `microsoft` next. Critically, only **2 of 301 ship
`inference_model.json`**, so Flint must synthesise it for essentially every import.
A curated 20 that reliably work beats a browser exposing 300 that mostly do not.

---

## What release 1.0 should look like

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

**1.0 is "operationally trustworthy."** Early releases proved the app usable, then hardened
its architecture; the remaining bar for 1.0 is the seven criteria above holding under
real-world use, not new features.

---
