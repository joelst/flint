# Flint Changelog

## 0.7.0

### Minor Changes

- 80adecf: Export conversations to a file, and warn when stored data is at risk.
- 9584bd5: Conversations now keep their own messages, so switching chats no longer discards history.
- 321da3d: Enforce one native Flint instance and restore the existing window when a second launch is attempted.
- d37def1: Each conversation now remembers its own model, persona, context length and thread view, and says so when its model is not installed.
- ce85e91: Report interrupted local-service and model operations honestly, and never repeat one whose outcome is unknown.

### Patch Changes

- e68d99a: Bound webpage fetch duration and response memory use.
- f1711a7: Bound gateway control-response buffering without limiting streamed inference.
- 9f3808e: Prevent read-only runtime queries from waiting indefinitely for a sidecar reply.
- 8d43a5d: Prevent stalled native readiness probes from exceeding the startup deadline.
- 4fddec9: Bound runtime HTTP error diagnostics so stalled or oversized bodies cannot block the app.
- 9b42e3e: Keep sidecar disk logging asynchronous and bounded, with seven-day retention and graceful shutdown flushing.
- aadd424: Expose independent runtime, service, and model readiness states to improve lifecycle reporting.
- e08052a: Show catalog-declared context length and tool-calling support in model details.
- 7db9bda: Record truthful chat inference timing, usage rates, model identity, and warm/cold state in sidecar diagnostics.
- fe400fd: Preserve catalog state when STT refreshes fail and report runtime log-level changes that require a restart.
- 85003af: Surface model catalog refresh failures instead of silently keeping stale model state.
- 66976f7: Reject audio when browser WAV normalization fails instead of sending non-WAV bytes to the strict transcription decoder.
- 68d9f4c: Prevent queued service starts from reviving the endpoint after a Stop request.
- 63dd5a9: Remove an unused import of `ARCHIVE_BACKUP_KEY` from the main page component.
- 0785b70: Normalize gateway chat JSON/SSE responses for OpenAI-compatible clients and cover the behavior with a compatibility harness.
- 8ce9f7e: Apply saved runtime policy and accelerator setup before starting services or preloading models.
- fb8e52b: Move sidecar process ownership and JSON-lines transport into the native supervisor.
- 5915421: Bound write queue backpressure and aggregate payload bytes, prune settled queue items, and add unit tests for native runtime manager.
- c385607: Normalize Foundry chat responses and make SDK/HTTP transport capabilities explicit.
- f94f4ee: Fix image requests, which never reached the model.
- 81127aa: Leave the local service stopped when applying network or accelerator settings fails.
- b97f536: Patch transitive js-yaml advisories and update Vitest within the 4.1 release line.
- f24cc38: Show when downloads or accelerator setup stop reporting progress without cancelling the operation.
- 3de8be2: Keep service status unknown when stopping loses contact with the runtime.
- c23d46b: Report the configured public bind address in service endpoints and status responses.
- 3dce9c8: Add a read-only model cache inventory showing partial downloads and duplicate cached aliases.
- 8553ee3: Separate HTTP stop, drain-and-unload, and confirmed runtime quit behavior.
- 837178d: Add a generation-tagged native child handle for explicit sidecar exit and termination observation.
- 3614739: Add a tested native runtime generation state model for safe sidecar lifecycle ownership.
- 76bbe23: Add a tested native supervisor coordinator for one generation-tagged runtime child.
- 1fce32e: Add bounded Rust JSON-lines transport framing for the future native supervisor.
- 2a256ad: Show update availability and updater errors in About instead of hiding failed checks.
- e89e0e9: Avoid restarting a healthy local service when the app only needs to ensure it is running.
- dc087ab: Version the sidecar handshake and ignore replies from superseded runtime processes.
- f9a208b: Keep compatible startup models available when only some hardware accelerators register.
- fce1ff1: Stop advertising a previous service endpoint after a failed or uncertain lifecycle transition.
- b4640d0: Add an automated release metadata check for synchronized versions and updater configuration.
- 86027c4: Keep runtime readiness state available to the main application view.

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

## Earlier releases (0.1.0 – 0.5.0)

Detailed per-release entries above only go back to 0.6.0, where Changesets began
authoring this file automatically. Earlier releases are summarized here at a
high level; for full commit-level detail see `git log` (tags exist only from
`v0.4.0-alpha` onward — earlier versions predate tagging).

- **0.5.0** — BYOM import + linked model folders, gateway auto-load-on-demand
  (closes the "model not loaded" agent-compat gap), memory watchdog + pool
  eviction, keep-service-running-in-tray, WSL mirrored networking, Compare
  renamed to Model Arena, macOS signing/notarization and icon fixes.
- **0.4.x** — Bundled Node 22 runtime for the sidecar, Help/first-run coach,
  signed Windows releases via Azure Trusted Signing, macOS build fixes, working
  auto-updater endpoint.
- **0.3.x** — Model pool, Monitor view (resources, access log, audit trail),
  network bind config, keyboard shortcuts, autostart, vision multi-image,
  Model Arena (as "Compare"), Integrations tab, Purview governance memo,
  Changesets-based versioning.
- **0.2.0** — Security hardening (sidecar schema/allowlist, least-privilege
  shell capability), chat/audio lane routing, realtime voice dictation.
- **0.1.0** — MVP baseline: model catalog, streaming chat, audio
  transcription, diagnostics.
