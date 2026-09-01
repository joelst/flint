# Flint

**The desktop control plane for [Microsoft Foundry Local](https://github.com/microsoft/Foundry-Local).**

Manage models on your machine, chat and transcribe locally, pit models against each other in the Model Arena, and expose an **OpenAI-compatible endpoint** to the coding tools you already use — without sending prompts to a cloud by default.

> Also styled **FLInt** (Foundry Local INTerface). Product name: **Flint**.

---

## Why Flint?

| You want… | Flint gives you… |
|---|---|
| **Privacy** | Inference stays on-device. Network bind defaults to loopback; non-loopback requires an explicit choice and confirmation. |
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

- **Models** — catalog, search/filter, hardware-aware picks, download/load/unload, multi-model pool, update notifications per acceleration track  
- **Chat** — streaming, conversations, personas, system prompts, multi-image vision, host-aware context, optional URL → context  
- **Audio** — mic + file transcription (STT)  
- **Model Arena** — side-by-side prompts, ratings, export  
- **Monitor** — pool, resource gauges, access/audit logs  
- **Integrations** — copy-paste setup for OpenAI-compatible tools  
- **Diagnostics / Settings** — service start/stop, bind/port (Apply & restart), autostart, defaults, shortcuts (`?`)  
- **Help** — first-run coaching, empty-state guidance, and an About strip

No system Node install is required: release builds bundle their own Node 22 runtime for the Foundry sidecar.

---

## Status

**0.4.4** — [signed installers on the releases page](https://github.com/joelst/flint/releases/latest). Pre-1.0: expect breaking changes.

- Windows installers are Authenticode-signed (Azure Trusted Signing); bundles ship the Foundry native cores and a pinned Node 22 runtime, verified in CI.
- In-app updater tracks the latest GitHub release.
- macOS builds are **unsigned** (no Apple Developer account) — install with the one-liner below, not the DMG, or Gatekeeper will call the app "damaged".

Next: [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) · [docs/BACKLOG.md](./docs/BACKLOG.md) · Release notes: [CHANGELOG.md](./CHANGELOG.md)

Living plan (docs, help, 0.4, 1.0): **[docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md)** · End-user walkthrough: **[docs/USER_GUIDE.md](./docs/USER_GUIDE.md)**

---

## Screenshots

### Main window

![Flint main window](./images/flint-main-window.png)

### Model selection

![Flint model selection](./images/flint-model-selection.png)

### Chat

![Flint chat window](./images/flint-chat-window.png)

### Model Arena

![Model Arena selections](images/flint-model-compare-page-1.png)
![Model Arena results](images/flint-model-compare-page-2.png)

### Integrations

![integrations](images/flint-integrations-page.png)

### Settings

![settings](images/flint-settings-page.png)

### Diagnostics

![diagnostics](images/flint-diagnostics-page.png)

### Audio

![audio](images/flint-audio-page.png)

### Monitor

![monitor resources](images/flint-monitor-page.png)

---

## Requirements

### End users (installed app)

| Requirement | Notes |
|---|---|
| **Windows** (primary) or **macOS Apple silicon** | Intel Mac not supported until Foundry publishes `darwin-x64` native cores |
| **Node runtime (sidecar)** | **Release builds ship a bundled Node 22 binary** (Tauri externalBin) for the JS sidecar — PATH Node is not required when packaging is complete. Dev/fallback: Node 22+ on PATH. About shows `bundled` vs `PATH`. |
| Foundry runtime | **Bundled** — you do not need a separate Foundry CLI for normal use |

### Developers (building from source)

- Node.js 22+ and npm  
- Rust + Cargo (Tauri 2)  
- Windows: MSVC + Windows SDK (see [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md); `build-local.ps1` helps wire `cl.exe` / SignTool)

---

## Quick start

### Use a release build

1. Install a build from [GitHub Releases](https://github.com/joelst/flint/releases) when available (or build below).
   - **macOS**: builds are unsigned, so a browser-downloaded DMG is blocked by Gatekeeper as "damaged". Install with:

     ```bash
     curl -fsSL https://raw.githubusercontent.com/joelst/flint/main/scripts/install-macos.sh | bash
     ```

     (Already installed the DMG? `xattr -cr /Applications/Flint.app` fixes it.)
2. Open Flint (release installers include a bundled Node for the sidecar).  
3. Download a small starter model → open **Chat**.  
4. Optional: **Diagnostics → Start service**, then use **Integrations** to wire other tools.  

If the app cannot start the sidecar, install **Node.js 22+** LTS as a fallback or reinstall Flint.

Client URL for tools is always **`http://127.0.0.1:<port>/v1`** (loopback). The **bind address** in Settings controls what the service *listens* on and may differ (e.g. `0.0.0.0` for LAN). Use **Apply & restart** after changing bind/port.

### Develop from source

```bash
npm install
npm run tauri dev
```

```bash
npm run tauri:build    # runs ensure:foundry + frontend build + package
npm run verify:bundle  # checks Foundry natives in the package
npm run run:built      # launch the release binary without installing
```

Full scripts, sidecar, and versioning: [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)  
Signing and release pipeline: [docs/RELEASE.md](./docs/RELEASE.md)

---

## Known limitations

- **Node:** release builds prefer a **bundled** Node binary; PATH Node remains a dev/fallback. Long-term 1.0 goal is no end-user Node install at all (bundled or Rust).  
- **Code signing / updater keys** may still be operator-configured for public releases.  
- **Self-signed** installers can trigger SmartScreen / Gatekeeper warnings.  
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
| [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md) | Next work: docs, help, 0.4, 1.0 |
| [docs/README.md](./docs/README.md) | Full doc index |
| [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) | Release scorecards & plans |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Build, sidecar, versioning |
| [docs/RELEASE.md](./docs/RELEASE.md) | Sign & ship |
| [docs/BACKLOG.md](./docs/BACKLOG.md) | Deferred follow-ups |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes |

Historical plans: [docs/archive/](./docs/archive/).

---

## License

MIT

## Contributing

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md). Product direction: [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md) and [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md).

---

Local-first by default. Foundry Local underneath. Your hardware, your data, your tools.
