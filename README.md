# Flint

[![CI](https://github.com/joelst/flint/actions/workflows/ci.yml/badge.svg)](https://github.com/joelst/flint/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/joelst/flint?include_prereleases&label=release)](https://github.com/joelst/flint/releases)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20Apple%20silicon-blue)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**The desktop control plane for [Microsoft Foundry Local](https://github.com/microsoft/Foundry-Local).**

Manage models on your machine, chat and transcribe locally, pit models against each other in the Model Arena, and expose an **OpenAI-compatible endpoint** to the coding tools you already use — without sending prompts to a cloud by default.

Flint is the dependable foundation around Foundry Local: it turns the SDK's
catalog, hardware variants, model lifecycle, local inference, and endpoint into
one place that developers can use, evaluate, and extend. Build a tool on top of
the endpoint, add a workflow to the UI, or contribute a capability through the
typed SDK/sidecar boundary without owning another model manager.

---

## Why Flint?

| You want… | Flint gives you… |
|---|---|
| **Privacy** | Inference stays on-device. Network bind defaults to loopback; non-loopback requires an explicit choice and confirmation. Listing/refreshing the model catalog does contact Microsoft's Foundry Local catalog over the network (checked on startup by default; can be turned off in Settings). |
| **Full catalog, not a CLI subset** | The Foundry Local **CLI** is great for quick experiments, but it only surfaces **part** of what the runtime can run. Flint talks to the **official SDK**, so you get the broader model catalog (chat, vision, STT, acceleration variants) without writing and maintaining your own wrapper around the service. |
| **Hardware you already paid for** | Hardware-aware recommendations and CPU / GPU / NPU variants through the SDK—not guesswork from CLI flags alone. |
| **One local endpoint for many tools** | Start a service and point Continue, Cline, OpenAI SDKs, and other clients at `http://127.0.0.1:<port>/v1`. |
| **More than a single chat tab** | Multi-model **pool**, **Model Arena** bake-offs, chat + STT, Monitor (resources, access log, audit). |
| **Foundry-native, not a hack** | Built on `foundry-local-sdk` (catalog, download, load, inference, service)—not fragile CLI scraping. |
| **A path to cloud later** | Same OpenAI-shaped surface as Azure AI Foundry — local first, cloud profiles planned. |

### Flint vs Foundry Local CLI

| | Foundry Local CLI | Flint |
|---|---|---|
| **Model surface** | Practical subset for common CLI flows | Broader **SDK catalog** + acceleration-specific variants |
| **Day-to-day UX** | Commands, scripts, your own glue | GUI for download/load/pool, chat, audio, arena runs, logs |
| **External tools** | You stand up and wire the OpenAI-compatible service yourself | Start service, copy Integrations snippets, manage bind/port |
| **Custom wrapper** | Often needed for a full app experience | **You don’t**—Flint *is* the maintained control plane on top of the SDK |

Use the CLI when you want a terminal-first workflow. Use Flint when you want the full local model surface and a durable UI/endpoint without owning that wrapper.

**Built for:** developers and power users who want local models *and* IDE/agent tools on one endpoint; privacy-sensitive or offline-friendly workflows; people evaluating models before committing disk and VRAM.

**Not built for:** zero-install “ChatGPT clone” installs (see [Requirements](#requirements)); fully autonomous agents *inside* the app (use an agent client against Flint’s endpoint); training or fine-tuning.

---

## What’s in the app

- **Build** — Playground (Chat/Voice toggle), Model Arena Quick Compare (live streaming, Stop that halts further output per slot, served variant/provider/status), and an opt-in **Benchmark Preview** for repeatable multi-model runs with Stop/Resume
- **Discover** — Models: catalog, search/filter, hardware-aware picks, download/load/unload, multi-model pool, update notifications per acceleration track
- **Operate** — Monitor (pool, resource gauges, access/audit logs), Diagnostics (service start/stop, endpoint self-test, health ring), Integrations (copy-paste setup for OpenAI-compatible tools)
- **Manage** — Settings (bind/port with Apply & restart, autostart, defaults, shortcuts (`?`)) and Help (first-run coaching, empty-state guidance, About strip)

Chat supports streaming, conversations, personas, system prompts, multi-image vision, host-aware context, and optional URL → context. Audio supports mic + file transcription (STT).

No system Node install is required: release builds bundle their own Node 22 runtime for the Foundry sidecar.

---

## Status

Pre-1.0: expect breaking changes. **0.9.0 is Flint's first stable channel release** (0.8.0 was skipped), following the 0.7.0 evaluation prerelease. [Installers and release notes](https://github.com/joelst/flint/releases).

- Windows installers carry a **public-trust Authenticode signature** issued through Azure Trusted Signing, so they validate against the Microsoft-managed root on any machine — no certificate to install and no "unknown publisher" prompt. Bundles ship the Foundry native cores and a pinned Node 22 runtime, verified in CI.
- macOS builds are **unsigned** (no Apple Developer account) — install with the one-liner below, not the DMG, or Gatekeeper will call the app "damaged".
- The in-app updater is configured and its artifacts (`latest.json`, `.sig`) ship with every stable release. From **About**, an available update can be installed with visible download progress, then **Restart to update** or **Later**. Prereleases (like 0.7.0) are never offered through this channel — GitHub's `releases/latest` pointer skips them by design, so that build had to be installed manually.

Next: [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) · [docs/BACKLOG.md](./docs/BACKLOG.md) · Release notes: [CHANGELOG.md](./CHANGELOG.md)

Living reliability plan: **[docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md)** · End-user walkthrough: **[docs/USER_GUIDE.md](./docs/USER_GUIDE.md)**

---

## Screenshots

Each section shows Windows and macOS in dark mode (Flint's default) and light mode. Benchmark Preview is opt-in and off by default, so it is not part of this default screenshot set.
Regenerate these with `node scripts/capture-screenshots.mjs` — see
[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md#screenshots).

### Chat

| Platform | Dark | Light |
|---|---|---|
| Windows | ![Flint chat window on Windows (dark)](images/flint-chat-window-dark.png) | ![Flint chat window on Windows (light)](images/flint-chat-window-light.png) |
| macOS | ![Flint chat window on macOS (dark)](images/flint-macos-chat-window-dark.png) | ![Flint chat window on macOS (light)](images/flint-macos-chat-window-light.png) |

### Voice

| Platform | Dark | Light |
|---|---|---|
| Windows | ![Flint audio page on Windows (dark)](images/flint-audio-page-dark.png) | ![Flint audio page on Windows (light)](images/flint-audio-page-light.png) |
| macOS | ![Flint audio page on macOS (dark)](images/flint-macos-audio-page-dark.png) | ![Flint audio page on macOS (light)](images/flint-macos-audio-page-light.png) |

### Model Arena

| Platform | Dark | Light |
|---|---|---|
| Windows | ![Model Arena on Windows (dark)](images/flint-model-compare-page-1-dark.png) | ![Model Arena on Windows (light)](images/flint-model-compare-page-1-light.png) |
| macOS | ![Model Arena on macOS (dark)](images/flint-macos-model-compare-page-1-dark.png) | ![Model Arena on macOS (light)](images/flint-macos-model-compare-page-1-light.png) |

### Models

| Platform | Dark | Light |
|---|---|---|
| Windows | ![Flint model selection on Windows (dark)](images/flint-model-selection-dark.png) | ![Flint model selection on Windows (light)](images/flint-model-selection-light.png) |
| macOS | ![Flint model selection on macOS (dark)](images/flint-macos-model-selection-dark.png) | ![Flint model selection on macOS (light)](images/flint-macos-model-selection-light.png) |

### Monitor

| Platform | Dark | Light |
|---|---|---|
| Windows | ![Monitor resources on Windows (dark)](images/flint-monitor-page-dark.png) | ![Monitor resources on Windows (light)](images/flint-monitor-page-light.png) |
| macOS | ![Monitor resources on macOS (dark)](images/flint-macos-monitor-page-dark.png) | ![Monitor resources on macOS (light)](images/flint-macos-monitor-page-light.png) |

### Diagnostics

| Platform | Dark | Light |
|---|---|---|
| Windows | ![Diagnostics on Windows (dark)](images/flint-diagnostics-page-dark.png) | ![Diagnostics on Windows (light)](images/flint-diagnostics-page-light.png) |
| macOS | ![Diagnostics on macOS (dark)](images/flint-macos-diagnostics-page-dark.png) | ![Diagnostics on macOS (light)](images/flint-macos-diagnostics-page-light.png) |

### Integrations

| Platform | Dark | Light |
|---|---|---|
| Windows | ![Integrations on Windows (dark)](images/flint-integrations-page-dark.png) | ![Integrations on Windows (light)](images/flint-integrations-page-light.png) |
| macOS | ![Integrations on macOS (dark)](images/flint-macos-integrations-page-dark.png) | ![Integrations on macOS (light)](images/flint-macos-integrations-page-light.png) |

### Settings

| Platform | Dark | Light |
|---|---|---|
| Windows | ![Settings on Windows (dark)](images/flint-settings-page-dark.png) | ![Settings on Windows (light)](images/flint-settings-page-light.png) |
| macOS | ![Settings on macOS (dark)](images/flint-macos-settings-page-dark.png) | ![Settings on macOS (light)](images/flint-macos-settings-page-light.png) |

### Help

| Platform | Dark | Light |
|---|---|---|
| Windows | ![Help on Windows (dark)](images/flint-help-window-dark.png) | ![Help on Windows (light)](images/flint-help-window-light.png) |
| macOS | ![Help on macOS (dark)](images/flint-macos-help-window-dark.png) | ![Help on macOS (light)](images/flint-macos-help-window-light.png) |

---

## Requirements

### End users (installed app)

| Requirement | Notes |
|---|---|
| **Windows** (primary) or **macOS 14+ Apple silicon** | Intel Mac not supported until Foundry publishes `darwin-x64` native cores. macOS 14 is the floor because the bundled `libonnxruntime.dylib` is built with `minos 14.0`. |
| **Node runtime (sidecar)** | **Release builds ship a bundled Node 22 binary** (Tauri externalBin) for the JS sidecar — PATH Node is not required when packaging is complete. Dev/fallback: Node 22+ on PATH. About shows `bundled` vs `PATH`. |
| Foundry runtime | **Bundled** — you do not need a separate Foundry CLI for normal use |

### Developers (building from source)

- Node.js 22+ and npm  
- Rust + Cargo (Tauri 2)  
- Windows: MSVC + Windows SDK (see [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md); `build-local.ps1` helps wire `cl.exe` / SignTool)

---

## Quick start

### Use a release build

1. Install a build from [GitHub Releases](https://github.com/joelst/flint/releases) (or build from source below). Once 0.9.0 is published as a full release (not a prerelease), it appears under "Latest".
   - **macOS**: builds are unsigned, so a browser-downloaded DMG is blocked by Gatekeeper as "damaged". Install with:

     ```bash
     curl -fsSL https://raw.githubusercontent.com/joelst/flint/main/scripts/install-macos.sh | bash
     ```

     (Already installed the DMG? `xattr -cr /Applications/Flint.app` fixes it.)
2. Open Flint (release installers include a bundled Node for the sidecar).  
3. Download a small starter model → open **Chat**.  
4. Optional: **Diagnostics → Start service**, then use **Integrations** to wire other tools.  

If the app cannot start the sidecar, install **Node.js 22+** LTS as a fallback or reinstall Flint.

Client URL for tools is usually **`http://127.0.0.1:<port>/v1`** (loopback); tools running inside WSL2 in its default NAT mode cannot reach that address and need **Settings → Network → WSL clients**. The **bind address** in Settings controls what the service *listens* on and may differ (e.g. `0.0.0.0` for LAN). Use **Apply & restart** after changing bind/port.

### Develop from source

```bash
npm install
npm run tauri dev
```

```bash
npm run tauri:build:local  # local package; --no-sign skips all code signing
npm run verify:bundle      # checks Foundry natives in the package
npm run run:built          # launch the release binary without installing
```

`npm run tauri:build` is the release command: it signs the updater artifacts and needs
`TAURI_SIGNING_PRIVATE_KEY`.

Full scripts, sidecar, and versioning: [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)  
Signing and release pipeline: [docs/RELEASE.md](./docs/RELEASE.md)

---

## Known limitations

- **Node:** release builds prefer a **bundled** Node binary; PATH Node remains a dev/fallback. Packaged builds already remove the end-user Node install; shrinking the spawn surface further is post-1.0.
- **macOS is unsigned** and evaluation-only for 1.0. Browser-downloaded DMGs trigger a Gatekeeper "damaged" warning; use the install one-liner or `xattr -cr`. 1.0 production is Windows. Windows installers are publicly trusted and do not carry this caveat. A new Windows publisher identity may still accumulate SmartScreen reputation over the first downloads.
- **The updater does not discover prereleases.** The 0.7.0 evaluation build had to be installed manually; see [Status](#status). Stable releases from 0.9.0 onward are discoverable through the in-app updater.
- **Audio** quality depends on the STT model and runtime.
- **Tool calling:** models may emit `tool_calls`; Flint’s chat UI does **not** execute tools — use an agent client against the local endpoint.  
- Unit/contract tests are strong; full UI E2E is still light.

---

## Tech stack

- **Tauri 2** (Rust + system WebView)  
- **Svelte 5** + SvelteKit + TypeScript  
- **foundry-local-sdk** via a **Node stdio sidecar** (`sidecar/foundry-sidecar.js`)

Architecture principles: [FLINT_DESIGN_SPEC.md](./FLINT_DESIGN_SPEC.md)

---

## Documentation

| Doc | Audience |
|---|---|
| [AGENTS.md](./AGENTS.md) | AI agents — token-saving map of which doc to load |
| [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md) | 1.0 implementation sequencing and acceptance gates |
| [docs/README.md](./docs/README.md) | Full doc index |
| [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) | Forward plan through 1.0 & the 1.0 release bar |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Build, sidecar, versioning |
| [docs/EXTENDING.md](./docs/EXTENDING.md) | Build new workflows and integrations on the Flint core |
| [docs/RELEASE.md](./docs/RELEASE.md) | Sign & ship |
| [docs/ADMIN.md](./docs/ADMIN.md) | Operator runbook for an installed app |
| [docs/BACKLOG.md](./docs/BACKLOG.md) | Deferred and post-1.0 follow-ups |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes |

---

## License

MIT

## Contributing

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md). Product direction: [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md) and [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md).

---

Local-first by default. Foundry Local underneath. Your hardware, your data, your tools.
