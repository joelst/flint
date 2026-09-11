# Flint documentation

Index by audience. These are the living docs; there is no archive. AI/agent
contributors: start at [AGENTS.md](../AGENTS.md) for a token-saving map of which doc
to load for a given task.

## Users

| Doc | Purpose |
|---|---|
| [README.md](../README.md) | Why Flint, who it’s for, screenshots, quick start |
| [USER_GUIDE.md](./USER_GUIDE.md) | First run, common tasks, bind vs client URL, troubleshooting |
| [PRODUCT_PLAN.md](./PRODUCT_PLAN.md) | Reliability execution plan, finding register, acceptance gates, and Rust supervision decision |
| [CHANGELOG.md](../CHANGELOG.md) | Versioned release notes |

## Contributors

| Doc | Purpose |
|---|---|
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Dev setup, scripts, sidecar, versioning |
| [EXTENDING.md](./EXTENDING.md) | Architecture boundaries and safe extension guide for contributors |
| [FLINT_DESIGN_SPEC.md](../FLINT_DESIGN_SPEC.md) | Architecture and product principles |
| [`.github/copilot-instructions.md`](../.github/copilot-instructions.md) | Short AI/contributor conventions |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Entry point: which doc to read, pre-PR checklist |

## Release operators

| Doc | Purpose |
|---|---|
| [RELEASE.md](./RELEASE.md) | Signing, GitHub secrets, updater keys, test pipeline |
| [RELEASE_0.7.0.md](./RELEASE_0.7.0.md) | 0.7.0 prerelease gates and Explorer-team handoff checklist |
| [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) | Current probe-backed plan through 1.0 and the 1.0 release bar (release history: [CHANGELOG.md](../CHANGELOG.md)) |

## Design / research

Optional deep-dive reading — not required to build or contribute. Some are empirical
results kept because they came from real measurement and would cost real time to
reproduce (POOL_SPIKE, pool-spike-results, node-bundle-spike); others are design memos
or deferred plans kept for the analysis they contain, not measured data
(PURVIEW_GOVERNANCE, LINUX_BUILD_PLAN).

| Doc | Purpose |
|---|---|
| [PURVIEW_GOVERNANCE.md](./PURVIEW_GOVERNANCE.md) | Enterprise audit / Purview memo (implementation unscheduled) |
| [LINUX_BUILD_PLAN.md](./LINUX_BUILD_PLAN.md) | Linux build plan (deferred — not an active workstream; see [BACKLOG.md](./BACKLOG.md)) |
| [POOL_SPIKE.md](./POOL_SPIKE.md) | Model pool co-residency spike protocol (complete; retained for re-runs) |
| [pool-spike-results/](./pool-spike-results/) | Canonical pool-spike result |
| [spikes/node-bundle-spike.md](./spikes/node-bundle-spike.md) | Bundled-Node packaging size/approach spike (referenced from [DEVELOPMENT.md](./DEVELOPMENT.md)) |

## Planning process

- **Implementation sequencing and acceptance gates:** [PRODUCT_PLAN.md](./PRODUCT_PLAN.md).
- **Forward plan through 1.0 and the 1.0 release bar:** [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md).
- **Release history:** [CHANGELOG.md](../CHANGELOG.md).
- Do **not** maintain a separate sprint plan or remaining-implementation-plan file for
  work already covered by one of the two docs above.
- Deferred follow-ups: [BACKLOG.md](./BACKLOG.md) — open items only; completed work lives in `git log` and [CHANGELOG.md](../CHANGELOG.md).
