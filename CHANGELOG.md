# Flint Changelog

## 0.10.0

### Minor Changes

- f2b187d: Show benchmark suite definitions and case editing, and record full-call response time on finished runs.
- 770ba47: A local endpoint request for a cached build can load that build when another build of the same model is idle. Diagnostics → Test local endpoint runs the chat, embedding, and speech checks against every model id and parent alias the endpoint lists.
- b2be59c: Playground now exposes generation parameters — temperature, max tokens, top-p, top-k, frequency penalty, presence penalty, and a fixed sampling seed — in a collapsible panel next to the Context control, persisted per conversation the same way the model and system prompt are.
- 0cbd257: **Recheck Providers** on the Models page repairs execution providers that are not registered: it replaces a broken CUDA or WebGPU download, registers the others again, and names any provider that is still not registered. The button is visible in light and dark mode.

### Patch Changes

- aede9a3: Try the new Session/Request/Item AudioSession API first when transcribing audio, falling back to the deprecated AudioClient automatically for models it doesn't yet support (Nemotron, Parakeet). No user-visible change for those models; Whisper-family models now transcribe via the API that will replace AudioClient before its end-of-2026 removal.
- 9cc7044: Populate the model catalog after registering every discovered accelerator so compatible GPU variants are available.
  Keep loaded-model tracking accurate across restarts and eviction, and safely refuse catalog changes blocked by expired telemetry.
- d3f363b: Clarify the "catalog not yet checked" notice so it doesn't imply a check is already running.
- 26c1e1c: Replace the fixed-option Context turns dropdown with a continuous slider (4-40), fixing a bug where a model's recommended turn count often fell outside the preset list and left the control showing blank.
- 54190a5: Requests through the local endpoint that name a model alias, or a model that is not loaded yet, work again on Foundry Local 2.0.1: the gateway recognizes its not-loaded and not-found replies, loads the cached model, and replays under the loaded variant id. An explicit `:<version>` that is not cached is no longer served by another version.
- 54190a5: Canonicalize whitespace-padded model IDs before replaying local endpoint requests, including IDs that already match the loaded variant after trimming.
- 3edda9a: Gateway (OpenAI-compatible endpoint) rows in the Access Log now report token counts, time-to-first-token, and decode throughput for chat completions, instead of always showing "—". Captured from the response the proxy already parses for normalization, with no extra buffering of streamed responses.
- 6f77c24: Accept the macOS ONNX Runtime alias after Tauri copies release resources. The staged `libonnxruntime.dylib` is a regular file, not the symlink the SDK installer created, and the bundle check was failing the release on that copy.
- 99d9c9f: Builds no longer reuse a cached Foundry native runtime from a different SDK version; the CI cache is keyed to the exact lockfile.
- 56aa5d7: Recognize newer Nemotron ASR model names (e.g. `nemotron-3.5-asr-streaming-0.6b`) as speech models instead of chat, matching an `-asr-` marker in addition to the original `-speech-` naming.
- 0cbd257: Windows installs now replace the Foundry SDK and its ONNX Runtime instead of keeping the previous version's DLLs, and put the previous SDK back if the install fails or is cancelled. Builds no longer package an ONNX Runtime DLL that is not the pinned version.
- 2cf6b79: Transcription no longer fails with "Unable to decode audio data" for WAV files some WebView2/Chromium builds reject: Flint parses standard PCM WAV itself instead of relying solely on the browser decoder. Other formats (MP3, etc.) that still fail to decode now report which container was detected and suggest converting to WAV.

## 0.9.1

### Patch Changes

- af0f764: Refuse to start a benchmark while a model download is still in progress, including one left running by a page reload, and refuse a new download while a benchmark holds exclusive admission.
- 531dacd: Add a Settings → Startup toggle ("Check model catalog on startup") to disable the automatic startup check against Microsoft's Foundry Local model catalog. Recommendations and configured model preloads are skipped for that launch when disabled. Docs now disclose when catalog network access occurs.
- 33cfbf6: Rebuild app resources when Flint icons change and brand the Windows installer and uninstaller with the current app icon.
- f60cffc: Update the bundled Foundry Local SDK from 1.2.4 to 2.0.1 so models such as Gemma 4 can load. Long native load errors stay in the app log; the header shows one truncated line instead of growing to fit the stack trace.
- 2506d2b: Improve control contrast, catalog accelerator labels, and runtime failure diagnostics.
- 87f5dd0: About → Updates: add a "View release" link next to Install/Later that opens the GitHub release page for the available version, so users can download and install it manually as an alternative to the in-app updater.

## 0.9.0

First **stable** channel release after the 0.7.0 evaluation prerelease. 0.8.0 is unused. Publish this version as a full GitHub release (not a prerelease) so `releases/latest` resolves and installed 0.7.0 builds can exercise the in-app updater. **1.0.0** is a later stable, after that upgrade is proven.

### Highlights

- **Native tray, quit, and conversations:** Tray Open/Quit from app start, quit waits for a conversation flush (or 2s), and streaming updates follow the originating conversation.
- **Honest Stop:** Chat Stop settles the caller; Foundry has no abort API, so the UI does not claim native inference stopped. Quick Compare's Stop halts further output for running/pending slots the same way (native generation may still finish in the background); audio transcription cannot be cancelled once started.
- **Diagnostics:** Gateway access log is metadata only. A bounded health ring is included in diagnostics export. **Test local endpoint** checks envelope, chat, stream `[DONE]`, usage, disconnect, tools, and embeddings (blocked when no embedding model is present).
- **Embeddings path:** `POST /v1/embeddings` autoloads like chat. BYOM import of an embedding ONNX folder does not require a chat prompt template. Sidecar `embedTexts` is available. There is still no Flint-tested embedding recipe; Continue's indexer is not verified. Full RAG is not in this release.
- **Model Arena — Quick Compare and Benchmark Preview:** Quick Compare now streams live, Stop halts further output for the running/pending slots (native generation may still finish in the background), and each result shows served variant, execution provider, and run status. A new opt-in **Benchmark Preview** (off by default) under Build adds measured, repeatable multi-model benchmark runs with a hardened Stop/Resume lifecycle (write-ahead-intent-then-terminal-commit journal), plus a testable storage module so save/load failures surface in the App Log instead of failing silently. Benchmark exclusivity drains orphaned load/unload/delete/startService operations left by a previous page instance so a run's timing can't be corrupted by leftover work from a reload. Model downloads and benchmark runs are mutually fenced at the UI (each is blocked from starting while the other is active) but this does not cover a download orphaned by a page reload.
- **Navigation and visual refresh:** Sidebar regrouped into Build (Playground, Model Arena), Discover (Models), Operate (Monitor, Diagnostics, Integrations), and Manage (Settings, Help), with Chat/Audio merged into a single Playground entry. New Flint "F" app icon and favicon across Windows/macOS bundles and web assets. Native selects (including the Models sort dropdown) and the header theme toggle icon now themed correctly in both light and dark mode. Refreshed README/docs screenshots for dark and light mode.
- **Chat reliability:** Requested temperature/maxTokens are now applied on the SDK chat transport (previously only the audio path honored them). Reasoning/"thinking" state no longer bleeds between messages when a render slot is reused, and models whose chat template opens `<think>` in the prompt prefix (e.g. qwen3.5-9b) now collapse their reasoning instead of dumping it into the visible answer.
- **Runtime hardening:** Dependency/native-core stdout noise can no longer corrupt the sidecar's IPC protocol or show up as a spurious log error; the app's own local gateway is reachable at `http://127.0.0.1` (not just `http://localhost`) so the endpoint self-test and other in-app fetches don't fail CSP. Memory/eviction settings no longer silently fail to apply after a reload — a superseded settings change now surfaces a warning instead of failing silently.
- **Integrations:** Only integrations that can actually connect to Flint are shown.
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
