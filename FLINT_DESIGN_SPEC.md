# FLInt – Foundry Local Interface Design Spec

**Project Name:** FLInt
**Full Name:** Foundry Local Interface (FLInt)
**Backronym / Tagline:** Foundry Local INTerface
**Version:** 0.4
**Repository / Folder:** flint
**License:** MIT (most permissive)
**Date:** June 2026

## 1. Executive Summary

**FLInt** (Foundry Local Interface) is a lightweight, privacy-first desktop GUI for Microsoft Foundry Local. It provides an intuitive interface for model management, core inference (chat, audio transcription, and vision where supported), diagnostics, and education about both Foundry Local and Azure AI Foundry.

The app is designed to:
- Leverage the official **Foundry Local JavaScript SDK** (`foundry-local-sdk` / platform-specific variants) as the primary integration path for model catalog, downloads, loading, and inference (chat + audio clients)
- Fall back to / supplement with the `foundry` CLI for service management, diagnostics, and power-user flows
- Be easy to develop and understand (start primarily with JavaScript/TypeScript)
- Prioritize security and privacy (local-first by default)
- Support Azure AI Foundry cloud connections as a high-priority future feature
- Use the most permissive license (MIT) to encourage adoption and contribution

## 2. Goals & Non-Goals

### Goals
- Make Foundry Local accessible without deep CLI knowledge
- Deliver clear visual model management and core inference experiences
- Help users discover and understand Foundry Local + Azure AI Foundry
- Maintain a strong security and privacy posture
- Be easy to build and maintain for developers with JS, C#, Python, and scripting experience
- Support Windows and macOS with a native feel
- Use the official Foundry Local SDK for reliable, first-class integration (progress, hardware-aware model selection, in-process clients)

### Non-Goals (MVP)
- Built-in model training or fine-tuning
- Heavy agentic workflows or RAG (keep focused)

## 3. Recommended Tech Stack

**Tauri 2 + TypeScript + Svelte 5 (Vite)**

**Primary recommendation:** Svelte 5 (compiled, lightweight reactivity) + Vite + Tauri 2.

**Why this stack:**
- Start almost entirely in JavaScript/TypeScript (leverages existing skills and the official `foundry-local-sdk`)
- Uses system WebView → native feel and smaller footprint than Electron
- Strong security model
- Svelte is simpler and produces smaller bundles than React; excellent for desktop tools
- Supports incremental addition of Rust later when needed (Tauri commands)
- Excellent cross-platform support for Windows and macOS (official Tauri templates available)
- React is an acceptable alternative if the developer team strongly prefers its ecosystem

**Platform note:** On Windows prefer `foundry-local-sdk-winml` for optimal hardware acceleration (NPU/GPU). macOS uses the standard `foundry-local-sdk`.

## 4. Core Features (MVP)

### Model & Service Management
- Browse, search, and filter the model catalog (via SDK)
- View detailed model information (hardware-optimized variants, size, capabilities)
- Download models with live progress indication (SDK progress callback)
- Load / Unload models (SDK)
- Quick “Run” / Test chat for a model (one-click load + open chat)
- Cache management (list, remove) via SDK + CLI where helpful; note on changing cache location
- Service controls (start/stop the optional server for OpenAI endpoint exposure, status, list of loaded models)
- Automatic best-variant selection handled by the SDK / runtime for user's hardware (CPU/NPU/GPU)

### Inference Interfaces
- **Chat** — Streaming completions via SDK `createChatClient()`, model selector, system prompts, conversation history, image input for multimodal models (when available in catalog)
- **Audio Transcription** — Microphone recording + file upload using Whisper models via SDK `createAudioClient()`
- **Vision / Multimodal** — Image upload/drag-and-drop with analysis (supported if a multimodal model is loaded and the SDK/chat client accepts image content). Treat as stretch for initial MVP if no vision-optimized models are stable in the Local catalog yet.

### Discovery & Education
- Dedicated “Learn” section explaining Foundry Local vs Azure AI Foundry
- Clear, persistent privacy messaging (“Everything runs locally on your device”)

### Lightweight Integrations
- Prominent display of the current local OpenAI-compatible endpoint
- One-click copy buttons + example configuration snippets for OpenClaw, Cline, Continue.dev, GitHub Copilot custom providers, etc.

## 5. Logging Strategy

**What Foundry Local Already Provides**
- Service logs written to disk (typically `~/.foundry/logs`)
- `foundry service diag` (and `--logs`) to view or export diagnostic information
- Configurable `log_level` via the SDKs

**GUI Approach**
- Separate Foundry service logs from GUI application logs for clarity
- Dedicated **Diagnostics** section that can display service logs and allow exporting diagnostic bundles
- Clear labeling in the UI (“Foundry Service Logs” vs “App Logs”)
- Easy log clearing and export functionality

## 6. Future Feature: Multi-LLM / Provider Support (Prioritized)

**High-Priority Future Feature: Azure AI Foundry Connections**

Support for connecting to **Azure AI Foundry** (cloud) models via the OpenAI-compatible interface should come **before** general support for Ollama or other third-party local backends.

**Rationale**
- Aligns with Foundry Local’s core strength (seamless local ↔ Azure path)
- Many users will want to use both local models (privacy/speed) and Azure models in the same interface

**Planned Order**
1. Azure AI Foundry / Azure OpenAI connections (highest priority)
2. Other remote providers
3. Additional local backends (Ollama support comes later)
4. Smart routing and fallback between providers

This would allow Flint to act as a unified hub for both local and cloud models while keeping local privacy as the default.

## 7. Security & Privacy

- All inference runs locally by default
- Clear, persistent indicators when any remote provider is configured or used
- Localhost-only endpoint binding by default
- Minimal OS permissions
- Easy export and clearing of logs, cache, and settings
- Transparent data flow explanations throughout the UI

## 8. Development Approach

**Phase 1 – JS/TS First (Recommended)**
- Build the majority of the UI and logic in TypeScript
- Use the official **Foundry Local JavaScript SDK** (`foundry-local-sdk` / `-winml`) directly from the Tauri web frontend (or a thin Tauri command bridge if isolation is preferred) for:
  - Catalog discovery (`manager.catalog.getModels()` / `getModel(alias)`)
  - Download with progress callbacks
  - Load / unload
  - Chat via `model.createChatClient()`
  - Audio via `model.createAudioClient()`
- Use CLI (`foundry service ...`, `foundry model ...`) only for:
  - Service lifecycle not covered by SDK (start server mode for external OpenAI compat endpoint)
  - Diagnostics export (`foundry service diag`)
  - Initial installation detection / user guidance
- Expose the local OpenAI-compatible endpoint prominently (obtained via SDK or `foundry service status`) for use by Continue.dev, Cline, GitHub Copilot, etc.
- Implement model management, chat, audio, vision/multimodal (if supported), diagnostics, and Learn sections

**Phase 2 – Incremental Rust + Polish**
- Move selected CLI interactions or heavy parsing to Rust Tauri commands when reliability or performance benefits are clear
- Add direct use of the Foundry Rust SDK where beneficial
- Implement Azure AI Foundry (cloud) connection support
- Add advanced conversation features, export, theming, etc.

This approach allows fast initial progress while keeping the codebase understandable and aligned with official Microsoft integration paths.

## 9. High-Level Roadmap

> Current release readiness decision and versioned limitations/plans are tracked in
> [`RELEASE_ROADMAP.md`](./RELEASE_ROADMAP.md). This spec remains the architectural baseline.

**MVP (v0.1)**
- Model catalog browsing + search/filter (via SDK)
- Download / load / unload with progress
- Basic service status + start server for endpoint exposure
- Chat interface (streaming) with model switcher and history (in-memory or persisted)
- Audio transcription (mic + file)
- Vision/multimodal if catalog + SDK supports in initial models
- Diagnostics view (logs + export bundle)
- "Learn" / education panel + prominent "Local endpoint" copy + snippets for popular tools
- First-run experience: detect Foundry Local install, guide install if missing, SDK smoke test

**Next Priorities (v0.2)**
- Azure AI Foundry cloud connections (highest-priority future feature)
- Conversation persistence, rename, export (markdown/json)
- Better model metadata display, hardware info, cache size management
- Improved error handling, retry, offline awareness

**Later / Backlog**
- Additional remote providers
- Ollama and other local backend support (after Azure integration)
- Deeper tool calling / agent light features (non-goal for early MVP)
- Training / fine-tuning interfaces (separate major feature, out of scope)

## 10. Prerequisites & First-Run Experience (New)

- **Hard dependency**: Foundry Local runtime installed on the host.
  - Provide clear detection (try SDK init or `foundry --version`).
  - In-app guidance + links:
    - Windows: `winget install Microsoft.FoundryLocal` or MSIX from GitHub releases
    - macOS: `brew install microsoft/foundrylocal/foundrylocal`
  - Optional: one-click launch of installer where feasible.
- App gracefully degrades / shows friendly "Install Foundry Local" screen until ready.
- SDK package selection handled at build/install time (winml vs standard).

## 11. Key Decisions

- **SDK first, CLI second**: Using the official JS SDK gives progress reporting, hardware-aware model variants, and clean client APIs (`createChatClient`, `createAudioClient`). CLI shelling is minimized to avoid parsing fragility.
- **Frontend framework**: Svelte 5 chosen for bundle size and simplicity. React ok as alternative.
- **Azure before other providers**: Matches Foundry Local's value prop (local ↔ cloud seamless) and user demand.
- **Local endpoint exposure**: Critical for ecosystem (tools expect OpenAI compat). The GUI must surface the URL + ready-to-paste config snippets.
- **In-process vs server**: Prefer SDK in-process clients inside Flint for chat/audio. Start optional server only when user wants to share the endpoint with external tools.
- **Vision scope**: Included in spec but contingent on catalog support and SDK image input in chat clients. If no strong vision models in early catalog, defer polished vision UI.

## 12. Security & Privacy (expanded)

- All inference runs locally by default (SDK in-process or localhost server).
- Clear, persistent "Running locally" banner + indicators when cloud provider is active.
- No telemetry by default; optional opt-in diagnostics export.
- Minimal permissions (microphone for audio only when user initiates; file system limited to user-selected cache + exports).
- All settings, conversations, logs exportable and deletable.
- Tauri CSP and capability model used to restrict webview powers.

## PR Plan

Detailed phased implementation plan is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

High level PR grouping (summary):

**PR 1: Project bootstrap**
- Init Tauri 2 + Svelte + TS project
- Add foundry-local-sdk dependency (with platform notes)
- Basic window, routing (home, models, chat, audio, diagnostics, learn)
- Hello world SDK integration (list catalog or show not-installed state)

**PR 2: Model Catalog & Management**
- List / search / filter models from SDK
- Model detail pane (size, capabilities, variants)
- Download with progress (SDK callback + UI)
- Load / unload buttons + status
- Cache list/remove

**PR 3: Chat MVP**
- Model selector (global or per-chat)
- Streaming chat using SDK createChatClient
- System prompt, basic history (multiple convos later)
- Copy / clear

**PR 4: Audio Transcription**
- Record from mic (Web Audio + MediaRecorder or Tauri)
- File drop / select
- Use SDK audio client + transcription
- Result display + copy

**PR 5: Diagnostics + Logging + Endpoint**
- Show service status
- View / export logs (service + app)
- Prominently display current endpoint + copy + "How to use with X" snippets

**PR 6: Learn / Education + Polish**
- Static + dynamic content explaining Foundry Local vs Azure
- Privacy messaging
- First-run wizard / install detector polish
- Theming, accessibility, basic settings

**PR 7: Packaging & Release prep**
- Tauri bundle config for Windows (msi/exe) + macOS (dmg)
- Code signing notes
- Update / auto-update strategy (optional for v1)
- README, contributing, screenshots

**Post-MVP PRs**
- Azure provider integration
- Conversation persistence
- Vision/multimodal UI enhancements
- etc.

## Summary

FLInt is a focused, privacy-first GUI that makes Foundry Local much more approachable while staying true to its local-first roots. It starts easy to develop (JS/TS heavy, SDK-first), supports Azure Foundry connections as a key future capability, and uses the most permissive license possible.

---

**End of Spec**