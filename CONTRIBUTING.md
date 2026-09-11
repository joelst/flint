# Contributing to Flint

Flint is a Tauri 2 desktop control plane for Microsoft Foundry Local. This file
is an entry point, not a duplicate of the real guides:

- **Building, testing, and running locally:** [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).
- **Architecture, extension seams, and working safely in parallel:**
  [docs/EXTENDING.md](./docs/EXTENDING.md).
- **What's open but not yet in flight:** [docs/BACKLOG.md](./docs/BACKLOG.md).
- **Forward plan and release sequencing:** [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md)
  and [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md).
- **Full documentation index:** [docs/README.md](./docs/README.md).

## Before opening a pull request

1. Pick one of the work lanes described in
   [EXTENDING.md#working-safely-in-parallel](./docs/EXTENDING.md#working-safely-in-parallel)
   and keep the change to one behavioral concern.
2. Run the checks in the pull request template's **Validation** section —
   `npm run check`, focused tests, and `npm run verify:ipc-contracts` /
   `npm run verify:markdown-links` / `npm run verify:bundle` when they apply to
   your change.
3. Fill in the template's **Handoff** section (lane owner, what the next
   contributor should know) so parallel work stays coordinated.
4. Add a changeset for any code change (`npm run changeset`); an empty changeset
   with a one-line rationale is valid for documentation/tooling-only changes.

Never create a second Foundry manager, model pool, or runtime owner outside the
existing Node sidecar boundary — see EXTENDING.md's architecture section for
the full rule.
