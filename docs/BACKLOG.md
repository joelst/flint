# Backlog

Open work only. Completed items are deleted, not archived — `git log` and `CHANGELOG.md`
hold the history. Durable facts belong in
[`.github/copilot-instructions.md`](../.github/copilot-instructions.md), not here.

Verify an item against the tree before acting on it.

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

- [ ] **`+page.svelte` is untested** and holds most of the app (~337 KB, `@ts-nocheck`).
      Keep extracting pure logic into `src/lib/*.ts` with tests rather than testing the
      component.
- [ ] **No Rust tests** — `cargo check` is the only gate on `src-tauri`.

## Runtime strategy

- [ ] **Targeted Rust bridge** — move selected sidecar commands to Tauri invoke
      incrementally, JS sidecar as fallback. Not a big-bang rewrite.
- [ ] **1.0: no end-user Node** — bundled Node 22 already removes the user-visible
      requirement; this is about shrinking the spawn/attack surface.

## Control CLI — not planned

Foundry owns terminal-first `foundry model` / `run` / `server`. Flint's wedge is SDK
catalog + GUI + OpenAI endpoint + Integrations. Non-goals: shadowing the `foundry` CLI,
cloning Ollama's `pull`/`run` REPL, any CLI before the desktop app is solid.

- [ ] Revisit only if automation demand proves real, as a thin wrapper mapping 1:1 to
      existing sidecar commands with no CLI-only logic.

## Docs

- [ ] **Slim RELEASE_ROADMAP §1–2** — ~40 KB; the 0.1 postmortem costs more to read than
      it informs.
- [ ] **Optional** root `CONTRIBUTING.md`; CI markdown link check.
