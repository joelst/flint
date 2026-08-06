# Flint user guide

Short path from install to chat and external tools. For **why** Flint exists, see the [README](../README.md). For development, see [DEVELOPMENT.md](./DEVELOPMENT.md).

---

## Requirements

- **Windows** (primary) or **macOS on Apple silicon**  
  Intel Mac is not supported until Foundry publishes `darwin-x64` native cores.
- **Node.js 22+** on your PATH (JS sidecar). Install LTS from [nodejs.org](https://nodejs.org), then restart Flint.
- Foundry Local **runtime is bundled** — you do not need a separate Foundry CLI for normal use.

Flint checks Node on launch and shows guidance if it is missing or too old.

---

## First five minutes

1. **Open Flint**  
   If the getting-started coach appears, follow it or open **Help**.

2. **Models**  
   - Browse the catalog (broader surface than the Foundry CLI alone — SDK-backed).  
   - Download a **small** starter if recommended, then **Load** a chat-capable model.  
   - Avoid loading only an STT (audio) model if you want Chat.

3. **Chat**  
   - Open **Chat**, send a message.  
   - Optional: personas, system prompt, image attach (vision models), URL → context chips.

4. **Optional — service for other apps**  
   - **Diagnostics → Start service**.  
   - **Integrations** — pick OS, copy snippets.  
   - Client URL is always **`http://127.0.0.1:<port>/v1`** (loopback).

---

## Common tasks

### Download / load / unload models

- **Models** tab: search, filter, download with progress, load into the pool.  
- Multiple models can stay loaded when memory allows (see **Monitor**).  
- Update badges: newer catalog versions for the **same** acceleration track (CPU/GPU/NPU), not cross-grade noise.

### Chat and conversations

- Conversations live in the sidebar; new chat via UI or shortcut (see **?**).  
- Streaming responses; stop/cancel when supported.  
- Vision: attach up to four images when the loaded model supports it.

### Audio transcription

- **Audio** tab: pick an STT model, use mic or file.  
- Chat and audio share the local service — only one “active” path at a time for some flows; load the right model for the task.

### Compare models

- **Compare**: pick 2–3 models/variants, one prompt, side-by-side results and ratings.  
- Useful before downloading large weights.

### Monitor

- Pool table, resource gauges, access log (in-memory + `~/.flint/logs/`).  
- Export access log as JSON/CSV from the Monitor toolbar.

### Network bind vs client URL

| Setting | Meaning |
|---|---|
| **Bind address** (Settings → Network) | Interface the service **listens** on (`127.0.0.1`, `0.0.0.0`, or a custom IP). |
| **Client / Integrations URL** | Always **`http://127.0.0.1:<port>/v1`** so local tools connect over loopback. |

After changing port or bind: **Apply & restart** (or Apply if the service is stopped, then Start in Diagnostics). Non-loopback bind asks for confirmation — it can expose the service on your network.

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
| Could not start Foundry / sidecar | Install Node 22+, confirm `node -v` in a terminal, restart Flint. |
| No models | **Models** → download a starter; wait for catalog. |
| Chat disabled | Load a **chat** model (not STT-only); check Help → Troubleshooting. |
| Integrations “not started” | **Diagnostics → Start service**. |
| Bind/port ignored | Settings → **Apply & restart**. |
| SmartScreen / unidentified developer | Expected with self-signed builds until release certs. |

In-app: **Help** tab and the first-run coach (Help → “Show the getting-started coach” if dismissed).

---

## Tool calling

Models may return `tool_calls` on the OpenAI-compatible API. **Flint’s chat UI does not execute tools.** Point an agent client (Continue, Cline, your code) at the local endpoint; that client owns permissions and confirmation.

---

## Get more help

- [README](../README.md) — why Flint, screenshots, status  
- [Help](../src/routes/+page.svelte) tab in the app  
- [Foundry Local](https://github.com/microsoft/Foundry-Local) upstream  
- [GitHub Issues](https://github.com/joelst/flint/issues) for Flint bugs
