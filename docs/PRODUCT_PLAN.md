# Flint product plan (docs → next ship → 1.0)

**Last updated:** 2026-08-06  
**Status:** Living plan after packaging work landed on `main`.  
**Companion docs:** [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) (release scorecards), [BACKLOG.md](./BACKLOG.md) (deferred items).

---

## Current status (rubber-duck check)

| Area | State (as of 2026-08-06) |
|---|---|
| **Version in tree** | **0.3.3** (`package.json` / Tauri / Cargo) |
| **`main`** | Packaging + rebind + network Apply shipped (`f16d761` era); version packages (#11); release CI drops unsupported `x86_64-apple-darwin` (#12) |
| **Product features (0.3)** | Models pool, chat/vision, audio STT, Compare, Monitor, Integrations, Settings network bind, shortcuts, autostart — **feature-complete** |
| **Installers** | Bundle Foundry natives + `Flint.exe`; sidecar path resolution hardened; `ensure:foundry` target-aware |
| **Still required for a real public tag** | Updater private key + GitHub signing secrets; dogfood clean-machine install; honest CHANGELOG for 0.3.2/0.3.3 |
| **End-user friction** | **Node.js 22+ on PATH** still required (JS sidecar) |
| **Docs / help** | README + Help + first-run coach + USER_GUIDE landed; roadmap dashboard refreshed |
| **Mac Intel** | No Foundry `darwin-x64` cores — release matrix correctly limited to **darwin-arm64** (+ Windows) |

**Bottom line:** Storytelling and first-run help are in better shape. Next value is **public tag / dogfood (C1–C3)** and empty-state polish (B3/B4), not more features.

---

## Goals of this plan

1. Make the **why** of Flint obvious in 30 seconds (repo + app).  
2. Make **first run** succeed without reading the design spec.  
3. Sequence **0.3.x ship polish → 0.4 features → 1.0 bar** without parallel planners.

---

## Workstreams

### A. Documentation & positioning

| # | Item | Outcome | Priority |
|---|---|---|---|
| A1 | **README rewrite** | Value prop, who it’s for, first run, honest limits, current version | ✅ Done |
| A2 | Refresh **RELEASE_ROADMAP** dashboard | 0.3.x status matches code; 0.4/1.0 remaining clear | ✅ Done |
| A3 | **USER_GUIDE.md** (short) | Models → Chat → Service → Integrations; bind vs client URL | ✅ Done |
| A4 | **CONTRIBUTING.md** | Link DEVELOPMENT + PR/changeset norms | P2 |
| A5 | Trim stale notes | Design spec winml install; BACKLOG release boxes after tag | P2 |

### B. In-app help

| # | Item | Outcome | Priority |
|---|---|---|---|
| B1 | **First-run coach** | 3–4 steps: Node check → starter model → chat → optional service | ✅ Done (banner + dismiss) |
| B2 | **Learn → Help** restructure | Why Flint / First 5 min / Tools / Troubleshoot / Shortcuts | ✅ Done |
| B3 | **Contextual empty states** | Models/Chat/Compare/Monitor each have one next action | P2 |
| B4 | **About** strip | Version, Node version, endpoint, link to docs/releases | P2 |

### C. Release ops (0.3.x close-out)

| # | Item | Outcome | Priority |
|---|---|---|---|
| C1 | Updater key + repo secrets | Signed installers + updater metadata real | P0 for public tag |
| C2 | `workflow_dispatch` RC then `v*` tag | Proves release.yml end-to-end | P0 for public tag |
| C3 | Clean-machine dogfood | Install, Node missing UX, rebind, Integrations | P0 |
| C4 | CHANGELOG accuracy | 0.3.2 packaging + 0.3.3 notes human-readable | P1 |

### D. Product (0.4+)

Pick **few** flagships after C-track:

1. In-app **auto-update UX** (infra already partial)  
2. **Local RAG** (files → index → inject; extends 0.3 URL context)  
3. **Azure AI Foundry** endpoint profiles  
4. **Node-free runtime spike** (bundle Node or Rust bridge) — **must start before 1.0**

Defer: autonomous agent loops, full Purview implementation, full multi-endpoint scheduler.

### E. 1.0 definition of done

| Must | Bar |
|---|---|
| Install | Signed Windows; notarized macOS if shipping Mac |
| Runtime | **No Node on PATH** for normal users |
| Core flows | Models, chat, audio, service, Integrations reliable on clean OS |
| Updates | In-app check/install with real keys |
| Security | Loopback default; non-loopback confirmed; shell surface minimized |
| Help | First-run + Help + top failure troubleshooting |
| Quality | Unit + critical E2E or scripted dogfood |
| Docs | README why + first run; user guide; honest limits |

---

## Sequencing

```text
A1 README ✅
B1/B2 Help + first-run coach ✅
A2/A3 roadmap + USER_GUIDE ✅
  → C1–C3 tag 0.3.x public (secrets, RC, dogfood)
  → B3/B4 empty states + About polish
  → 0.4: auto-update UX + (RAG | Azure | Node spike)
  → 0.5–0.9: Node independence + hardening
  → 1.0: runtime + signed + help + core flows locked
```

---

## Success metrics (lightweight)

- New user can answer “why Flint?” from README alone.  
- First chat without reading DEVELOPMENT.md.  
- Public release installs without developer tribal knowledge (except Node until 1.0).  
- Roadmap dates/status match `main` within a week of merges.

---

## Non-goals of this plan

- Rewriting archive plans.  
- Building an in-app full documentation site.  
- Committing to every 0.4 bullet in one release.
