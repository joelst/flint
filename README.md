# Flint

**The desktop control plane for [Microsoft Foundry Local](https://github.com/microsoft/Foundry-Local).**

Manage models on your machine, chat and transcribe locally, compare models side-by-side, and expose an **OpenAI-compatible endpoint** to the coding tools you already use — without sending prompts to a cloud by default.

> Also styled **FLInt** (Foundry Local INTerface). Product name: **Flint**.

---

## Why Flint?

| You want… | Flint gives you… |
|---|---|
| **Privacy** | Inference stays on-device. Network bind defaults to loopback; non-loopback requires an explicit choice and confirmation. |
| **Full catalog, not a CLI subset** | The Foundry Local **CLI** is great for quick experiments, but it only surfaces **part** of what the runtime can run. Flint talks to the **official SDK**, so you get the broader model catalog (chat, vision, STT, acceleration variants) without writing and maintaining your own wrapper around the service. |
| **Hardware you already paid for** | Hardware-aware recommendations and CPU / GPU / NPU variants through the SDK—not guesswork from CLI flags alone. |
| **One local endpoint for many tools** | Start a service and point Continue, Cline, OpenAI SDKs, and other clients at `http://127.0.0.1:<port>/v1`. |
| **More than a single chat tab** | Multi-model **pool**, **Compare** bake-offs, chat + STT, Monitor (resources, access log, audit). |
| **Foundry-native, not a hack** | Built on `foundry-local-sdk` (catalog, download, load, inference, service)—not fragile CLI scraping. |
| **A path to cloud later** | Same OpenAI-shaped surface as Azure AI Foundry — local first, cloud profiles planned. |

### Flint vs Foundry Local CLI

| | Foundry Local CLI | Flint |
|---|---|---|
| **Model surface** | Practical subset for common CLI flows | Broader **SDK catalog** + acceleration-specific variants |
| **Day-to-day UX** | Commands, scripts, your own glue | GUI for download/load/pool, chat, audio, compare, logs |
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
- **Compare** — side-by-side prompts, ratings, export  
- **Monitor** — pool, resource gauges, access/audit logs  
- **Integrations** — copy-paste setup for OpenAI-compatible tools  
- **Diagnostics / Settings** — service start/stop, bind/port (Apply & restart), autostart, defaults, shortcuts (`?`)

---

## Status

| | |
|---|---|
| **Version** | **0.3.3** on `main` |
| **Product** | 0.3 feature set is complete (pool, monitor, compare, integrations, network config, …) |
| **Packaging** | Installers ship **Flint.exe**, Foundry native cores, and fixed production sidecar paths |
| **Public release** | Cut a tagged release when signing secrets + updater key + clean-machine dogfood are done — see [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) and [docs/RELEASE.md](./docs/RELEASE.md) |

Living plan (docs, help, 0.4, 1.0): **[docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md)** · End-user walkthrough: **[docs/USER_GUIDE.md](./docs/USER_GUIDE.md)**

---

## Screenshots

### Main window

![Flint main window](./images/flint-main-window.png)

### Model selection

![Flint model selection](./images/flint-model-selection.png)

### Chat

![Flint chat window](./images/flint-chat-window.png)

### Model comparison

![model comparison selections](images/flint-model-compare-page-1.png)
![model comparison results](images/flint-model-compare-page-2.png)

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
| **Node.js 22+ on PATH** | Required for the JS sidecar that drives Foundry Local. Flint checks on launch and shows install help if missing. Download LTS from [nodejs.org](https://nodejs.org) |
| Foundry runtime | **Bundled** — you do not need a separate Foundry CLI for normal use |

### Developers (building from source)

- Node.js 22+ and npm  
- Rust + Cargo (Tauri 2)  
- Windows: MSVC + Windows SDK (see [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md); `build-local.ps1` helps wire `cl.exe` / SignTool)

---

## Quick start

### Use a release build

1. Install a build from [GitHub Releases](https://github.com/joelst/flint/releases) when available (or build below).  
2. Ensure **Node.js 22+** is on your PATH.  
3. Open Flint → download a small starter model → open **Chat**.  
4. Optional: **Diagnostics → Start service**, then use **Integrations** to wire other tools.

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

- **Node.js 22+** required on PATH until a future runtime ships without it (1.0 goal).  
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
