# Documentation & product-copy backlog

Items found during docs consolidation that are **intentionally deferred**. Do not lose these; do not block the docs PR on them.

Track progress by checking boxes and linking PRs when work starts.

---

## Product UI copy (code changes)

- [ ] **Learn tab accuracy pass** (`src/routes/+page.svelte` Learn view)
  - Align with README prerequisites: Foundry runtime **bundled**; call out **Node.js on PATH** for the JS sidecar if end users still need it.
  - Keep tool-calling boundary accurate (Foundry emits `tool_calls`; Flint does not execute tools).
  - Mention newer surfaces if useful (Monitor, Integrations, Compare) without turning Learn into a full manual.
  - Source of truth after docs PR: [README.md](../README.md) + this backlog item.

- [ ] **`flint-context.ts` fact sheet** (`src/lib/flint-context.ts`)
  - Keep feature list aligned with shipped 0.3+ capabilities when product docs change.
  - Ensure host-aware context strings do not claim “no dependencies” if Node is still required for the sidecar.

- [ ] **In-app Integrations / Diagnostics copy**
  - Spot-check endpoint / Node / install wording against README after any runtime packaging change (e.g. self-contained sidecar).

## Release process (not docs structure)

- [ ] **CHANGELOG 0.3.0 section** — hand-write or retroactive changeset covering scorecard + host-aware context + web-fetch (see [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) ship checklist).
- [ ] **Updater pubkey + endpoint placeholders** — generate keys, set real `owner/repo` in `tauri.conf.json`.
- [ ] **GitHub signing secrets** — configure per [RELEASE.md](./RELEASE.md).

## Docs hygiene (later)

- [ ] **Slim RELEASE_ROADMAP §1–2** (0.1 postmortem) into a short History appendix after `v0.3.0` is tagged.
- [ ] **Optional root `CONTRIBUTING.md`** that only links [DEVELOPMENT.md](./DEVELOPMENT.md) (GitHub convention).
- [ ] **Optional CI markdown link check** for `*.md` internal links.
- [ ] **Local cleanup** of gitignored `docs/pool-spike-results/*-FAILED.*` on developer machines (not tracked).

## Process guardrails (already adopted)

- One living planner: `RELEASE_ROADMAP.md`. Prefer scorecard sections inside the roadmap over parallel sprint + remaining-implementation docs for the same milestone.
- Archive completed plans under `docs/archive/` with an archived banner; do not “fix” historical checklists.

---

**Last updated:** 2026-07-08 (docs consolidation)
