# Agent guide to Flint's docs

Read this first, then load only the doc(s) your task actually needs — most of this
repo's docs are optional and detailed guidance already lives in
[`.github/copilot-instructions.md`](./.github/copilot-instructions.md); this file does
not repeat it.

## What to read for which task

| Task | Read | Skip unless needed |
|---|---|---|
| Any code change — invariants, gotchas, protocol details | [`.github/copilot-instructions.md`](./.github/copilot-instructions.md) | — |
| Build, test, run locally; sidecar/versioning mechanics | [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | — |
| What to implement next, in what order, why | [docs/PRODUCT_PLAN.md](./docs/PRODUCT_PLAN.md) | Its full finding register — only pull the one workstream section you need |
| What's still open but not in-flight | [docs/BACKLOG.md](./docs/BACKLOG.md) | — |
| Forward plan through 1.0, positioning, non-goals | [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) · [FLINT_DESIGN_SPEC.md](./FLINT_DESIGN_SPEC.md) | — |
| What shipped, when | [CHANGELOG.md](./CHANGELOG.md) | `git log` for anything not in a changeset |
| Cutting a signed release | [docs/RELEASE.md](./docs/RELEASE.md) | — |
| End-user behavior / how a feature is supposed to work | [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) | — |
| Full doc index, ownership of each file | [docs/README.md](./docs/README.md) | — |

## Optional deep-dive docs (load only if directly relevant)

Not required reading. [docs/POOL_SPIKE.md](./docs/POOL_SPIKE.md),
[docs/pool-spike-results/](./docs/pool-spike-results/), and
[docs/spikes/node-bundle-spike.md](./docs/spikes/node-bundle-spike.md) are empirical
results kept because they came from real measurement and would cost real time to
reproduce. [docs/LINUX_BUILD_PLAN.md](./docs/LINUX_BUILD_PLAN.md) (deferred workstream)
and [docs/PURVIEW_GOVERNANCE.md](./docs/PURVIEW_GOVERNANCE.md) (unscheduled feature
memo) are design/inventory documents, not measured data, kept for the analysis they
contain.

## Ground rules

- Docs record facts, not history — completed work lives in `git log` and
  `CHANGELOG.md`, not in a doc body. Don't restate shipped work as a plan.
- Before asserting something is "still broken" or "not yet done," check the actual
  code, not just another doc's claim.
- One doc owns each fact (see the table above and
  [docs/README.md](./docs/README.md)). If two docs disagree, that's a bug in one of
  them — flag it rather than picking a side without evidence.
