# Backlog

Open work only. Completed items are deleted, not archived — `git log` and `CHANGELOG.md`
hold the history. Durable facts belong in
[`.github/copilot-instructions.md`](../.github/copilot-instructions.md), not here.

Verify an item against the tree before acting on it.

## Current execution priorities

The [reliability execution plan](./PRODUCT_PLAN.md) owns the review findings,
implementation dependencies, and acceptance gates. Fix data loss and runtime
correctness without waiting for a backend rewrite. Expedite thin native
lifecycle/process supervision; defer wholesale Foundry runtime replacement.

**Linux work is deferred:** preserve existing checks and mappings. Continue
Linux-specific work only where it is already part of another feature; shared
Windows/macOS fixes do not establish Linux release support.

## Shipping integrity

- [ ] **Clean-machine dogfood** — install the signed build where no Node, Rust, or prior
      Foundry exists; confirm first run downloads and loads a model.
- [ ] **Boot smoke on the real installer** — CI checks bundle contents but never installs
      the MSI/NSIS and launches. Decide: drive the installer on a Windows runner, or keep
      the cheaper staged-layout test.
- [ ] **macOS unverified** — DMG/app build and upload; nobody has confirmed an installed
      macOS build boots. Dogfood it or declare macOS unsupported.

## Updater

- [ ] **Publishing is manual** — the workflow leaves a draft, and drafts/pre-releases are
      invisible to `releases/latest`. Automate publishing or keep it a checklist step.
- [ ] **No update-failure surface** — if the updater can't reach the endpoint the user
      sees nothing. Show last-checked time and last error.

## Audio

- [ ] **Convert instead of rejecting** — non-WAV uploads are now rejected with a clear
      error; transcoding WebM/Opus and MP3 to 16 kHz mono PCM would be better. Needs a
      decoder that doesn't bloat the bundle.
- [ ] **Word-level timestamps** — blocked upstream
      ([microsoft/Foundry-Local#392](https://github.com/microsoft/Foundry-Local/issues/392),
      open). Revisit when granularity lands; `parakeet-tdt-0.6b-v2` is already in the
      catalog and produces word timings natively.

## Test coverage

- [ ] **`+page.svelte` is untested** and holds most of the app (~444 KB, `@ts-nocheck`).
      Keep extracting pure logic into `src/lib/*.ts` with tests rather than testing the
      component.
- [ ] **No Rust tests** — `cargo check` is the only gate on `src-tauri`.

## Runtime strategy

- [ ] **Thin Rust supervisor** — expedite native tray/reopen/quit, single-instance
      behavior, and exclusive runtime-child ownership after the remaining service
      lifecycle contracts are stable. The versioned transport and readiness
      contracts are now delivered; see
      [PRODUCT_PLAN](./PRODUCT_PLAN.md#workstream-c-thin-native-ownership----expedited).
- [ ] **Rust runtime replacement** — deferred pending parity and measured benefit.
      Preserve one model-manager authority and separate-process crash isolation;
      do not keep competing JS/Rust runtimes or replay uncertain operations.
- [ ] **1.0: no end-user Node** — bundled Node 22 already removes the user-visible
      requirement; this is about shrinking the spawn/attack surface.
- [ ] **Pin the SDK/core/CLI matrix** — Flint is on SDK 1.2.4; Foundry's REST API is
      preview. Warn at startup on untested combinations instead of failing obscurely.

## Models and cache (see [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md), "Plan: current → 1.0")

- [x] **BYOM import from a local folder** — inspect, validate, stage, atomically activate,
      roll back. Prompt template is shown and editable at import and afterwards.
- [x] **Additional model folders via directory junctions** — `linkModelFolder`. Never
      writes to the foreign folder; delete the link, never the target.
- [x] **Sort the model list** — name, family, or last updated; persisted.
- [x] **Read-only cache inventory** — duplicates, partial downloads, and reclaimable byte totals.
      Recommendations only; no cross-root deletion. Measured on the maintainer's machine:
      `~/.flint` 107 GB / 35 models vs `~/.foundry` 31.4 GB / 7 models, 15.3 GB duplicated.
      Duplicate grouping uses already-cached catalog metadata when available; otherwise entries
      remain variant-scoped. Inaccessible paths are reported as an incomplete scan rather than
      as zero-byte success.
- [x] **Auto-load on demand** — Flint's reverse proxy owns the configured port, forwards to
      the native service, and on the exact `400 ... is not loaded` loads the model and
      replays the request once. Cached models only, so a stray id cannot start a download.
      Also fixed service start, which always failed with `Core is already initialized`.
- [ ] **Throughput metrics** — load time, TTFT, prompt tok/s, decode tok/s, end-to-end,
      warm/cold, resolved variant + execution provider. Sidecar IPC chat access logs now
      record these fields when observable and use null for buffered/unavailable timing;
      gateway and other inference paths remain open. No single ambiguous "tokens/sec".

## Endpoint / agent compatibility (see [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md), "Plan: current → 1.0")

- [ ] **Behavioural conformance self-test** — not route-existence checks. Gateway
      behavioral coverage now verifies status rewriting, model routing/autoload
      replay, normalized JSON/SSE chat responses, and `[DONE]`; a user-facing
      diagnostic self-test remains open.
- [ ] **Normalise response shape** — gateway chat JSON and SSE responses remove
      Foundry-only fields and emit one OpenAI-shaped message or delta choice when
      JSON is within the bounded normalization threshold; larger JSON responses
      remain byte-preserving pass-through. Broader endpoint capability conformance
      remains open.
- [ ] **`/v1/embeddings` end-to-end** — route exists, but the catalog has zero embedding
      models, so this depends on BYOM.
- [ ] **Surface `supportsToolCalling` / `contextLength`**, labelled catalog-declared vs
      Flint-verified.
- [ ] **Verified recipes** for OpenClaw, Cline, Continue, pinned to tested versions.

## Dependencies

- [ ] **`foundry-local-sdk` postinstall downloads a native binary at install time** — every
      `npm ci`, including every CI job, fetches `Microsoft.AI.Foundry.Local.Core` from
      `api.nuget.org` and falls back to an Azure DevOps feed that returns **401**. So there is
      no working fallback: a hiccup at nuget.org fails the whole matrix. Observed on
      joelst/flint#38, where the same commit passed and then failed minutes later. Consider
      caching `node_modules`/the native payload in CI, or vendoring the binary.
- [ ] **macOS quarantines the SDK's ad-hoc-signed dylib** — see docs/DEVELOPMENT.md. Not
      fixable here (Microsoft would need to notarize it); revisit when the SDK pin moves.
- [ ] **`adm-zip` advisory is transitive via `foundry-local-sdk`** — not fixable without
      an SDK bump. `glib` is Linux/GTK-only and Flint ships Windows + macOS; `cookie` is
      already patched. Re-check when the SDK pin moves.

## Operation outcomes

- [ ] **Text Compare aborts on an ordinary service-start failure, which is a policy choice
      rather than a technical requirement.** The sidecar can serve text Compare through direct
      SDK inference with no HTTP endpoint, so a run could in principle proceed without the web
      service. Compare currently requires the endpoint for every slot because that is the path
      it shares with the rest of the app; relaxing it would mean a second inference path to keep
      correct. Revisit if endpoint startup proves to be a common failure in practice.

## Conversation persistence

- [ ] **Native quit does not reach the frontend flush.** Conversation saves are retried on a
      backoff that never gives up, and flushed on hide/blur/pagehide and on the close-requested
      handler, so a recovered storage failure is retried without waiting for the next edit. Those
      hooks are best-effort opportunities rather than guaranteed delivery. What is still missing is
      a deterministic handshake: on macOS neither Cmd+Q nor Dock → Quit reliably invokes the
      frontend (tauri-apps/tauri#9198), so a quit in the window between storage recovering and
      the next retry can still drop the outstanding turns. Closing it needs a native
      `ExitRequested` → frontend flush → acknowledgement round trip, which is Rust work rather
      than a frontend fix.
- [ ] **The settings baseline cannot be edited.** Per-conversation settings now apply, resolved
      against an application baseline held in `appSettingDefaults`. That baseline is deliberately
      stable — an in-chat change belongs to the chat, and moving the baseline underneath every
      conversation that inherits from it is a different operation — but there is no control that
      performs that different operation. Persona, context length and thread view are therefore
      frozen at whatever was persisted before the upgrade: the projection that writes the
      settings blob deliberately does not emit them from the live chat.

      The model alias is the exception, and intentionally so. It is read back from
      `selectedModelAlias`, the application's pre-existing "last model used" value, which drives
      startup prewarming and is what a rolled-back build would chat with. The component still
      writes it on every model switch, so the alias part of the baseline does move between
      sessions. That is the right trade: an inheriting conversation should open with a model that
      works, and unlike a persona an alias does not carry the previous chat's character. Only
      conversations created before this feature inherit at all, since new ones are stamped
      explicitly. Closing this means a "defaults for new chats" control in Settings.
- [ ] **Switching conversations discards the rest of an in-flight generation.** The epoch guard
      rejects deltas after the thread is replaced, so the archive keeps the partial answer.
      Pre-existing behaviour, not introduced by the archive work. Fixing it means routing
      streamed updates by originating conversation id rather than by "is this still the visible
      thread".
- [ ] **The export cannot always prove where it landed.** `classifyDestination` refuses an
      application-data destination by comparing filesystem identity, and detects a symlinked
      ancestor by disagreement between `stat` and `lstat`. It cannot see aliasing that leaves no
      link — a bind mount, or a hard-linked directory — and Windows reports no `dev`/`ino` through
      the pinned `plugin-fs`, so the whole check degrades to "unverified" there. The Save dialog
      also grants the chosen file rather than its ancestors, so an ordinary Downloads export is
      expected to report unverified. The file is written either way and the uncertainty is stated
      rather than hidden. Closing this means a native resolver that canonicalises the path.
- [ ] **Storage inventory is assessed once per launch.** `storageInventoryUnknown` is computed
      when conversations load and stays set for the session, so a warning survives storage
      recovering underneath it. Closing this means re-taking the inventory after a later
      successful enumeration.

## Future features (unscheduled)

Not yet started; no version assigned. Depend on Phase 1B/2 reliability work landing
first per [PRODUCT_PLAN.md](./PRODUCT_PLAN.md) — these are not reliability work.

- [ ] **Tool-calling execution layer** — opt-in, user-confirmed execution of a limited
      tool allowlist inside Flint (shell/file/HTTP), with a visible audit trail and a
      prompt-injection heuristic scan before execution. **Decision: delegate autonomous
      multi-step agent loops to purpose-built tools (OpenClaw, Scout, etc.) rather than
      building a Flint-native agent runtime** — duplicating loop/sandbox/permission
      logic is a worse version of what those tools already do, and every unconfirmed
      step is attack surface Flint's local-first posture makes riskier, not safer. The
      narrow exception worth revisiting: a 2–3 step user-confirmed linear chain ("run
      prompt A → pipe into prompt B → show result"), which is not an autonomous loop.
- [ ] **RAG (local file indexing)** — extend the existing `fetchUrl` fetch → sanitize →
      inject-as-context pipeline from single-URL to an indexed local knowledge base
      (embedded vector store). Show retrieved chunks and sources in the UI, following
      the URL-fetch chip precedent. Needs an embedding model — the Foundry catalog ships
      zero; see the `/v1/embeddings` item above.
- [ ] **Workspace export/import** — bundle selected models, endpoint profiles, personas,
      conversation history, and settings for backup or migration. Exclude credentials;
      require re-entry on import.
- [ ] **Azure AI Foundry cloud connections** — endpoint profiles (name/type/base
      URL/auth/routing role) alongside local models in the same session. Secure local
      credential storage (OS keychain) — never localStorage or plaintext disk.
- [ ] **Enterprise controls** — per-model/per-endpoint allow/deny rules, optional local
      API key requirement, an IT-deployable machine-level policy file, and the Purview
      SDK implementation (design memo already done: [PURVIEW_GOVERNANCE.md](./PURVIEW_GOVERNANCE.md)).
- [ ] **Full endpoint scheduler** — sticky routing, fallback, and health-check-based
      failover; escalate chat from local to a cloud endpoint when a prompt exceeds local
      context length.
- [ ] **Vision polish** — inline image preview thumbnails inside chat message bubbles
      (multi-image attach already works; bubble display was deferred).
- [ ] **In-app update UX** — a "Check for updates" action calling the already-wired
      updater plugin (`check()`, `downloadAndInstall()`), plus a release-notes modal.

## Control CLI — not planned

Foundry owns terminal-first `foundry model` / `run` / `server`. Flint's wedge is SDK
catalog + GUI + OpenAI endpoint + Integrations. Non-goals: shadowing the `foundry` CLI,
cloning Ollama's `pull`/`run` REPL, any CLI before the desktop app is solid.

- [ ] Revisit only if automation demand proves real, as a thin wrapper mapping 1:1 to
      existing sidecar commands with no CLI-only logic.

## Docs

- [ ] **Optional** root `CONTRIBUTING.md`; CI markdown link check.
