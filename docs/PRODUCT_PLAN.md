# Flint product plan (docs → v0.4.0 → 1.0)

**Last updated:** 2026-08-06  
**Target release for this track:** **v0.4.0** (docs, Help, empty states, and remaining 0.3.x polish ship under 0.4 — not a separate 0.3.x “docs only” tag).  
**Companion docs:** [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) (release scorecards), [BACKLOG.md](./BACKLOG.md) (deferred items).

---

## Current status (rubber-duck check)

| Area | State (as of 2026-08-06) |
|---|---|
| **Version in tree** | **0.3.3** base; next product cut **0.4.0** |
| **`main` / `0.4-mvp`** | Packaging + rebind + network Apply; README/Help/coach/USER_GUIDE in progress on 0.4 track |
| **Product features (0.3)** | Models pool, chat/vision, audio STT, Compare, Monitor, Integrations, Settings — **feature-complete** |
| **Installers** | Foundry natives + `Flint.exe`; target-aware `ensure:foundry`; no Intel Mac matrix target |
| **v0.4.0 still needs** | Empty states (B3), About polish (B4), release secrets/tag/dogfood as part of 0.4 ship |
| **End-user friction** | **Node.js 22+ on PATH** still required (JS sidecar) |
| **Mac Intel** | No Foundry `darwin-x64` cores — Windows + darwin-arm64 only |

**Bottom line:** 0.4.0 is the umbrella for polish (docs/help/empty states) + release ops + first post-0.3 feature bets.

---

## Goals of this plan

1. Make the **why** of Flint obvious in 30 seconds (repo + app).  
2. Make **first run** succeed without reading the design spec.  
3. Sequence **v0.4.0 (polish + ship + first flagships) → 1.0 bar** without parallel planners.

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
| B3 | **Contextual empty states** | Models/Chat/Compare/Monitor each have one next action | ✅ Done |
| B4 | **About** strip | Version, Node version, endpoint, link to docs/releases | ✅ Done (Help + Settings) |

### C. Release ops (ship with v0.4.0)

| # | Item | Outcome | Priority |
|---|---|---|---|
| C1 | Updater key + repo secrets | Signed installers + updater metadata real | P0 for tag |
| C2 | `workflow_dispatch` RC then `v0.4.0` tag | Proves release.yml end-to-end | P0 for tag |
| C3 | Clean-machine dogfood | Install, Node missing UX, rebind, Integrations | P0 |
| C4 | CHANGELOG for 0.4.0 | Packaging + Help + empty states + any flagships | P1 |

### D. Product flagships (also v0.4.0 — pick few)

1. In-app **auto-update UX** (infra already partial)  
2. **Local RAG** (files → index → inject; extends 0.3 URL context)  
3. **Azure AI Foundry** endpoint profiles  
4. **Node-free runtime spike** (bundle Node or Rust bridge) — **start in 0.4, finish by 1.0**

Defer past 0.4: autonomous agent loops, full Purview implementation, full multi-endpoint scheduler.

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
v0.4.0 track:
  A1 README ✅  B1/B2 Help + coach ✅  A2/A3 USER_GUIDE + roadmap ✅  B3 empty states ✅  B4 About ✅
  → C1–C3 secrets, RC, dogfood, tag v0.4.0
  → D: auto-update UX and/or RAG/Azure/Node spike (as capacity allows)
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
