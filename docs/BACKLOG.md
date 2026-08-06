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
- [ ] **Optional Node bundling spike** — only if dogfood still hurts after preflight: try pkg **or** stock Node binary; measure size + Foundry SDK native load before adopting. Do not claim “zero deps” until green.
- [ ] **1.0 aspirational** — no end-user Node if Rust (or bundled runtime) covers the sidecar surface.

## Docs hygiene (later)

- [ ] **Slim RELEASE_ROADMAP §1–2** (0.1 postmortem) after `v0.3.0` tag.
- [ ] **Optional root `CONTRIBUTING.md`** linking [DEVELOPMENT.md](./DEVELOPMENT.md).
- [ ] **Optional CI markdown link check**.
- [ ] **Local cleanup** of gitignored `docs/pool-spike-results/*-FAILED.*`.

## Process guardrails (already adopted)

- One living planner: `RELEASE_ROADMAP.md`. Prefer scorecard sections inside the roadmap over parallel sprint + remaining-implementation docs for the same milestone.
- Archive completed plans under `docs/archive/` with an archived banner; do not “fix” historical checklists.

---

**Last updated:** 2026-08-06 (docs/Help landed; tag ops still open — see PRODUCT_PLAN + RELEASE_ROADMAP)
