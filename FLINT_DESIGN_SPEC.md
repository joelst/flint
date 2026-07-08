# FLInt – Foundry Local Interface Design Spec

**Project Name:** FLInt  
**Full Name:** Foundry Local Interface (FLInt)  
**Backronym / Tagline:** Foundry Local INTerface  
**Spec revision:** 0.5 (docs consolidation; architecture baseline)  
**Repository / Folder:** flint  
**License:** MIT (most permissive)  
**Date:** June 2026 (revised July 2026)

> **Versioned product plans and release status** live in [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md). This file is the architectural and product-principles baseline — not a sprint tracker.

## 1. Executive Summary

**FLInt** (Foundry Local Interface) is a lightweight, privacy-first desktop GUI for Microsoft Foundry Local. It provides an intuitive interface for model management, core inference (chat, audio transcription, and vision where supported), diagnostics/monitoring, integrations, and education about Foundry Local (and Azure AI Foundry as a future cloud path).

The app is designed to:

- Leverage the official **Foundry Local JavaScript SDK** (`foundry-local-sdk` / platform-specific variants) as the primary integration path for catalog, downloads, loading, and inference
- Fall back to / supplement with the `foundry` CLI only where the SDK is insufficient
- Stay easy to develop and understand (primarily JavaScript/TypeScript)
- Prioritize security and privacy (local-first by default)
- Support Azure AI Foundry cloud connections as a high-priority future feature
- Use MIT licensing to encourage adoption and contribution

## 2. Goals & Non-Goals

### Goals

- Make Foundry Local accessible without deep CLI knowledge
- Deliver clear visual model management and core inference experiences
- Help users discover and understand Foundry Local + Azure AI Foundry
- Maintain a strong security and privacy posture
- Be easy to build and maintain
- Support Windows and macOS with a native feel
- Use the official Foundry Local SDK for reliable, first-class integration

### Non-Goals (early product)

- Built-in model training or fine-tuning
- Heavy autonomous agent loops inside Flint (prefer external tools on the local endpoint)
- Replacing purpose-built agent clients (OpenClaw, etc.)

## 3. Tech Stack

**Tauri 2 + TypeScript + Svelte 5 (Vite)**

**Why:**

- Mostly JS/TS with the official `foundry-local-sdk`
- System WebView → native feel, smaller footprint than Electron
- Strong security model (capabilities / CSP)
- Svelte keeps UI code small and readable
- Incremental Rust later when needed
- Windows + macOS support via Tauri

**Platform note:** On Windows prefer `foundry-local-sdk-winml` for optimal acceleration (NPU/GPU). macOS uses the standard `foundry-local-sdk`.

**Runtime integration:** Production model/service work goes through a **Node stdio sidecar** (`sidecar/foundry-sidecar.js`) rather than importing the SDK into the web bundle. See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## 4. Core Feature Areas

### Model & service management

- Browse, search, and filter the model catalog
- Download with progress; load / unload; multi-model **pool** when hardware allows
- Cache management; service start/stop for the OpenAI-compatible endpoint
- Hardware-aware variant selection via the SDK/runtime

### Inference

- **Chat** — streaming, personas, system prompts, conversation history, vision image attach when supported
- **Audio** — microphone + file transcription (STT models)
- **Compare** — side-by-side model responses (bake-off)

### Operations & education

- **Diagnostics** — service status, endpoint, execution providers
- **Monitor** — pool, resources, access/audit logs
- **Integrations** — copy-paste snippets for external tools
- **Learn** — Foundry Local education + tool-calling boundary
- Persistent local-first privacy messaging

## 5. Logging Strategy

**Foundry Local already provides** service logs (typically under `~/.foundry/logs`) and CLI diagnostics.

**GUI approach:**

- Separate Foundry service logs from Flint app / access logs
- Diagnostics + Monitor surfaces for status, access ring buffer, and audit events
- Flint access logs (metadata-oriented) under `~/.flint/logs/` with rotation
- Easy export and clearing where implemented

## 6. Multi-provider direction

**Azure AI Foundry (cloud)** connections should come **before** general Ollama / third-party local backends.

**Planned order**

1. Azure AI Foundry / Azure OpenAI connections  
2. Other remote providers  
3. Additional local backends  
4. Smart routing and fallback between providers  

Versioned timing is in [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) (Azure targeted for 0.4+).

## 7. Security & Privacy

- Inference local by default
- Clear indicators when any remote provider is used
- Localhost-only bind by default; non-loopback bind requires explicit user choice and warning
- Minimal OS permissions
- Export/clear paths for logs, cache, and settings
- Sidecar command validation and least-privilege Tauri capabilities (hardened across 0.2+)
- Tool execution is **not** performed by Flint’s chat UI (see Key Decisions)

## 8. Development Approach

**Phase 1 – JS/TS first (current)**

- UI and orchestration in TypeScript/Svelte
- Foundry Local via SDK inside the **sidecar** (catalog, download, load, chat, audio, service)
- CLI only for gaps (if any remain)
- OpenAI-compatible endpoint surfaced for external tools

**Phase 2 – Incremental Rust + polish**

- Move selected hot paths or packaging concerns to Rust when reliability/footprint benefits are clear
- Self-contained sidecar would remove the end-user Node-on-PATH requirement
- Azure connections and advanced enterprise controls per roadmap

## 9. Prerequisites & first-run

**Product packaging (current intent):**

- Foundry Local **runtime is bundled** with Flint builds for a seamless first run (see in-app Learn copy).
- The **JS sidecar still requires Node.js on PATH** for end-user installers until a self-contained sidecar ships. Document this honestly in user-facing docs.
- SDK package selection (winml vs standard) is handled at build/install time.
- First-run: accelerator detection + starter model recommendations when no persisted state exists.

## 10. Key Decisions

- **SDK first, CLI second** — progress, variants, and client APIs without fragile CLI parsing.
- **Svelte 5** — small bundles and simple reactivity.
- **Azure before other providers** — matches Foundry Local’s local ↔ cloud story.
- **Local endpoint exposure** — first-class Integrations + Diagnostics copy for ecosystem tools.
- **In-process vs server** — prefer in-process SDK clients for Flint UI; start web service when users want external tools.
- **Tool-calling boundary:**
  - **Foundry Local:** runtime + OpenAI-compatible endpoint; may emit `tool_calls` in responses.
  - **Flint:** load models, run service, surface endpoint/snippets, audit metadata. Chat UI does **not** parse or execute tool calls.
  - **Future:** any Flint-side execution requires explicit opt-in, confirmation, and audit trail (see roadmap).
  - **UI:** Learn tab documents this split.
- **Vision** — supported when catalog + chat client accept image content; multi-image attach shipped in 0.3.

## 11. Security & Privacy (expanded)

- Local inference default (in-process or localhost server).
- “Running locally” style messaging; clear cloud indicators when remote endpoints exist.
- No telemetry by default.
- Minimal permissions (mic only when user starts audio; filesystem limited to needed paths).
- Settings, conversations, logs exportable/deletable where implemented.
- Tauri CSP and capability model restrict webview powers.

## Summary

FLInt is a focused, privacy-first GUI that makes Foundry Local approachable while staying local-first. It prioritizes an understandable JS/TS codebase, an official SDK path, and a clear split between model runtime and tool execution.

**Living release plans:** [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md)  
**Contributor how-to:** [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)

---

**End of Spec**
