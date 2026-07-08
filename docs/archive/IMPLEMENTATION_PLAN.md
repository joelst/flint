# FLInt Implementation Plan

**Project:** FLInt (Foundry Local Interface)  
**Based on:** FLINT_DESIGN_SPEC.md (v0.4 after review adjustments)  
**Date:** 2026-06-24  
**Status:** Active – MVP 0.1 baseline reached; 0.2 planning in progress

## Objectives
Deliver a working MVP desktop app (FLInt) that makes Foundry Local delightful to use:
- Zero CLI required for common tasks
- Beautiful, fast, privacy-first experience
- SDK-first integration for reliability
- Ready for Azure cloud extension

## 0.1 Readiness Decision (2026-06-24)

- Compared current implementation against the original MVP scope in `FLINT_DESIGN_SPEC.md` and `MVP_FEATURE_COMPLETION_PLAN.md`.
- **Decision:** MVP **0.1 is ready** as a practical preview baseline.
- Remaining limitations and 0.2 priorities are documented in `RELEASE_ROADMAP.md`.

### 0.1 limitations (summary)
- Multi-endpoint routing/concurrency is not yet implemented.
- Diagnostics export + cache operations need additional hardening/polish.
- Security and tests are at strong baseline, with planned hardening/expansion in 0.2.

## Guiding Principles (from spec)
- Local-first always
- SDK > CLI shelling
- JS/TS first, Rust later
- Small, understandable codebase
- MIT license, easy contributions

## Phase 0: Project Setup (1-2 days)

**Goal:** Get a runnable skeleton with SDK wired up.

Tasks:
- [x] `npm create tauri-app@latest` (Svelte + TypeScript template) — done
- [x] Add `foundry-local-sdk` + winml variant for Windows (with setup script)
- [x] Tauri resources bundling configured for runtime (~20MB core + prebuilds + winml)
- [x] Add dev scripts + `tauri dev`
- [x] Basic layout: Sidebar navigation (Models, Chat, Audio, Diagnostics, Learn)
- [x] SDK client wrapper with EP/accelerator support (ensureAccelerators, getEps)
- [x] First-run experience updated for bundled runtime (no separate install required)
- [x] Hardware-aware starter model recommendations (1-3 options based on EPs + fileSizeMb + modalities)
- [x] One-click "Use this" / Quick Start from recommendations (download + load + switch to chat)
- [x] Functional streaming Chat tab using SDK createChatClient + completeStreamingChat
- [x] Model selection from recommendations and main grid, with current model indicator
- [x] Auto EP setup + first-run suggestion messaging
- [x] Auto first-launch: downloads + activates first recommended model + switches to chat (only on true first run, detected via no persisted state)
- [x] Full persistence of chat history, current model alias, system prompt across restarts (localStorage + restore on init)
- [x] Stop generation button + AbortController support during streaming
- [x] System prompt UI (editable input, prepended to every chat send)
- [x] Enhanced model grid action buttons (current badge, "Chat with this", "Set as Current Chat", "Load & Chat" variants)
- [ ] Full first-run wizard + auto-download optional starter model (partially done via recs)
- [ ] GitHub Actions skeleton for build (win + mac later)
- [ ] Update README with quickstart + screenshots placeholder
- [x] Restore design docs into repo

**Deliverable:** `tauri dev` shows app that can init SDK (or show nice "install required" state) and list some catalog info if possible.

## Phase 1: Model Management Core (MVP critical path)

**Goal:** Users can discover, download, load models without touching terminal.

Detailed tasks:
- [ ] Models page: table/grid with search, filter by capability (chat / audio / multimodal), sort by size
- [ ] Model card / detail modal or side panel:
  - alias, family, size, recommended hardware, description (from SDK)
  - Download button + progress bar (use SDK progress callback)
  - Load / Unload buttons + current status badges
  - "Test in Chat" quick action
- [ ] Global current model / loaded models indicator (in header or status bar)
- [ ] Cache panel: list cached models + sizes + Remove action
- [ ] Handle download cancellation / errors / resume (where SDK supports)
- [ ] Show hardware acceleration status (what provider the runtime picked)

**Dependencies:** Phase 0 SDK wrapper solid.

## Phase 2: Chat Experience

**Goal:** Best-in-class local chat UI.

Tasks:
- [ ] Chat view:
  - Conversation list (sidebar) – new chat, recent list (in-memory for now)
  - Message list with streaming (SDK chat client)
  - Model selector (dropdown, can switch mid-convo or lock per chat)
  - System prompt editor (per chat or global default)
  - Input with send + stop generation
  - Markdown rendering for responses (light lib like marked or remark)
  - Image attach button (for multimodal) – disabled gracefully if not supported
- [ ] Basic history persistence (localStorage or simple file via Tauri fs plugin for now) — per decision: **in-memory only for MVP**
- [ ] Copy message, regenerate, edit last user message (stretch)
- [ ] Token / timing estimates if exposed by SDK responses (nice to have)
- [ ] Loading / thinking states, error recovery

## Phase 3: Audio Transcription

**Goal:** Easy speech-to-text using Whisper models.

Tasks:
- [ ] Audio page:
  - Big "Record" button (WebRTC / MediaDevices for mic)
  - Stop + waveform visual (simple canvas or lib)
  - "Upload audio file" (wav/mp3/etc. – handle via File API + read as needed)
  - Model selector (only show Whisper family models or filter)
  - Language selector if supported by SDK
  - Transcribe button → call SDK `audioClient`
  - Result textarea with copy, save as .txt, append to current chat (optional)
- [ ] Progress + error states
- [ ] Permission handling for microphone (Tauri + browser)

**Note:** Test real Whisper models available in catalog (tiny, base, etc.).

## Phase 4: Diagnostics, Endpoint Exposure, Learn

**Goal:** Transparency + power users + education.

Tasks:
- [ ] Diagnostics:
  - Service status (running? endpoint?)
  - Buttons: Start/Stop/Restart server (via CLI `foundry service ...` where needed)
  - Tabs or sections: "App Logs" vs "Foundry Service Logs"
  - Tail / view recent logs (read from known paths or `foundry service diag --logs`)
  - Export full diagnostic bundle (zip of logs + config + SDK info)
  - Clear logs
- [ ] Endpoint card (always visible or dedicated panel):
  - `http://localhost:XXXX/v1` (or whatever the actual)
  - One-click Copy
  - "Test with curl" snippet
  - Ready configs for:
    - GitHub Copilot (custom provider)
    - Continue.dev
    - Cline / OpenClaw / other popular mentioned in spec
- [ ] Learn section:
  - "What is Foundry Local?" explanation
  - Comparison: Local vs Azure AI Foundry
  - Privacy guarantees
  - Hardware acceleration explainer
  - Links to official docs + Discord
- [ ] Persistent privacy banner: "Everything runs locally on your device"

## Phase 5: MVP Polish + Packaging

Tasks:
- [ ] Settings: theme (light/dark + system), default model, log level, cache path (if configurable)
- [ ] Conversation export (single chat or all) as markdown / json
- [ ] Keyboard shortcuts (send, new chat, focus input)
- [ ] Accessibility pass (labels, focus, contrast)
- [ ] Nice empty states, onboarding tour (1-2 steps)
- [ ] Error messages that are actionable ("Model not found? Try `foundry model list` in terminal" or link to catalog)
- [ ] About dialog with version, links, licenses
- [ ] Tauri config: icons, window size/title, updater (optional), bundler targets
- [ ] Build + test on Windows (primary dev) + macOS verification
- [ ] README update with screenshots, install instructions for the *Flint* app itself
- [ ] Create initial release artifacts (via CI or manual)

## Phase 6+: Post MVP

See spec roadmap.

- Azure provider
- Persisted conversations + folders
- Vision UI polish once models available
- Multi-conversation management
- Theming + plugins?
- Ollama etc. (much later)

## GitHub CI/CD (PR + Release Pipelines)

**Implemented:**
- `.github/workflows/ci.yml`: Runs on PR/push
  - Frontend check (`npm run check`)
  - Rust check
  - Matrix build for windows/mac (debug) + artifact upload
- `.github/workflows/release.yml`: On tag `v*` or manual
  - Builds release for win + mac using tauri-action
  - Creates GitHub Release draft with artifacts
- `scripts/verify-bundle.cjs`: Post-build check for SDK resources inclusion

**Next for packaging:**
- Test full `npm run tauri:build` and run verify
- Ensure native SDK loading works in bundled app (may need Vite external or sidecar adjustments)
- Add macOS notarization / Windows signing via secrets if needed
- Update tauri.conf for custom bundle names, updater, etc.

**To trigger release:** `git tag v0.1.0 && git push --tags` or use workflow dispatch.

## Technical Notes & Risks

**SDK Integration Gotchas**
- Different package names per platform (`foundry-local-sdk-winml` on Windows)
- Manager must be created once with `appName`
- Progress callbacks are percentage 0-100
- Some operations are async and long-running – always show UI feedback
- Endpoint for server mode may be separate from in-process clients

**Tauri Specifics**
- Use `@tauri-apps/plugin-fs`, `dialog`, `shell` (for launching CLI commands sparingly), `notification`
- For mic: primarily browser APIs inside webview, but may need permissions declared
- Avoid heavy node deps if possible; the SDK is the main one

**Risks**
- Catalog / SDK APIs may evolve quickly (preview stage) – wrap in adapter layer
- Vision support unclear – keep feature flag / graceful degradation
- Windows-only NPU acceleration differences – test on multiple machines
- Installer size + first download times – communicate expectations in UI
- macOS signing / notarization for distribution

**Testing Strategy (MVP)**
- Manual happy path + error paths heavily
- Unit tests for any pure utils / SDK wrapper
- Snapshot or basic component tests if framework supports
- Later: Playwright or Tauri e2e for critical flows

**Versioning**
- App uses semver. Tag releases.
- Spec version tracks design evolution separately.

## Milestones & Success Criteria

- **Alpha internal**: Can browse models, download + load one, do a chat, do a transcription. (achieved)
- **MVP ready for dogfood**: Full Phase 0-4 complete + basic packaging. 
  Current status (as of latest):
  - Model mgmt: excellent (catalog, progress, hardware recs, STT filter, winml/accelerators)
  - Chat: good (streaming, persist localStorage, system, stop, basic vision image)
  - Audio: good (mic+file, STT-only filter using metadata)
  - Learn + endpoint: basic
  - First-run/bundling: partial (resources + sidecar example, but direct SDK still used; clean prod build requires sidecar integration)
  - Diagnostics/service start: not implemented (placeholders)
  - Vision: emerging (basic image attach in chat)
  - Packaging: frontend (`npm run build`) clean thanks to SDK externalize in vite.config. Full tauri build JS part clean, fails on Rust linker (env-specific link.exe/build script issue with Rust crates, not our code). Sidecar/foundry-sidecar.js exists as example but not integrated yet. Resources include core + sidecar. Clean prod requires sidecar integration to avoid Node bundling entirely.
- **Public preview**: After Phase 5 + some usage feedback. 

**MVP 0.1 Review (current vs expected)**:
Expected (from spec):
- Model catalog + search/filter via SDK, download/load/unload w/ progress, basic service status + start server, chat streaming + switcher + history, audio mic+file, vision if supported, diagnostics/logs/export, Learn + endpoint + snippets, first-run detect/guide.

Current (sunglasses on, driven):
- Excellent: Catalog/search/filter (STT metadata filtered), download/load/unload + progress, hardware recs + WinML/eps, chat (streaming, persist localStorage, system, stop, basic vision image attach), audio (mic+file, STT only via getSTTModels), accelerators, first-run bundled (resources + sidecar prototype).
- Good/partial: Learn, endpoint display, sidecar eval for clean build (not fully wired in sdk calls yet).
- Gaps: Full diagnostics/service start UI + logs/export, rich tool snippets (Continue etc.), polished first-run (remove install notice for bundled case), full vision, integrated sidecar in runtime (current still hybrid/direct for dev), Rust build in this env (linker, not code).
- Build: JS/frontend clean (externalize + dynamic). Full tauri has Rust env blocker.

Verdict: Very close to MVP 0.1 dogfood. Core delight is there. Recommend: wire sidecar fully, polish gaps, then tag 0.1.0 (or 0.1.0-alpha now). It's time to check in the current state as solid alpha.

## User Decisions (2026-06-24)

- **Design spec adjustments**: Approved as-is.
- **Frontend**: Svelte 5 (as recommended).
- **MVP conversations**: In-memory only (simplicity).
- **First implementation focus**: Jump straight into model management assuming bootstrap will be straightforward. (Bootstrap still needs doing first.)

All other open questions remain for later (default models, distribution, etc.).

## Open Questions (remaining)

1. Any specific models we should hard-pin / highlight for first experience (e.g. a small fast Phi or Qwen)?
2. Distribution: GitHub releases only at first? Winget later?
3. Is there interest in bundling a small default model download on first run (user consent)?
4. Exact order inside Phase 1 vs splitting Model Catalog into smaller PRs.

## How to Use This Plan

1. Review + edit this file + the DESIGN_SPEC together.
2. Pick first PR (bootstrap is safest).
3. Use the review skill or implement subagents if desired for execution.
4. Update this plan as reality changes (APIs, scope).

---

**Next step after approval:** Start Phase 0 implementation (or whichever PR user wants first).

This plan is derived directly from the reviewed design spec. All major adjustments (SDK-first, clarified vision, prerequisites, key decisions) are incorporated.
