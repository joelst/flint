# Flint user guide

Short path from install to chat and external tools. For **why** Flint exists, see the [README](../README.md). For development, see [DEVELOPMENT.md](./DEVELOPMENT.md).

---

## Requirements

- **Windows** (primary) or **macOS on Apple silicon**  
  Intel Mac is not supported until Foundry publishes `darwin-x64` native cores.
  *macOS Installation note:* Unsigned macOS builds may prompt macOS Gatekeeper to report *"Flint is damaged and can't be opened."* To install without quarantine or fix an existing drag-and-drop install, see [macOS Gatekeeper Installation](#macos-gatekeeper-installation-unsigned-builds).
- **Node for the JS sidecar:** release builds ship a **bundled Node 22** binary; PATH Node is only a fallback (dev or incomplete install).  
- Foundry Local **runtime is bundled** — you do not need a separate Foundry CLI for normal use.

Flint prefers the packaged Node on launch (About shows `bundled` vs `PATH`) and shows guidance if neither works.

---

## Navigation

The sidebar is grouped by workflow:

- **Build** — Playground (Chat/Voice), Model Arena Quick Compare, and an opt-in **Benchmark Preview**
- **Discover** — Models
- **Operate** — Monitor, Diagnostics, Integrations
- **Manage** — Settings and Help

## First five minutes

1. **Open Flint**  
   If the getting-started coach appears, follow it or open **Help**.

2. **Models**  
   - Browse the catalog (broader surface than the Foundry CLI alone — SDK-backed).  
   - Download a **small** starter if recommended, then **Load** a chat-capable model.  
   - Avoid loading only an STT (audio) model if you want Chat.

3. **Playground**  
   - Open **Playground**, send a message. A **Chat / Voice** toggle inside switches modes.  
   - Optional: personas, system prompt, image attach (vision models), URL → context chips.

4. **Optional — service for other apps**  
   - **Diagnostics → Start service**.  
   - **Integrations** — pick OS, copy snippets.  
   - Client URL is usually **`http://127.0.0.1:<port>/v1`** (loopback) — clients inside WSL2 are the exception, see [Network bind vs client URL](#network-bind-vs-client-url).

---

## Common tasks

### Download / load / unload models

- **Models** tab: search, filter, download with progress, load into the pool.  
- Multiple models can stay loaded when memory allows (see **Monitor**).  
- Update badges: newer catalog versions for the **same** acceleration track (CPU/GPU/NPU), not cross-grade noise.

### Chat and conversations

- Conversations live in the sidebar; new chat via UI or shortcut (see **?**).  
- Streaming responses. **Stop** settles Flint's own caller and hides further output, but Foundry Local has no native abort API, so the background generation may still finish; text already received before Stop is kept.
- Vision: attach up to four images when the loaded model supports it.
- **Export conversations**: Export any chat thread as structured JSON, formatted Markdown, or plain text for documentation or archive.

### Bring Your Own Model (BYOM) and External Linking

- **Import local ONNX models**: Add custom ONNX models (containing `genai_config.json` and `inference_model.json`) into Flint's local cache directly from the Models tab.
- **Embedding models**: folders whose architecture or name contains `embed` import without a chat prompt template. The gateway supports `POST /v1/embeddings` with autoload, and the sidecar has an `embedTexts` command, but the Foundry catalog currently ships no embedding models — there is no Flint-verified end-to-end embedding recipe yet.
- **Link external model folders**: Connect existing models stored elsewhere on your drive using directory junctions without duplicating weights across folders.
- **Prompt template authoring**: Validate and customize Jinja/chat prompt templates using the `{Content}` placeholder to ensure proper message formatting. Embedding imports skip this.

### Model Cache Inventory

- View comprehensive disk space breakdowns across cached models, catalog families, and custom variants.
- Inspect and manage model footprint between Flint (`~/.flint`) and Foundry CLI (`~/.foundry`) storage roots.

### Automatic Model Loading (On-Demand Gateway)

- When external integrations (IDE extensions, agent frameworks, CLI tools) send requests to `http://127.0.0.1:<port>/v1/chat/completions` or `POST /v1/embeddings` for a model that is cached but not resident, Flint's gateway automatically loads the optimal variant into memory and completes the request seamlessly without failing with `400 Model is not loaded`.

### Audio transcription

- **Playground → Voice**: pick an STT model, use mic or file.  
- Chat and audio share the local service — only one “active” path at a time for some flows; load the right model for the task.
- Transcription cannot be stopped once started; the Transcribe control says so while in flight.

### Diagnostics self-test

**Diagnostics → Test local endpoint** checks the local gateway's envelope, chat round-trip, streaming `[DONE]` termination, `usage`, disconnect handling, and tool-call behavior, plus an embeddings check. The embeddings check is blocked when no embedding-capable model is cached — a blocked check is not evidence embeddings work end to end (see BYOM above).

### Tray and quitting

Flint installs its native tray icon at app start, independent of the window (Open Flint, Quit). On quit, Flint waits for an in-flight conversation save to flush (up to ~2 seconds) before exiting, and streaming replies are tracked by their originating conversation so switching chats mid-stream doesn't misroute updates.

### Updating Flint

On Windows, **Settings → About** checks the stable release channel. Checking is always manual — click **Check**; Flint never checks automatically and there is no update-available banner elsewhere in the app. When an update is available you can **Install** it, watch download progress, then **Restart to update** or **Later** (revisit anytime from About); or click **View release** to open the GitHub release page instead and download/install it yourself. Prereleases are never offered through this channel.

### Model Arena

- **Quick Compare**: pick 2–3 models or variants, send one prompt, and watch results stream live into side-by-side cards. Each result shows the served variant, execution provider, and run status. **Stop** prevents further slots from starting and stops showing new output for the active slot, but generation has no native abort API — the sidecar keeps draining it in the background and it may run to completion; text already streamed is kept.
- Useful before downloading large weights.
- **Benchmark Preview** (opt-in, off by default — enable under Settings): a separate, repeatable multi-model benchmark runner for measured comparisons across warmup/repeat runs, with a hardened Stop/Resume lifecycle. Unlike Quick Compare's one-shot interactive comparison, a benchmark run is a persisted, resumable job.

### Monitor

- Pool table, resource gauges, access log (in-memory + `~/.flint/logs/`).  
- Export access log as JSON/CSV from the Monitor toolbar.

### Network bind vs client URL

| Setting | Meaning |
|---|---|
| **Bind address** (Settings → Network) | Interface the service **listens** on (`127.0.0.1`, `0.0.0.0`, or a custom IP). |
| **Client / Integrations URL** | Usually **`http://127.0.0.1:<port>/v1`**; WSL NAT clients use the Windows host address from the manual setup below. |
| **WSL clients** (Settings → Network) | One-click **mirrored networking** lets tools running inside WSL2 use the usual loopback URL; NAT users can follow the manual setup below. |

After changing port or bind: **Apply & restart** (or Apply if the service is stopped, then Start in Diagnostics). Non-loopback bind asks for confirmation — it can expose the service on your network.

#### Tools running inside WSL2

WSL2's default NAT mode gives the VM its own loopback, so a client inside WSL — OpenClaw, OpenCode, Codex CLI — **cannot reach Flint on `127.0.0.1`**, even though the same URL works fine from Windows. This is the most common reason a copied Integrations snippet fails with a connection error.

Fix it in **Settings → Network → WSL clients**: it reports whether WSL is in NAT or mirrored mode and offers **Enable mirrored networking** in one click. Mirrored mode shares the host's interfaces including loopback, so Flint stays bound to `127.0.0.1` and WSL clients use the ordinary client URL with no change to the snippet. WSL must restart to apply; the panel offers that too. If you would rather stay on NAT, the same panel lists the manual steps for connecting to the Windows host address instead.

### Keyboard shortcuts

Press **`?`** in the app for the full list (views, new chat, send, push-to-talk, etc.).

---

## Flint vs Foundry CLI (quick)

| | CLI | Flint |
|---|---|---|
| Model surface | Practical subset for terminal flows | Broader **SDK catalog** + acceleration variants |
| Wrapper | Often DIY for a full app | Flint **is** the control plane |
| External tools | You wire the OpenAI-compatible service | Start service + Integrations snippets |

---

## Troubleshooting

| Symptom | What to try |
|---|---|
| macOS: "Flint is damaged and can't be opened" | Unsigned macOS build quarantine. Run `xattr -cr /Applications/Flint.app` in Terminal or use the install script. |
| Could not start Foundry / sidecar | Release builds ship a bundled Node 22 (About shows `bundled`). Restart Flint. PATH Node is only a fallback for `tauri dev` or an incomplete install. |
| No models | **Models** → download a starter; wait for catalog. |
| Chat disabled | Load a **chat** model (not STT-only); check Help → Troubleshooting. |
| Integrations “not started” | **Diagnostics → Start service**. |
| Bind/port ignored | Settings → **Apply & restart**. |
| WSL client cannot connect (works from Windows) | WSL2 NAT mode cannot reach `127.0.0.1` on the host. **Settings → Network → WSL clients → Enable mirrored networking**, then restart WSL. |
| Windows SmartScreen warning | Installers are signed with a public-trust certificate, but a new publisher identity can still show a SmartScreen prompt until it accumulates reputation. Before bypassing the warning, confirm the installer came from Flint's official GitHub release and that its Authenticode signature is valid and names the expected publisher; only then choose **More info → Run anyway**. |

In-app: **Help** tab and the first-run coach (Help → “Show the getting-started coach” if dismissed).

---

## macOS Gatekeeper Installation (Unsigned Builds)

Because macOS builds are not signed with an Apple Developer ID certificate, downloading the `.dmg` in a web browser attaches the `com.apple.quarantine` attribute. macOS Gatekeeper will then report that the app is *"damaged and can't be opened."*

### Recommended: Install via CLI (bypasses quarantine)
```bash
curl -fsSL https://raw.githubusercontent.com/joelst/flint/main/scripts/install-macos.sh | bash
```

### Manual DMG installation:
If you manually downloaded the DMG and dragged Flint to `/Applications`:
```bash
xattr -cr /Applications/Flint.app
```
Then launch Flint normally from Finder or Spotlight.

---

## Tool calling

Models may return `tool_calls` on the OpenAI-compatible API. **Flint’s chat UI does not execute tools.** Point an agent client (Continue, Cline, your code) at the local endpoint; that client owns permissions and confirmation.

---

## Get more help

- [README](../README.md) — why Flint, screenshots, status  
- [Help](../src/routes/+page.svelte) tab in the app  
- [Foundry Local](https://github.com/microsoft/Foundry-Local) upstream  
- [GitHub Issues](https://github.com/joelst/flint/issues) for Flint bugs
