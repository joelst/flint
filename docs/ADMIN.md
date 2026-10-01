# Flint operator runbook

How an installed Flint behaves on a machine. Cutting a signed build is
[RELEASE.md](./RELEASE.md). End-user first steps are [USER_GUIDE.md](./USER_GUIDE.md).

**1.0 production is Windows.** macOS Apple Silicon is evaluation-only (unsigned).
Linux is not a release target.

## Logs

| What | Where |
|---|---|
| Flint sidecar access/audit log (metadata only — no request/response bodies) | `~/.flint/logs/` (rotated; 7 days) |
| Foundry native runtime | `~/.foundry/logs` |
| In-app | Diagnostics → Copy All Diagnostics (includes the health ring) |

## Service lifecycle

1. Start the local service from **Diagnostics**.
2. The **client URL** is usually `http://127.0.0.1:<port>/v1`. Copy it from Diagnostics or About.
3. **Bind address** (Settings → Network) is where the gateway listens. Apply & restart after changes.
4. Non-loopback bind exposes the service on the network and asks for confirmation.
5. WSL2 NAT cannot reach host `127.0.0.1`. Settings → Network → WSL clients can enable mirrored networking.

Stop / Stop & Unload withdraws the endpoint. A Stop acknowledgement is not proof the native listener has gone quiet. **Stop service** withdraws HTTP availability only; **Stop & Unload** additionally fences new work and unloads models once admitted work and eviction finish.

Loaded-model telemetry has a 10-second sidecar wait budget. Expired queued reads never
start. If an already-dispatched asynchronous read remains unresolved, catalog mutations
are refused before changing files; retry after the read settles or restart the runtime.
The warning appears in the sidecar log, and unavailable loaded-state telemetry is reported
as unknown. This deadline does not cancel native work or interrupt a synchronous native
call that blocks Node's event loop.

## Packaged vs PATH Node

About shows Node as `bundled` or `PATH`. Release installers include Node 22. PATH Node is a development fallback. If About says Node is missing, the install is incomplete — reinstall from GitHub Releases, do not install Node as a user requirement.

## Offline and first run

The installer contains Flint, bundled Node, and Foundry native libraries. It does **not** contain chat model weights. Downloading your first model needs network access; cached models remain usable offline.

## Playground public web retrieval

Public web search and retrieval by the **model** is disabled by default and enabled per
conversation in Playground Generation settings; that toggle governs only model-initiated
`web_search`/`web_fetch` calls. Separately, a pasted or typed URL can be added as a context chip
and then fetched by clicking **Fetch** on that chip. That explicit, user-initiated fetch happens
immediately, independent of the toggle and of sending, and uses the same isolated helper and
network rules. Both paths run in a short-lived helper process separate from the Foundry sidecar.
The helper accepts only bounded public HTTPS search/fetch requests, rejects local and special IP
ranges on every DNS resolution and redirect, sends no cookies or credentials, and returns only
bounded text through memory-backed pipes. Raw retrieved bodies are not written to Flint's
conversation archive or access logs; the final answer and its visible source links are persisted.
Search terms and requested public URLs are disclosed to the public search service and destination
site. Search dispatch requires an affirmative **`Search the web for: <query>`** line in the
current user message, and the model must use that exact unquoted query. Model `web_fetch` dispatch
is limited to URLs typed or attached as URL chips in that same send. A final confirmation displays the exact
search query before dispatch; declining it sends no search request.
Flint admits at most two helper processes at once and refuses excess retrievals explicitly. The
Foundry chat transport does not support tools and image parts together, so Flint rejects that
combination before starting inference.
The helper inherits only minimal Windows runtime environment variables, but it is not an OS
security boundary against other processes running as the same signed-in user.

## Startup and model-management network access

Listing or refreshing the model catalog (which models exist, and whether a newer variant is
available) calls Foundry Local's SDK, which contacts Microsoft's remote Foundry model catalog
over the network — separate from inference, which always stays local. By default Flint checks
the catalog on startup and after actions like downloads. **Settings → Startup → "Check model
catalog on startup"** disables the startup check; the **Refresh catalog** button in the
Models view remains available for on-demand checks. Disabling the startup check also skips
recommendations and configured model preloads for that launch. A later manual refresh
populates the Models view but does not replay startup-only work; model-management actions can
also refresh the catalog to show their results.

Accelerator setup is separate from the catalog setting. Flint runs it automatically at startup,
and Foundry Local may download and register execution-provider components when the machine needs
them. Flint completes that registration before its first catalog read so the SDK includes every
compatible provider-specific variant in the snapshot. Turning off the startup catalog check does
not disable accelerator setup. Model downloads
and other explicitly requested model-management operations can also require network access.
There is currently no separate switch for startup accelerator setup, so prepare the required
components before disconnecting if the machine must launch fully offline.

**Recheck Providers** uses the same registration/catalog queue as startup and
**Install / Update Accelerators**. It waits for active setup before attempting
cache repair. If the catalog snapshot is unconfirmed, repair is deferred without
removing provider caches. After a confirmed snapshot, provider repair can proceed,
but Flint must restart before newly available variants enter the model catalog.

## Uninstall leftovers

Removing the app does not delete:

- `~/.flint/` (conversations, logs, settings)
- Foundry model cache under `~/.foundry/` (multi-GB)

Delete those directories only if you intend to drop local models and chat history.

## Updater

The in-app updater follows GitHub `releases/latest`. **Prereleases are skipped** — 0.7.0 evaluation builds must be installed by hand. **0.9.0** is the first stable publish (skip 0.8.0) so `latest.json` resolves; that is the upgrade test from 0.7.0. **1.0.0** is a later stable after that upgrade is proven.

Checking for updates is always manual (**Settings → About → Check**); Flint does not poll for updates automatically and shows no update-available banner elsewhere in the app. When an update is available, About offers two paths: **Install** it in place (visible download progress, then **Restart to update** or **Later**), or **View release** to open the GitHub release page and download/install it yourself.

If an update misbehaves: install the previous MSI/NSIS from GitHub Releases and do not take the in-app updater offer. See [RELEASE.md](./RELEASE.md).

## macOS evaluation

Unsigned builds. Prefer:

```bash
curl -fsSL https://raw.githubusercontent.com/joelst/flint/main/scripts/install-macos.sh | bash
```

or `xattr -cr /Applications/Flint.app` after a browser DMG install. Signing Flint.app does not un-quarantine the SDK's ad-hoc dylib.

## Packaged runtime smoke

After a debug Tauri build:

```bash
FLINT_RUNTIME_SMOKE=1  # set by the script
npm run smoke:runtime
```

The app starts, waits until the sidecar is ready, then exits 0. It does not download a model. CI runs this on Windows only.

## Embeddings (0.9.0 path)

`POST /v1/embeddings` is proxied and autoloaded like chat. Import an onnxruntime-genai
**embedding** ONNX folder via Models → Add model folder (no chat template). There is
no Flint-tested embedding recipe yet — do not treat Continue's indexer
as verified until that recipe exists. Diagnostics → Test local endpoint **blocks**
the embeddings check when no embedding model is in the local cache (`GET /v1/models`).

Full RAG (local file index, retrieval chips) is not in this release.

## Supported audio

The sidecar accepts 16 kHz mono PCM WAV. The browser transcodes whatever Web Audio can decode; conversion failures are rejected before bytes are sent. Broader container coverage is not a 1.0 promise.
