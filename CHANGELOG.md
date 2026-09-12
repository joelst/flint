# Flint Changelog

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

### macOS Installation Note

macOS builds are currently unsigned and require Apple Silicon (macOS 14+). When downloaded via a browser, macOS Gatekeeper may display a warning that the package is damaged or cannot be opened. To install and launch cleanly:

```bash
# Recommended one-line install:
curl -fsSL https://raw.githubusercontent.com/joelst/flint/main/scripts/install-macos.sh | bash

# Or for manual DMG installs, clear the quarantine flag:
xattr -cr /Applications/Flint.app
```
