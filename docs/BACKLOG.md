# Documentation & product-copy backlog

Items found during docs consolidation and deferred follow-ups. Check boxes when done; link PRs when useful.

---

## Product UI copy (code changes)

- [x] **Learn tab accuracy pass** (`src/routes/+page.svelte` Learn view) — Node 22+ + bundled Foundry + Around the app.
- [x] **`flint-context.ts` fact sheet** — 0.3 surfaces + Node 22+ dependency called out.
- [x] **In-app Integrations / Diagnostics / boot copy** — boot notice shows Node preflight errors with guidance.
- [x] **Node preflight** — `src/lib/node-runtime.ts` + `ensureNodeRuntime()` before sidecar spawn; min **Node 22+** (security-supported floor); shell allow `node -v` / `--version`.

## Release process

- [x] **CHANGELOG 0.3.0 section** — hand-written from scorecard + bonus features.
- [x] **Updater endpoint URL** — `joelst/flint` in `tauri.conf.json`.
- [ ] **Updater pubkey** — generate with `npx tauri signer generate -w ~/.tauri/flint.key`; replace `PLACEHOLDER` in `tauri.conf.json` (do not commit private key).
- [ ] **GitHub signing secrets** — `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` per [RELEASE.md](./RELEASE.md).
- [ ] **RC / tag** — `workflow_dispatch` then `v0.3.0` per [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md).

## Runtime strategy (post-0.3)

- [ ] **0.4+ targeted Rust bridge** — move selected sidecar commands into Tauri/Rust invoke (or thin Rust sidecar) incrementally; keep JS Node sidecar as fallback; shrink shell-spawn surface over time. Not a big-bang rewrite.
- [x] **Node bundling spike (Spike A)** — **Go** 2026-08-10 ([spikes/node-bundle-spike.md](./spikes/node-bundle-spike.md)): `externalBin` + `smoke:node` N-API + release MSI/NSIS size delta. PATH remains dev fallback. Residual: clean-machine dogfood with Node uninstalled (C3).
- [ ] **1.0 aspirational** — no end-user Node if Rust (or bundled runtime) covers the sidecar surface.

## Optional control CLI (post–core solid; not 0.4)

**Decision (2026-08-10):** do **not** build an Ollama-style model CLI or a second Foundry Local CLI inside Flint. Foundry already owns terminal-first `foundry model` / `foundry run` / `foundry server`. Flint’s wedge remains **SDK catalog + GUI + OpenAI endpoint + Integrations**.

- [ ] **Optional later: thin `flint` control CLI** — only if automation demand is real after node-free + stable sidecar IPC. Map 1:1 to existing sidecar commands, e.g. `status`, `models list|download|load|unload`, `service start|stop`, `endpoint`. Same runtime as the GUI (no CLI-only product logic).
- **Non-goals:** shadow/scrape `foundry` CLI; full `pull`/`run` REPL clone of Ollama; shipping a CLI before the desktop control plane is solid.

See PRODUCT_PLAN non-goals and README “Flint vs Foundry Local CLI.”

## Docs hygiene (later)

- [ ] **Slim RELEASE_ROADMAP §1–2** (0.1 postmortem) after `v0.3.0` tag.
- [ ] **Optional root `CONTRIBUTING.md`** linking [DEVELOPMENT.md](./DEVELOPMENT.md).
- [ ] **Optional CI markdown link check**.
- [ ] **Local cleanup** of gitignored `docs/pool-spike-results/*-FAILED.*`.

## Process guardrails (already adopted)

- One living planner: `RELEASE_ROADMAP.md`. Prefer scorecard sections inside the roadmap over parallel sprint + remaining-implementation docs for the same milestone.
- Archive completed plans under `docs/archive/` with an archived banner; do not “fix” historical checklists.

---

**Last updated:** 2026-08-10 (CLI stance + Spike A Go — see PRODUCT_PLAN + spikes/node-bundle-spike.md)
