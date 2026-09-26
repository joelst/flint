# Flint Release Roadmap

**Scope:** The current probe-backed plan through 1.0, and the 1.0 release bar.
Day-to-day implementation sequencing and acceptance gates live in
[docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md). Deferred and post-1.0 items live in
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

### Remaining gateway work for 1.0

Gateway work only. The tool-execution layer does **not** share this milestone.
Chat JSON/SSE normalisation (Foundry extras stripped, one OpenAI-shaped choice,
`[DONE]`) and autoload-on-demand are already in the tree; sequencing lives in
[docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md).

- User-facing conformance self-test that checks *behavior*, not route existence:
  `/v1/models` OpenAI envelope; a returned ID round-trips into chat; streaming
  delivers a first token and `[DONE]`; disconnect cancels upstream; `usage` is
  present when the model emits it; a tool-capable model either emits valid
  `tool_calls` or is labelled not-verified.
- Surface `supportsToolCalling` and `contextLength`, labelled **catalog-declared**
  vs **Flint-verified**. A catalog flag is not a guarantee. Catalog fields already
  appear in the model-details modal; the verified label is what remains.
- Verified integration recipes for OpenClaw, Cline, and Continue, pinned to tested
  client versions. 1.0 recipes are **chat completions** against the local gateway.
  OpenClaw accepts any non-empty placeholder API key on loopback and health-checks
  `GET /v1/models`.

### 0.9.0 — first stable (upgrade test)

Skip 0.8.0. Publish **0.9.0** as `channel=stable` (not a prerelease) so
`releases/latest` resolves. That is the in-app updater test from 0.7.0
evaluation. Waves 1–9 land in this release, including the embeddings path
(gateway autoload, BYOM without a chat template, sidecar `embedTexts`).
Full RAG (index + retrieve + show sources) stays after 1.0.

**1.0.0** is the next stable, after that upgrade is proven and 0.9.0
bugfixes land. Do not cut 1.0.0 as the first `releases/latest` pointer.

### After 1.0
- **Curated model acquisition** — a Flint-validated ONNX catalog (pinned repo and
  revision, tested execution provider, required files, disk/memory footprint,
  chat-template source, tool-calling status, last-tested core version), not a
  generic HuggingFace browser. Arbitrary repo import stays behind an "unverified"
  advanced option. Survey data (HF API, top 1000 onnx + text-generation by
  downloads): **166 ship `genai_config.json`**; only **29 exceed 100
  downloads/month** and **2 exceed 1000**; only **2 of 301 ship
  `inference_model.json`**, so Flint must synthesise it for essentially every
  import. A curated 20 that reliably work beats a browser exposing 300 that
  mostly do not.
- **Multi-endpoint scheduler**, Azure connections, and related routing — unscheduled
  in [docs/BACKLOG.md](./docs/BACKLOG.md). Not part of the 1.0 bar.

---

## What release 1.0 should look like

Release 1.0 is **production-grade local AI operations** on one Foundry endpoint,
not a multi-provider control plane and not "every backlog item closed."

**1.0 production is Windows.** macOS Apple Silicon remains evaluation-only
(unsigned builds; `scripts/install-macos.sh` or `xattr -cr`). Linux is deferred.
Do not date 1.0 until **0.9.0** is published stable and the upgrade from 0.7.0
evaluation is proven. Sequenced work lives in
[docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md).

### 1.0 release criteria

1. **Security**
   - Audited Tauri capability model: each survivor in
     `src-tauri/capabilities/default.json` is named and justified.
   - Dedicated renderer/sidecar boundary suite covering command allowlisting,
     unknown commands, IPC schema drift, and BYOM path containment.
2. **Reliability**
   - One local endpoint with recovery and health checks.
   - Deterministic cancellation and timeout *certainty* across chat, streaming,
     gateway, audio, and compare: Stop acknowledgement is not proof inference
     stopped; caller completion is separate from native completion; resource
     protection holds until native completion or the child is gone.
   - Native tray Open/Quit (renderer-independent), quit→frontend-flush handshake,
     and stream updates routed by originating conversation id.
3. **Testing**
   - Unit + contract + sidecar/native E2E + one packaged Windows smoke
     (launch → sidecar ready → quit in CI; load/chat/stop on a recorded
     clean-machine dogfood).
   - CI coverage gate over the existing allowlist; add files only when they
     have tests. Component tests of `src/routes/+page.svelte` are not the bar.
4. **Observability**
   - Diagnostics export includes a bounded endpoint health ring plus IPC and
     gateway inference metrics (load time, TTFT, prompt tok/s, decode tok/s,
     variant + execution provider). No single ambiguous "tokens/sec".
5. **UX maturity**
   - Qualify the surfaces that already exist: first-run coach, Settings →
     Network (bind/port/WSL), Monitor memory/capacity. Fix holes. Not a new
     routing UI and not cloud endpoint profiles.
6. **Integrations**
   - In-app behavioral self-test of the local OpenAI-compatible gateway.
   - Continue, Cline, and OpenClaw recipes pinned to tested versions with
     honest status badges. Chat completions only.
7. **Documentation**
   - Operator runbook (log locations, service lifecycle, bind vs client URL,
     offline/uninstall, updater stable-vs-prerelease) plus versioned release
     notes in [CHANGELOG.md](./CHANGELOG.md). The user-facing table in
     [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) is not that runbook.

### 1.0 ship gate (process)

- **0.9.0** published as the first stable GitHub release so
  `https://github.com/joelst/flint/releases/latest/download/latest.json`
  resolves, with a recorded 0.7.0-evaluation → 0.9.0 in-app updater install.
  Rollback note in [docs/RELEASE.md](./docs/RELEASE.md).
- Signed Windows MSI/NSIS on a clean machine (no PATH Node, Rust, or Foundry)
  downloads and loads a model.
- **1.0.0** is a later stable, after that upgrade is proven and 0.9.0 bugfixes
  land.
- macOS: one recorded `install-macos.sh` boot as evaluation evidence, not a
  production claim.

### 1.0 statement

**1.0 is "operationally trustworthy" for the local product that exists.** The
remaining bar is the seven criteria above holding under real-world Windows use,
not new features (multi-endpoint routing, RAG, Azure, Linux, a
Flint-native tool executor). The embeddings **path** ships in 0.9.0.

---
