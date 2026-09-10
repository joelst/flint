# Flint documentation

Index by audience. These are the living docs; there is no archive.

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
| [FLINT_DESIGN_SPEC.md](../FLINT_DESIGN_SPEC.md) | Architecture and product principles |
| [`.github/copilot-instructions.md`](../.github/copilot-instructions.md) | Short AI/contributor conventions |

## Release operators

| Doc | Purpose |
|---|---|
| [RELEASE.md](./RELEASE.md) | Signing, GitHub secrets, updater keys, test pipeline |
| [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) | Shipped-version history, the 0.5→1.0 plan, and the 1.0 release bar |

## Design / research

| Doc | Purpose |
|---|---|
| [PURVIEW_GOVERNANCE.md](./PURVIEW_GOVERNANCE.md) | Enterprise audit / Purview memo (implementation unscheduled) |
| [LINUX_BUILD_PLAN.md](./LINUX_BUILD_PLAN.md) | Linux build plan (deferred — not an active workstream; see [BACKLOG.md](./BACKLOG.md)) |
| [POOL_SPIKE.md](./POOL_SPIKE.md) | Model pool co-residency spike protocol |
| [pool-spike-results/](./pool-spike-results/) | Canonical spike result |

## Planning process

- **Implementation sequencing and acceptance gates:** [PRODUCT_PLAN.md](./PRODUCT_PLAN.md).
- **Release status and version scorecards:** [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md).
- Do **not** maintain a separate sprint plan or remaining-implementation-plan file for
  work already covered by one of the two docs above.
- Deferred follow-ups: [BACKLOG.md](./BACKLOG.md) — open items only; completed work lives in `git log` and [CHANGELOG.md](../CHANGELOG.md).
