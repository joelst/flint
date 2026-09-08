# Flint Changelog

## 0.6.0

### Minor Changes

- 662172b: Add the storage layer for the versioned conversation archive.

  The schema module decides what is safe to keep; this decides when it is safe to write. Its
  guiding rule is that a read we did not fully understand must never become a write, which is
  exactly how the pre-v2 data loss happened.

  - Opening an archive that is unreadable, incompatible, or newer than this build blocks
    writing for the session instead of starting fresh over it, so a stale migration can never
    replace a real archive.
  - Bytes that could not be fully parsed are copied to a backup key before anything overwrites
    them, and the copy is read back before it is trusted — a backup that did not persist would
    otherwise authorize destroying the original.
  - Backup slots are addressed by content rather than by the clock, so two payloads preserved
    in the same millisecond cannot overwrite each other and an unparseable archive is not
    re-copied on every launch.
  - Saving validates the whole candidate through the schema first and refuses when anything
    would be dropped or rebuilt on the next read, leaving the previously saved archive intact.
    Deliberately preserved unknown content is the one exception, so an archive holding data
    from a newer build stays saveable.
  - Saving never lowers a rollback floor the stored archive already declared.
  - Legacy migration reads both pre-v2 keys before deciding anything, reports damaged sources
    as damage rather than as an empty history, and never deletes the old keys as part of the
    conversion.

- 17b01f8: Add the versioned conversation archive schema that underpins durable chat history.

  Flint's pre-v2 storage kept a sidebar index of conversation titles under one key and a
  single global message thread under another, so selecting a different conversation cleared
  the thread and the next autosave wrote the empty thread over the only stored copy.

  This adds `src/lib/conversation-store.ts`, a pure schema, validation, and migration module:

  - A versioned archive with a declared `minAppVersion` rollback floor, so an older build
    refuses to write over an archive it cannot read instead of silently discarding it.
  - Normalization that preserves every message flag the chat pipeline depends on
    (`isError`, `pinned`, `condensed`, `isSummary`) plus an `extra` escape hatch, so a field
    a newer build added survives a round trip through an older one.
  - Content parts this schema does not model are kept verbatim in an opaque envelope rather
    than dropped or mistaken for renderable parts.
  - Every repair is reported rather than applied silently: dropped conversations, dropped
    messages, dropped and unrecognized parts, substituted identifiers, and rewritten header
    fields all surface so the storage layer can retain the original bytes.
  - Legacy migration imports the title-only sidebar entries, marks them as having
    unavailable turns, and imports the one real thread as a clearly labelled recovered
    conversation with an id derived from its own contents so a retried migration cannot
    create duplicates.

### Patch Changes

- 2b626f5: Pin the vulnerable `adm-zip` transitive dependency to `^0.6.0` via an npm override (GHSA-xcpc-8h2w-3j85) while keeping `foundry-local-sdk` on the 1.x line, whose `foundry-local-core/<platform>/` native layout Flint's sidecar loader and bundle verifier depend on.
- 95701f0: Reliability fixes for chat persistence, async result ownership, sidecar and service lifecycle,
  model pool safety, and macOS packaging.

  **Chat and settings no longer reset on launch.** The autosave effect ran at mount and wrote
  in-memory defaults over the saved blob before it was ever read, so every launch discarded the
  chat history and reverted settings such as the service port and autostart. Persisted state is
  now hydrated before autosave is enabled, and every writer honours that gate.

  **Storage failures are visible and non-destructive.** Unreadable or corrupt data is preserved
  under a `.corrupt` backup key and reported in a dismissible banner instead of being silently
  replaced. When the bytes cannot be preserved, saving stays disabled for the session rather than
  destroying the only copy. Lifecycle listeners are also registered before any storage work, so a
  storage error can no longer strand the app without its keyboard handler or close-to-tray hook.

  **In-flight results can no longer land in the wrong conversation.** Streaming completions,
  summarization, dictation and URL fetches identified their target by array position, so switching
  conversations or loading another model mid-flight wrote the result into an unrelated thread.
  Each now tracks the thread and message it belongs to and discards results that no longer apply.
  Concurrent URL fetches also keep the spinner accurate, and detected URLs are validated before a
  fetch chip is offered.

  **The sidecar can no longer be started twice or reported healthy after it dies.** Concurrent
  callers could each spawn a child process, and a crashed sidecar still reported ready — Retry
  returned success without re-initializing anything. Startup and initialization are now
  single-flighted and tied to a specific child, and a lost sidecar clears the endpoint and the
  model residency it owned.

  **The local service honours your settings and is no longer restarted needlessly.** Startup
  always started the service on a hardcoded port regardless of the autostart setting or the
  configured port and bind address. Separately, transcribing audio and "Ensure service" performed
  a full service restart, which evicts every loaded model and resets usage counters; they now load
  what they need into the running service. All service starts and stops are serialized, so a
  restart can no longer tear the service down underneath in-flight work.

  **Models are no longer unloaded while they are still answering.** A streamed completion through
  the local endpoint reported the model idle as soon as response headers were sent, so the idle
  and max-resident eviction rules could unload it mid-generation; the model is now held for the
  whole exchange. Loading the same model twice at once is serialized, a variant switch is refused
  while requests are in flight, and a failed unload no longer drops the model from the pool as
  though it had succeeded. Choosing "Keep loaded" while enabling a memory limit no longer evicts
  the model being pinned.

  **macOS: clicking the Dock icon restores the window again.** After close-to-tray the window is
  hidden, and nothing handled `RunEvent::Reopen`, so the app appeared to be gone.

  **macOS: added the microphone usage description**, without which the system terminates the app
  when the Audio tab starts recording, and **raised the declared minimum to macOS 14**, matching
  the bundled `libonnxruntime.dylib`. The installer now rejects older macOS with a clear message.

  **Added `npm run tauri:build:local`** for local packaging without signing credentials.

- 662172b: Preserve conversation data the schema does not fully own: messages with an unrecognized role are now kept rather than discarded, fields parked in `extra` by an older build are recovered on re-upgrade, and keys that collide with `Object.prototype` survive a round trip. Adds a typed per-conversation settings contract over the opaque settings bag, and a title policy that stops a save from renaming a conversation whose thread is not loaded, overwriting a recovery label, or discarding a user-chosen name.

## 0.5.0

### Minor Changes

- 6dac51a: Serve models on demand, so any OpenAI-compatible client works without loading a model in
  Flint first. Foundry Local only answers for a model that is already resident in memory, and
  it exposes no HTTP route to load one, so a coding agent or IDE plugin that read `/v1/models`
  and posted to a model it found there received `400 Model 'X' is not loaded` with no way to
  recover. Flint now listens on the configured port itself and forwards to the native service,
  and when that specific rejection comes back it loads the model and replays the request once.

  The proxy forwards first and inspects afterwards, so Foundry still performs all routing and
  request validation and a bad request cannot trigger a multi-gigabyte load. Only the exact
  not-loaded rejection is retried, only once, and only for a model that is already downloaded,
  so a stray or hostile identifier can never start a download. Loads are serialised and
  deduplicated, which collapses a burst of concurrent requests for the same model into one
  load. Streaming responses are passed through untouched, so tokens still arrive as they are
  produced, including on the replayed request.

  Requests naming a model by its friendly alias now work. Foundry routes variant ids but
  rejects the alias outright, answering "is not loaded" even while that exact model is
  resident, and the alias is the form Flint's own integration snippets tell users to
  configure. The proxy now replays under the variant id the loader actually chose, and
  remembers the mapping so later requests are rewritten before they are sent rather than
  paying the rejection every time.

  This also fixes service start, which failed with `Foundry Local Core is already initialized`
  every time it ran after initialization. The native core can only be initialized once per
  process, so the manager can never be re-created to change its port; Flint now takes the
  port the service reports and proxies the configured port to it. As a result the configured
  port and bind address are honoured for the first time.

- 6dac51a: Add BYOM (bring your own model) import so Flint can run ONNX models that are not in the
  Foundry catalog. `inspectModelFolder` validates a folder and explains why it is unusable
  (GGUF, missing tokenizer, incomplete download, weights that `genai_config.json` does not
  point at) before anything is copied. `importModelFolder` stages the copy, authors the
  Foundry-specific `inference_model.json` — which almost no public ONNX repo ships — picks a
  prompt template from the model's own chat template, then activates it with a single atomic
  rename and removes the staging directory on any failure. `linkModelFolder` registers a
  model that lives elsewhere through a directory junction, so a second copy of a multi-gigabyte
  model is unnecessary and the source folder is never written to.

  The prompt template is now visible and editable rather than an invisible guess. Inspecting a
  folder returns the template Flint would use plus the known presets (ChatML, Llama 3, Phi-3,
  Gemma), `importModelFolder` accepts a `promptTemplate` that overrides detection, and
  `getModelTemplate` / `setModelTemplate` read and rewrite the template of an already-imported
  model. Templates are validated before they are written — every turn must be present and the
  `{Content}` placeholder must appear, because a malformed template does not fail loudly but
  silently drops message text. Rewrites are refused for catalog and linked models, whose files
  Flint does not own. Models are added from the Models tab: a folder picker validates the
  folder, shows what was detected, lets the prompt template be reviewed and edited before
  anything is copied, then either copies the folder into Flint's cache or links it in place.
  The template of an already-imported model can be reopened and changed from its card.
  The model list can be sorted by name, family, or last updated.

- 9c45fbc: Warn before the machine runs out of memory, and give the model pool a way to bound itself.

  A memory watchdog now samples system RAM and per-GPU VRAM regardless of which tab is open,
  raises an in-app banner and a native OS notification when usage stays high, and clears itself
  once usage drops back below the threshold with hysteresis. RAM and VRAM have separate limits
  because a GPU legitimately runs near capacity during inference. The sustain window is measured
  in elapsed time rather than samples, since polling slows down in the background, and a gap in
  sampling — a suspended laptop, a throttled webview — or an edited threshold restarts the window
  instead of firing immediately on stale history. Because the underlying telemetry is system-wide
  rather than Flint's own footprint, alerts only appear while Flint actually has models resident
  and the wording never claims the memory is Flint's. Alerts can be dismissed per device, the
  thresholds and sustain window are adjustable, and the whole watchdog can be turned off.

  The model pool can now evict. Two independent rules, both off by default, unload models after
  an idle timeout or keep at most N resident, evicting least-recently-used first. Models can be
  marked `pinned` so they are never unloaded — including while idle-unload is on — or `low` so
  they are given up first. A model is never evicted while a request is in flight, including
  requests arriving through the OpenAI-compatible gateway, which the pool previously could not
  see. When the cap is in force, room is freed before a new load commits memory rather than
  after. Idle time and priority are shown per model in the pool table.

- 9c45fbc: Keep the local service running when the window is closed.

  The inference service lives in Flint's sidecar process, so quitting the app always killed the
  endpoint that external tools were pointed at. Now, while the service is running, closing the
  window hides Flint to the system tray instead of quitting — the endpoint stays available, a
  one-time notification says so, and the tray menu offers "Open Flint" and "Stop service and
  quit" (which stops the service gracefully before exiting). The behavior is controlled by a new
  "Keep service running in background" toggle in Settings → System (on by default), only kicks in
  while the service is actually running, and falls back to a normal quit if the tray cannot be
  created so a hidden window can never be stranded.

- 9c45fbc: Fix macOS releases, reach Flint from WSL, and rename Compare to Model Arena.

  macOS builds no longer ship broken. The release workflow now signs and notarizes the app
  automatically when Apple Developer secrets are present, and otherwise builds unsigned with a
  loud warning instead of failing — a half-configured state (certificate without notarization
  credentials) still fails, because that app would be blocked anyway. Since unsigned browser
  downloads are quarantined and reported as "damaged" by Gatekeeper, a new curl-based installer
  (`scripts/install-macos.sh`) installs the latest release without any Gatekeeper interaction,
  and the docs cover the `xattr -cr` fix for DMG installs. The mac app icon is also finally the
  Flint logo — `icon.icns` had shipped the default template icon since the initial check-in.

  Tools running inside WSL2 (OpenClaw, OpenCode, …) can't reach `127.0.0.1` on the host in WSL's
  default NAT mode. A new Settings → Network → WSL clients section detects WSL and enables
  mirrored networking with one click: it writes `networkingMode=mirrored` into `.wslconfig`
  (backing up the original, preserving everything else in the file), and offers a confirmed
  `wsl --shutdown` to apply. Mirrored mode keeps Flint on the recommended loopback-only bind and
  keeps gateway autoload working for WSL callers. A manual NAT walkthrough (host IP, `0.0.0.0`
  bind, scoped firewall rule, no-autoload caveat) is included for those who prefer it.

  The Compare tab is now **Model Arena** — page, sidebar, status messages, markdown export, help,
  and docs. The keyboard shortcuts dialog also gains the previously undocumented Ctrl/⌘+6 entry.
  Saved runs carry over unchanged.

  Also: a Linux build plan landed in `docs/LINUX_BUILD_PLAN.md`.

## 0.4.5

### Patch Changes

- 7dc6efb: Fix the auto-updater never finding a new version. The endpoint resolved to the manifest attached to the release the user was already running, so every client reported "up to date"; it now points at the floating latest-release URL.
- 7dc6efb: Harden release packaging and audio input. `verify:bundle` now understands `--target` builds (it previously inspected only `target/release`, so every check silently passed on the builds that ship) and gains `--require-build`; it and `smoke:node` now run in CI and at release. Non-WAV uploads are rejected by magic-byte sniffing before a model loads, instead of failing inside the native decoder. Coverage now includes the sidecar and runtime-path modules at 88/72.

## 0.4.4

### Patch Changes

- 6cf3df6: Fix `Sidecar init failed: require is not defined` on packaged builds. The SDK fallback loader used CommonJS `require` inside the ESM sidecar, so installed apps could never load `foundry-local-sdk` from bundled resources. Added a regression test that runs the sidecar against a simulated installer layout.

## 0.4.3

### Patch Changes

- c86ce50: Surface the real Azure Trusted Signing failure instead of Tauri's opaque `failed to run pwsh`. The sign command now logs detailed errors to `src-tauri/target/flint-signing.log`, and the release workflow runs a signing preflight check and publishes the log.

## 0.4.2

### Patch Changes

- 9496298: Fix Azure OIDC-based Windows signing by pinning the release job to the stable GitHub environment `release`, preflighting the OIDC subject, and supporting stable-branch rebuilds of existing tags.

## 0.4.1

### Patch Changes

- 5fdf366: Integrate Windows release code signing with Azure Trusted Signing private trust.
- e8a7c81: Fix release workflow failing on non-strict-semver tags (e.g. `v0.4-mvp`) by normalizing a missing patch component to `0` before validating and syncing the version across `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
- a6a7e51: Add mocked Pester coverage for the Azure Trusted Signing invocation path.

## 0.4.0

### Minor Changes

- 814c3af: Bundle Node 22 for the Foundry JS sidecar in release builds (Tauri externalBin; PATH Node remains a dev fallback). Ship Help/first-run coach, empty-state CTAs, and About strip. Document optional control CLI as non-goal for 0.4; regenerate package-lock for npm ci on Node 22.

## 0.3.4

### Patch Changes

- 631a81f: Remove unsupported x86_64-apple-darwin (Intel macOS) target from the release build matrix. Foundry Local SDK does not publish native cores for darwin-x64, which caused the release build to fail intentionally rather than ship a broken sidecar.

## 0.3.3

### Patch Changes

- f16d761: 0.3.2: package Foundry natives in installers as Flint.exe, fix production sidecar resolution and service rebind on network Apply & restart, and confirm non-loopback bind settings.

## 0.3.1

### Patch Changes

- c413a91: Add acceleration-aware notifications for newer downloaded model variants.
- 724eecf: Fix release build failure by using platform-specific bundle targets (msi/nsis on Windows, dmg/app on macOS) and enabling updater artifacts via `createUpdaterArtifacts` in the Tauri config.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are normally produced via [Changesets](https://github.com/changesets/changesets) (`npm run changeset` → Version Packages PR).

## [Unreleased]

### Added

- (Changesets will populate entries here when Version Packages PRs are merged.)

## [0.3.0]

### Added

- **Model pool** — concurrent multi-model load with variant-ID HTTP routing; pool visible in Monitor.
- **Monitor** — live pool table, resource gauges, access log, audit export (CSV/JSON).
- **Access log + audit trail** — ring buffer + `~/.flint/logs/` rotation; audit entries for destructive/config sidecar commands.
- **Network config** — configurable bind address and port in Settings (loopback default; warning for non-loopback).
- **Keyboard shortcuts** — view navigation, new chat, send, push-to-talk, `?` reference panel.
- **Autostart + defaults** — OS login-item toggle; default chat/audio model pre-selection.
- **Vision** — multi-image attach (up to 4), thumbnails, paste and drag-and-drop.
- **Model comparison** — side-by-side bake-off, ratings, markdown export.
- **Model update notifications** — detect newer catalog versions for each downloaded acceleration-specific variant and provide a direct update download.
- **Integrations** — data-driven OpenAI-compatible tool snippets with OS toggle and copy.
- **Host-aware chat context** — compact identity every turn; expanded fact sheet when the user asks about Flint/Foundry.
- **Guarded web-fetch → chat context** — user-initiated URL fetch with SSRF/size limits and article extraction.
- **Purview governance memo** — design-only (`docs/PURVIEW_GOVERNANCE.md`).
- **Release pipeline scaffolding** — updater plugin hooks, signing workflow steps (self-signed bootstrap).
- **Node.js preflight** — check Node 22+ on PATH before starting the JS sidecar (security-supported floor); actionable install guidance when missing or too old.
- **Docs consolidation** — living docs index, DEVELOPMENT/RELEASE guides, archived historical plans, backlog for deferred items.

### Changed

- README and design spec aligned to 0.3 status; honest prerequisites (bundled Foundry runtime; Node required for sidecar).

### Notes

- Version was bumped to 0.3.0 across package manifests; this section records shipped scope for the tag. Updater pubkey and code-signing secrets remain release-operator steps (see `docs/RELEASE.md` and `RELEASE_ROADMAP.md`).

## [0.2.0]

### Minor Changes

- Setup Changesets for PR-driven versioning. New pull requests must now include a changeset (via `npm run changeset`) so that they drive the next app version bump across `package.json`, `tauri.conf.json`, and `Cargo.toml`. Added sync script, CI enforcement, and GitHub Action to manage Version Packages PRs.

## [0.1.0] - Initial

- Initial Flint MVP.
