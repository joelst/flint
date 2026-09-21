# Backlog

Open work only. Completed items are deleted, not archived — `git log` and `CHANGELOG.md`
hold the history. Durable facts belong in
[`.github/copilot-instructions.md`](../.github/copilot-instructions.md), not here.

Verify an item against the tree before acting on it.

**1.0 sequenced work lives in [PRODUCT_PLAN.md](./PRODUCT_PLAN.md)** against the bar in
[RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md). This file is deferred and post-1.0 only.
Do not add 1.0 work here; that duplicates the plan and the two will drift.

## Current execution priorities

Follow the 1.0 waves in [PRODUCT_PLAN.md](./PRODUCT_PLAN.md). Waves 1–9 land as
**0.9.0**, the first stable, so the updater can be proven from 0.7.0 evaluation.
Remaining process after that: 0.9.0 upgrade dogfood, bugfixes, packaged Windows
dogfood, integration version pins, then **1.0.0**. Defer wholesale Foundry
runtime replacement.

**Linux work is deferred:** preserve existing checks and mappings. Continue
Linux-specific work only where it is already part of another feature; shared
Windows/macOS fixes do not establish Linux release support. 1.0 production is
Windows; macOS Apple Silicon is evaluation-only.

## Audio

- [ ] **Convert instead of rejecting** — the browser now transcodes formats its audio
      decoder supports to 16 kHz mono PCM WAV and rejects conversion failures without
      sending invalid bytes; broader WebM/Opus and MP3 coverage still needs a decoder
      that doesn't bloat the bundle. Not a 1.0 blocker; document supported formats
      in the operator runbook / USER_GUIDE as part of 1.0 docs.
- [ ] **Word-level timestamps** — blocked upstream
      ([microsoft/Foundry-Local#392](https://github.com/microsoft/Foundry-Local/issues/392),
      open). Revisit when granularity lands; `parakeet-tdt-0.6b-v2` is already in the
      catalog and produces word timings natively.

## Test coverage (ongoing)

These are engineering hygiene, not the 1.0 testing criterion (that bar is unit +
contract + sidecar E2E + packaged Windows smoke in PRODUCT_PLAN Wave 7).

- [ ] **`+page.svelte` is untested** and holds most of the app (`@ts-nocheck`). Keep
      extracting pure logic into `src/lib/*.ts` with tests rather than testing the
      component. The line count is the progress measure for that extraction — keep
      it current.
- [ ] **No component-test layer** — `@testing-library/svelte` is a dependency; no
      `*.svelte` tests exercise UI. Out of the 1.0 bar.
- [ ] **Coverage allowlist blind spots** — `vite.config.js` measures an allowlist of
      43 files at 97/94/84/95, deliberately set just under actual so regressions fail.
      Outside the allowlist: `src/lib/sdk.ts` and `sidecar/foundry-sidecar.js`, both
      core paths. Add them as they gain tests rather than widening the allowlist and
      dropping the thresholds to accommodate them.

## Runtime strategy

- [ ] **Rust runtime replacement** — deferred pending parity and measured benefit.
      Preserve one model-manager authority and separate-process crash isolation;
      do not keep competing JS/Rust runtimes or replay uncertain operations. Gate:
      [PRODUCT_PLAN.md](./PRODUCT_PLAN.md)#gate-for-reconsidering-a-rust-runtime-replacement.
- [ ] **Shrink the bundled-Node spawn surface** — packaged builds already ship Node
      22, so end users do not install Node. Remaining work is attack-surface
      reduction, not restoring a user-visible Node requirement.

## Endpoint / agent compatibility (post-1.0)

1.0 integrations are chat-completion recipes plus the behavioral self-test
(PRODUCT_PLAN Wave 5). The items below stay open after that.

- [ ] **Broader response-shape conformance** — gateway chat JSON and SSE already
      remove Foundry-only fields and emit one OpenAI-shaped message or delta choice
      when JSON is within the bounded normalization threshold; larger JSON responses
      remain byte-preserving pass-through. Broader endpoint capability conformance
      remains open.
- [ ] **Recorded BYOM embedding recipe** — gateway autoload and `embedTexts` ship
      in 0.9.0 (PRODUCT_PLAN Wave 9). Catalog still has zero embedding models. A
      Flint-tested onnxruntime-genai embedding folder (repo, revision, dimension,
      core pin) is still required before Continue's indexer can be marked verified.

## Dependencies

- [ ] **macOS quarantines the SDK's ad-hoc-signed dylib** — see docs/DEVELOPMENT.md.
      Not fixable here (Microsoft would need to notarize it); revisit when the SDK
      pin moves. Separate from Flint.app signing, which is a post-1.0 calendar item.
- [ ] **`adm-zip` advisory is transitive via `foundry-local-sdk`** — not fixable
      without an SDK bump. `glib` is Linux/GTK-only and Flint ships Windows + macOS;
      `cookie` is already patched. Re-check when the SDK pin moves.

CI caching of the Foundry native payload (nuget.org; Azure DevOps fallback 401) is
PRODUCT_PLAN Wave 1, not deferred.

## Operation outcomes

- [ ] **Text Compare aborts on an ordinary service-start failure, which is a policy
      choice rather than a technical requirement.** The sidecar can serve text Compare
      through direct SDK inference with no HTTP endpoint, so a run could in principle
      proceed without the web service. Compare currently requires the endpoint for
      every slot because that is the path it shares with the rest of the app;
      relaxing it would mean a second inference path to keep correct. Revisit if
      endpoint startup proves to be a common failure in practice.

- [ ] **`setBenchmarkExclusive(false)` has no way to reject a stale release.** The client
      (`pendingExclusiveRelease` in `+page.svelte`) now tracks every outstanding release call
      (not just the newest) so a later run's acquire correctly waits for all of them, but the
      `join()` calls that guard remain unbounded — if a dispatched release call's IPC promise
      never settles (sidecar wedged without crashing, so `drainPending` never fires), a later
      Start/Resume can block forever. A sidecar-side generation/lease token — acquire returns a
      generation id, release must supply it, and a release for a superseded generation is a
      safe no-op — would let the client bound every wait without needing perfect client-side
      promise tracking at all, since a stale release could never clear a newer acquire's flag.
      Bigger change (new payload field in three schema locations plus client plumbing); revisit
      if the current client-side tracking proves fragile in practice.

## Conversation persistence (post-1.0)

Quit-flush and conversation-id stream routing are PRODUCT_PLAN Wave 2.

- [ ] **The settings baseline cannot be edited.** Per-conversation settings now apply,
      resolved against an application baseline held in `appSettingDefaults`. That
      baseline is deliberately stable — an in-chat change belongs to the chat, and
      moving the baseline underneath every conversation that inherits from it is a
      different operation — but there is no control that performs that different
      operation. Persona, context length and thread view are therefore frozen at
      whatever was persisted before the upgrade: the projection that writes the
      settings blob deliberately does not emit them from the live chat.

      The model alias is the exception, and intentionally so. It is read back from
      `selectedModelAlias`, the application's pre-existing "last model used" value,
      which drives startup prewarming and is what a rolled-back build would chat
      with. The component still writes it on every model switch, so the alias part
      of the baseline does move between sessions. That is the right trade: an
      inheriting conversation should open with a model that works, and unlike a
      persona an alias does not carry the previous chat's character. Only
      conversations created before this feature inherit at all, since new ones are
      stamped explicitly. Closing this means a "defaults for new chats" control in
      Settings.
- [ ] **The export cannot always prove where it landed.** `classifyDestination`
      refuses an application-data destination by comparing filesystem identity, and
      detects a symlinked ancestor by disagreement between `stat` and `lstat`. It
      cannot see aliasing that leaves no link — a bind mount, or a hard-linked
      directory — and Windows reports no `dev`/`ino` through the pinned `plugin-fs`,
      so the whole check degrades to "unverified" there. The Save dialog also grants
      the chosen file rather than its ancestors, so an ordinary Downloads export is
      expected to report unverified. The file is written either way and the
      uncertainty is stated rather than hidden. Closing this means a native resolver
      that canonicalises the path.
- [ ] **Storage inventory is assessed once per launch.** `storageInventoryUnknown` is
      computed when conversations load and stays set for the session, so a warning
      survives storage recovering underneath it. Closing this means re-taking the
      inventory after a later successful enumeration.

## Future features (unscheduled)

Not yet started; no version assigned. Depend on the 1.0 reliability bar landing
first per [PRODUCT_PLAN.md](./PRODUCT_PLAN.md) — these are not 1.0 work.

- [ ] **Apple Developer ID + notarization** — 1.0 macOS stays evaluation-only.
      Signing Flint.app does not un-quarantine the SDK dylib. Budget the paid
      Developer ID and dogfood Gatekeeper-clean installs only as a post-1.0
      calendar item.
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
      context length. Explicitly **not** a 1.0 requirement (the 1.0 bar is one local
      endpoint).
- [ ] **Vision polish** — inline image preview thumbnails inside chat message bubbles
      (multi-image attach already works; bubble display was deferred).
- [ ] **Curated ONNX catalog** — Flint-validated imports (pinned repo/revision, tested
      EP, required files). See [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) "After 1.0".

In-app updater **install** UX (progress/restart/defer) is PRODUCT_PLAN Wave 8, not
unscheduled. The availability/error/check-time action is already delivered.

## Control CLI — not planned

Foundry owns terminal-first `foundry model` / `run` / `server`. Flint's wedge is SDK
catalog + GUI + OpenAI endpoint + Integrations. Non-goals: shadowing the `foundry` CLI,
cloning Ollama's `pull`/`run` REPL, any CLI before the desktop app is solid.

- [ ] Revisit only if automation demand proves real, as a thin wrapper mapping 1:1 to
      existing sidecar commands with no CLI-only logic.
