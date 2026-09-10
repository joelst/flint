# Flint Release Roadmap

**Scope:** Living release status — shipped versions, the current probe-backed
plan through 1.0, and the 1.0 release bar. Day-to-day implementation
sequencing and acceptance gates live in [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md).
Open follow-up items live in [docs/BACKLOG.md](./docs/BACKLOG.md). Full
per-release detail lives in [CHANGELOG.md](./CHANGELOG.md) and
[GitHub Releases](https://github.com/joelst/flint/releases).

---

## Released versions

| Version | Highlights |
|---|---|
| 0.1.0 | MVP baseline: model catalog, streaming chat, audio transcription, diagnostics |
| 0.2.0 | Security hardening (sidecar schema/allowlist, least-privilege shell capability), chat/audio lane routing, realtime voice dictation |
| 0.3.x | Model pool, Monitor view (resources, access log, audit trail), network bind config, keyboard shortcuts, autostart, vision multi-image, Model Arena, Integrations tab, Purview governance memo |
| 0.4.x | Bundled Node 22 runtime for the sidecar, Help/first-run coach, signed Windows releases via Azure Trusted Signing, macOS build/notarization fixes, working auto-updater endpoint |
| 0.5.0 | BYOM import + linked model folders, gateway auto-load-on-demand (closes the "model not loaded" agent-compat gap), memory watchdog + pool eviction, keep-service-running-in-tray, WSL mirrored networking, Compare renamed to Model Arena |
| 0.6.0 *(in progress)* | Durable versioned conversation storage (Phase 1A) and runtime lifecycle correctness (Phase 1B) — see [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md) |

---

## Plan: 0.5 → 1.0

Measured 2026-08-30 against SDK 1.2.4, Foundry CLI 0.10.3, and the live HTTP service.
Numbers below are probe results, not estimates.

### Positioning

**The friendly and full-featured control plane for Foundry Local**: hardware-aware model management, an
observable OpenAI endpoint, and reliable integration with local AI clients.

Flint does not compete with Ollama on model-library breadth, and says so. Foundry Local
is ONNX-only; Ollama's ecosystem is GGUF. That trade is conceded openly — conceding it
is what makes the rest of the pitch credible.

Reasons to choose Flint over Ollama's desktop app, all already shipped: NPU/GPU/CPU
variant selection, multi-model pool co-residency, the side-by-side Model Arena, speech-to-text,
audit logging, bind-address/network control.

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
| Model not pre-loaded | **400 `Model is not loaded`** — closed in 0.5 by Flint's gateway. |
| `/v1/models` contents | **Cached models only** (35 of 128), and no loaded/unloaded state. |

**The single real agent-compat gap — now closed.** A client read `/v1/models`, picked an ID,
POSTed, and got `400 Model is not loaded`; nothing in the OpenAI protocol lets a client load
a model, and Foundry exposes no HTTP load route. Flint owns the model pool, so it now owns
the port: the gateway forwards to the native service and, on that exact rejection, loads and
replays once. Measured end to end: cold request 200 in 15 s, warm 707 ms with no reload,
unknown model a clean 400 with no download.

### 0.5 — Own the model, prove it loads

1. **BYOM import (local folder).** Verified working today: a directory with
   `genai_config.json` + `inference_model.json` and no `download.tmp` is discovered by
   `getCachedModels()` as `providerType: "Local"`, `uri: local://<name>`, resolvable by
   alias. Pure filesystem; no SDK upgrade. Flint synthesises `inference_model.json` and
   the prompt template.
   Import must be **staged, validated, atomically activated, and load-smoke-tested**,
   with rollback and clear ownership metadata so Flint knows which files it may delete.
2. **Additional model folders via junctions.** Verified: a directory junction inside the
   cache root is traversed by the native scanner, surfacing a model stored elsewhere with
   its real alias, provider, and version intact — no copying, no writes to the foreign
   directory. This replaces the unsafe "shared cache" idea: Flint keeps `~/.flint` as its
   only writable root and links foreign models in. Deletion must remove the *link*, never
   the target.
3. **Cache inventory, read-only** — **open** (see [BACKLOG.md](./docs/BACKLOG.md)). Report
   foreign models, duplicates, partial downloads, and reclaimable bytes. Recommend; never
   delete across roots. Measured on the maintainer's machine: `~/.flint` 107 GB / 35 models
   vs `~/.foundry` 31.4 GB / 7 models, **15.3 GB duplicated**.
4. **Auto-load on demand at the endpoint** — **done.** Flint's reverse proxy
   (`sidecar/gateway.js`) owns the configured port and forwards to the native service,
   which is only reachable once it reports its own port back: the native core initializes
   once per process, so the manager cannot be re-created to choose one. On the exact
   `400 ... is not loaded` the model is loaded and the request replayed once. This also
   fixed service start, which had always failed with `Core is already initialized`.
5. **Throughput instrumentation** — **open** (see [BACKLOG.md](./docs/BACKLOG.md)), with
   explicit definitions: model load time, TTFT, prompt tokens/sec, decode tokens/sec,
   end-to-end duration, warm/cold, resolved variant and execution provider. Never a single
   ambiguous "tokens/sec".
6. **Memory watchdog and pool eviction** — **done.** Nothing previously bounded pool
   residency, so an autoloading endpoint could fill memory unattended. A watchdog samples
   RAM and per-GPU VRAM on its own cadence regardless of the active tab and raises an
   in-app banner plus a native OS notification; because the telemetry is system-wide it
   only alerts while Flint holds resident models and never attributes the usage to Flint.
   Eviction is opt-in — idle-unload and a max-resident LRU cap — with `pinned` models
   never unloaded and in-flight requests, including proxied gateway traffic, protected via
   the gateway's `onActivity` hook. Hardware-aware admission (item 1 of the 0.3 pool work)
   remains open: Flint still reacts to memory pressure rather than predicting it.

### 0.6 — Compatibility gateway

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

### 0.7 — Curated model acquisition

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

### Post-1.0 / non-goals

- **Tokenomics deferred.** "Tokens × cloud list price" is not a defensible savings figure:
  models are not quality-equivalent, tokenizers differ, and cloud pricing splits
  input/cached/output/batch. If ever built, ship it as a **cost comparator** with visible
  assumptions — never "savings". Tokens-per-watt needs idle-power baselining and
  synchronised sampling; omit unless measurable as joules per output token.
- **No Flint-native tool executor before 1.0.** Receiving a call, gating it, executing it,
  and returning the result to the model *is* a manually gated agent loop — it inherits the
  security surface while delivering a worse version of what Cline and OpenClaw already do.
  The heuristic prompt-injection guard is not a real boundary and would create false
  confidence. Flint displays and exports tool-call JSON for debugging; clients execute.
- **Agent loops stay delegated**, and OpenClaw is treated as one integration, not a
  strategic dependency. Flint should work with any conforming OpenAI client.
- **Olive conversion (safetensors → ONNX)** stays a documented external recipe. Bundling
  Python plus conversion, quantisation, and hardware targeting would overwhelm the app.
- **No GGUF**, no `flint` CLI shadowing `foundry`, no model registry or push.

### Upstream-churn risk

Foundry Local's REST API is preview and explicitly subject to breaking change, and Flint
is deliberately pinned to SDK 1.2.4 (2.0.0 drops `responsesClient.d.ts` and refactors
AudioSession for no BYOM benefit). A CLI or core update can break cache, gateway, or BYOM
assumptions with no Flint change. Add a startup SDK/core/CLI version check that warns
visibly on untested combinations rather than failing obscurely.

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

If 0.1 is "usable MVP" and 0.2 is "hardened + scalable architecture", then **1.0 is "operationally trustworthy."**

---
