# Flint Changelog

## 0.10.0

### Minor Changes

- 288c4aa: Add a Benchmark Preview UI (opt-in, off by default) under Build, alongside Playground and Model Arena, for measured, repeatable multi-model benchmark runs with a hardened Stop/Resume lifecycle.

### Patch Changes

- 5bfdeb9: Extract Model Arena Quick Compare storage into a testable module; save/load failures now surface in the App Log instead of failing silently.
- 77833c5: Quick Compare streams live, Stop is real, and each result shows served variant, execution provider, and run status.
- b18e9da: Add a headless benchmark suite schema and IndexedDB-backed storage for the upcoming Model Arena benchmark runner.
- ff720fa: Add a headless sequential benchmark runner (write-ahead-intent-then-terminal-commit journal, Stop/Resume) for the upcoming Model Arena benchmark preview. No UI yet.
- d553bec: Add a repeatable screenshot-capture script (CDP-driven) and refresh README/docs screenshots for dark and light mode with the current sidebar layout and logo.
- 961a196: Allow the app's own local gateway to be reached at http://127.0.0.1 (not just http://localhost) so the endpoint self-test and other in-app fetches don't fail CSP. A ::1 bind is published as http://localhost so WebView2 CSP can allow it.
- 2ad3ef5: Fix chat completions silently ignoring requested temperature/maxTokens whenever the SDK transport is used (the common case) — they are now applied to the model's ChatClient settings, matching the audio path.
- b17a1fb: Fix thinking-toggle/reasoning state bleeding between messages when Chat or Model Arena reuses a rendering slot for a new message, and fix Arena reasoning detection to use full model info instead of alias only.
- b17a1fb: Fix chat reasoning ("thinking") not collapsing for models whose chat template opens `<think>` in the prompt prefix rather than the returned text, so only the closing tag ever appears in `content` (e.g. qwen3.5-9b). The full chain-of-thought was rendering as plain visible text; it now collapses into the "Thinking" toggle like other reasoning models.
- b17a1fb: Chat: avoid dumping raw reasoning text into the visible answer while a model streams, and fix the Playground chat pane not sizing to fit its container on load.
- c6b335a: Automate the complete native macOS screenshot suite in dark and light themes.
- 1976017: Theme native selects (including the Models catalog sort dropdown) in dark mode so closed boxes and open lists follow the app theme.
- 1585c4d: Group the sidebar nav into Build (Playground, Model Arena), Discover (Models), Operate (Monitor, Diagnostics, Integrations), and Manage (Settings, Help). Chat and Audio are merged into a single Playground entry with an internal Chat/Voice toggle.
- d553bec: Replace the app icon and favicon with the new Flint "F" logo across the Windows/macOS bundles and web static assets.
- 1793439: Show only integrations that can connect to Flint and keep the theme toggle visible in light mode.
- 288c4aa: Fix incorrect benchmark attempt estimates for out-of-range warmup/repeat counts, smooth out benchmark retry timing, and clear a leftover exclusive gateway lock left over from a reload.
- 288c4aa: Prevent a benchmark run from being permanently stuck when finishing it takes too long, and fix a case where cleanup could re-open external API access to a model pool mid-benchmark.
- 288c4aa: Fixed memory/eviction settings silently failing to apply after a reload, and surfaced a warning when a settings change is superseded instead of failing silently.
- 288c4aa: Fixed benchmark runs being able to overlap leftover inference from a previous run after a reload, which could corrupt benchmark timing results; fixed a benchmark export that could fail if the download hadn't started yet.
- 288c4aa: Benchmark exclusivity now also drains orphaned load/unload/delete operations left by a previous page instance. Same-page model downloads are now fenced against active benchmark runs (blocked from starting while one is active, and vice versa); this does not cover a download orphaned by a page reload.
- eb79399: Protect the runtime protocol from dependency/native stdout noise so operations do not fail with invalid JSON frames.
  Keep redirected sidecar diagnostics out of the error log, and show Starting… for every queued service start or restart.
- e05b1b8: Keep the header theme icon visible in light mode.
- 4795309: Stop the sidecar from also echoing its ready message to stderr, which showed up in the SDK log panel as a spurious "error" entry on every startup even though nothing failed.
- 37c0d5f: Drain an in-flight `startService` restart before a benchmark takes exclusive admission, so an orphaned pool clear/repopulate from a previous page instance can no longer race a new benchmark run.

## 0.9.0

First **stable** channel release after the 0.7.0 evaluation prerelease. 0.8.0 is unused. Publish this version as a full GitHub release (not a prerelease) so `releases/latest` resolves and installed 0.7.0 builds can exercise the in-app updater. **1.0.0** is a later stable, after that upgrade is proven.

### Highlights

- **Native tray, quit, and conversations:** Tray Open/Quit from app start, quit waits for a conversation flush (or 2s), and streaming updates follow the originating conversation.
- **Honest Stop:** Chat Stop settles the caller; Foundry has no abort API, so the UI does not claim native inference stopped. Compare and audio say they cannot be cancelled once started.
- **Diagnostics:** Gateway access log is metadata only. A bounded health ring is included in diagnostics export. **Test local endpoint** checks envelope, chat, stream `[DONE]`, usage, disconnect, tools, and embeddings (blocked when no embedding model is present).
- **Embeddings path:** `POST /v1/embeddings` autoloads like chat. BYOM import of an embedding ONNX folder does not require a chat prompt template. Sidecar `embedTexts` is available. There is still no Flint-tested embedding recipe; Continue's indexer is not verified. Full RAG is not in this release.
- **Packaging and updater:** Windows CI launches the packaged exe until the sidecar is ready. About can Install / show progress / Restart to update / Later. This release is the first `channel=stable` publish.

### Installing and upgrading

- **From 0.7.0 evaluation:** keep that build installed; after 0.9.0 is published as the latest full release, About should offer the update. Do not install 0.9.0 as a GitHub prerelease or the updater will not see it.
- **Fresh install:** Windows `.msi` or `-setup.exe` from [GitHub Releases](https://github.com/joelst/flint/releases). macOS remains unsigned evaluation-only (`scripts/install-macos.sh` or `xattr -cr`).
- **Rollback:** install the previous Windows MSI/NSIS from GitHub Releases; the updater does not downgrade.

## 0.7.0

Flint 0.7.0 is a foundation evaluation prerelease of the desktop control plane for Microsoft Foundry Local. This release establishes a dependable desktop runtime, truthful service and accelerator lifecycle states, isolated per-conversation data integrity, and a documented extension boundary for tools and experiments.

### Highlights & Capabilities

- **Native Runtime Supervision:** A thin Rust supervisor owns the long-lived Foundry sidecar process, enforces single-instance application launches with existing-window restore, manages generation-tagged stdio JSON-lines communication, and provides bounded write queue backpressure.
- **Model Catalog & Execution Providers:** Discover, download, load, and manage models directly from the Foundry Local SDK catalog. Hardware-aware accelerator tracks (CPU, DirectML/CUDA GPU, NPU) are verified before assignment.
- **Bring Your Own Model (BYOM) & Linked Storage:** Import local ONNX model folders with automatic prompt template synthesis and editing (`inference_model.json`), and link external model directories via directory junctions without copying files or modifying foreign folders.
- **Cache Inventory & Management:** Read-only cache inventory analysis detects duplicate model variants across cache roots, partial download artifacts, and reclaimable disk space.
- **Chat & Conversation Integrity:** Durable per-conversation storage isolates message histories, persists individual settings (model alias, persona, context length, and thread view), supports multi-image vision attachment, host-aware context, URL fetching into context, and offers conversation export (JSON, Markdown, text) with storage safety warnings.
- **Audio & Transcription:** Local speech-to-text audio transcription supporting microphone input and file uploads, protected by strict browser WAV normalization validation before passing bytes to the decoding engine.
- **Model Arena:** Side-by-side multi-model comparison allowing side-by-side prompting, live streaming generation across candidate models, scoring, and evaluation result export.
- **OpenAI-Compatible Local Endpoint:** Reverse proxy gateway running on loopback (`http://127.0.0.1:<port>/v1`) or configurable network interfaces. Features on-demand auto-loading for unresident cached models upon receiving inference requests, and normalizes chat completion JSON and SSE responses with `[DONE]` termination.
- **Monitoring & Resource Watchdog:** Real-time resource gauges, active model pool tracking with LRU eviction and pinning options, memory watchdog alerts, and diagnostic access logging with JSON/CSV export.
- **Zero-Dependency Packaging:** Installers bundle Node 22 runtime binaries and Foundry Local native core libraries, eliminating the requirement for a pre-installed system Node runtime.

### Installing This Prerelease

Flint 0.7.0 is published as a GitHub prerelease, so the in-app updater will not offer it. GitHub's `releases/latest` pointer skips prereleases by design, and this build is an evaluation handoff rather than an in-place upgrade. Install it manually from the release assets: the `.msi` or `-setup.exe` on Windows, or the `.dmg` on macOS Apple Silicon (see the note below).

### macOS Installation Note

macOS builds are currently unsigned and require Apple Silicon (macOS 14+). When downloaded via a browser, macOS Gatekeeper may display a warning that the package is damaged or cannot be opened. To install and launch cleanly:

```bash
# Recommended one-line install:
curl -fsSL https://raw.githubusercontent.com/joelst/flint/main/scripts/install-macos.sh | bash

# Or for manual DMG installs, clear the quarantine flag:
xattr -cr /Applications/Flint.app
```
