# Backlog

Deferred follow-ups and open questions. Check boxes when done; link PRs when useful.

Every item below was re-verified against the tree on 2026-08-30. Items that turned out
to be already done or obsolete were removed rather than left checked, except where the
history is worth keeping.

---

## Shipping integrity

The `require is not defined` crash in 0.4.4 reached users through four consecutive
green-CI releases, because nothing in CI ever ran the app the way an installer lays it
out. That failure class is the priority.

- [x] **Packaged-layout sidecar regression test** — `sidecar/foundry-sidecar.test.ts`
      stages `sidecar/` next to `foundry-local-sdk/` with no `node_modules` above and
      asserts `init` succeeds.
- [x] **Run `verify:bundle` and `smoke:node` in CI and release** — both scripts existed
      but no workflow invoked them.
- [x] **`verify:bundle` understands `--target` builds** — it only checked
      `target/release`, so release builds (`--target <triple>`) silently skipped every
      staging and installer check. `--require-build` now makes a missing tree fail.
- [ ] **Clean-machine dogfood** — install the signed build on a machine with no Node,
      no Rust, and no prior Foundry install; confirm first run downloads and loads a
      model. Residual from Spike A ([spikes/node-bundle-spike.md](./spikes/node-bundle-spike.md)).
- [ ] **Boot smoke on the real installer** — CI verifies bundle contents but never
      installs the MSI/NSIS and launches the app. Decide between driving the installer
      on a Windows runner and asserting the app reaches "sidecar ready", versus the
      cheaper staged-layout test we already have.
- [ ] **macOS is unverified in practice** — DMG/app artifacts build and upload, but no
      one has confirmed an installed macOS build boots. Either dogfood it or state that
      macOS is unsupported.

## Updater

- [x] **Updater pubkey** — a real minisign key is in `tauri.conf.json`.
- [x] **Updater endpoint** — pointed at `releases/download/v{{current_version}}/latest.json`,
      which resolves to the manifest for the version the user already runs, so the
      updater could never see a newer release. Now uses `releases/latest/download/`.
      Builds up to 0.4.4 cannot self-update, but none were distributed.
- [ ] **Publishing is a manual gate** — the release workflow leaves a draft
      (`releaseDraft: true`), and a release left as a draft or flagged pre-release is
      invisible to `releases/latest`. 0.4.4 sat as a pre-release for this reason.
      Either automate publishing or keep the checklist step.
- [ ] **No in-app update failure surface** — if the updater cannot reach the endpoint
      the user sees nothing. Show a checked-at timestamp and the last error.

## Audio

- [x] **Validate audio bytes before transcribing** — the sidecar renamed any upload to
      `.wav` for the strict decoder, but renaming does not convert, so non-WAV bytes
      failed inside native code with `Cannot read properties of null`. Containers are
      now sniffed by magic bytes before a model loads (`sidecar/audio-format.js`).
- [ ] **Convert instead of rejecting** — a clear rejection beats an opaque crash, but
      converting WebM/Opus and MP3 to 16-kHz mono PCM in the app would be better still.
      Needs a decoder that does not bloat the bundle.
- [ ] **Word-level timestamps are not available from Foundry Local.** Verified against
      the live SDK: `transcribe()` returns no `segments` and `duration: 0`;
      `transcribeStreaming()` yields one chunk per word with no timing;
      `LiveAudioTranscriptionResponse` declares `start_time`/`end_time` but the native
      core returns null for both on every result; live sessions are Nemotron-only and
      throw for Whisper. Tracked upstream at
      [microsoft/Foundry-Local#392](https://github.com/microsoft/Foundry-Local/issues/392),
      open, with a maintainer saying it should be addable. Flint derives approximate
      timings from silence detection instead. Revisit when upstream lands granularity —
      `parakeet-tdt-0.6b-v2` is already in the catalog and produces word timings natively.

## Test coverage

- [x] **Widen the coverage gate** — it covered 4 files at 65/45 thresholds, which the
      included files cleared without effort. Now covers the sidecar and runtime-path
      modules at 88/72.
- [ ] **`+page.svelte` is untested and carries most of the app.** It is ~337 KB and
      `// @ts-nocheck`. Continue extracting pure logic into `src/lib/*.ts` with tests
      (the pattern used for personas, message rendering, model sorting, and audio
      segmentation) rather than trying to test the component directly.
- [ ] **No Rust tests** — `src-tauri` is thin, but `cargo check` is the only gate.

## Runtime strategy

- [ ] **Targeted Rust bridge** — move selected sidecar commands into Tauri/Rust invoke
      incrementally, keeping the JS sidecar as fallback and shrinking the shell-spawn
      surface. Not a big-bang rewrite.
- [ ] **1.0 aspiration** — no end-user Node dependency at all if Rust or the bundled
      runtime covers the whole sidecar surface. Bundled Node 22 already removes the
      user-visible requirement; this is about shrinking the attack surface.

## Optional control CLI (not planned)

**Decision (2026-08-10, still current):** do not build an Ollama-style model CLI or a
second Foundry Local CLI inside Flint. Foundry already owns terminal-first
`foundry model` / `foundry run` / `foundry server`. Flint's wedge is **SDK catalog +
GUI + OpenAI endpoint + Integrations**.

- [ ] **Only if automation demand proves real:** a thin `flint` control CLI mapping 1:1
      to existing sidecar commands (`status`, `models list|download|load|unload`,
      `service start|stop`, `endpoint`), sharing the GUI's runtime with no CLI-only
      product logic.
- **Non-goals:** shadowing or scraping the `foundry` CLI; cloning Ollama's `pull`/`run`
  REPL; shipping any CLI before the desktop control plane is solid.

See PRODUCT_PLAN non-goals and README "Flint vs Foundry Local CLI."

## Docs hygiene

- [x] **README reflected 0.3.3** while the app was at 0.4.4.
- [x] **Local cleanup** of gitignored `docs/pool-spike-results/*-FAILED.*`.
- [ ] **Slim RELEASE_ROADMAP §1–2** (0.1 postmortem) — the roadmap is ~40 KB and the
      early-milestone history now costs more to read than it informs.
- [ ] **Optional root `CONTRIBUTING.md`** linking [DEVELOPMENT.md](./DEVELOPMENT.md).
- [ ] **Optional CI markdown link check** — several docs cross-link and nothing verifies
      the targets exist.

## Process guardrails (adopted)

- One living planner: `RELEASE_ROADMAP.md`. Prefer scorecard sections inside the roadmap
  over parallel sprint and remaining-implementation docs for the same milestone.
- Archive completed plans under `docs/archive/` with an archived banner; do not "fix"
  historical checklists.
- Verify a backlog item against the tree before acting on it. Roughly a third of the
  previous revision described work that was already done or had become obsolete.

---

**Last updated:** 2026-08-30 (re-verified against the tree; updater, packaging, and
audio-validation items reworked)
