# Flint Sprint Plan — MVP 0.3 (+ 0.4 pull-ins)

**Date:** 2026-06-26  
**Branch:** `mvp-0.3`  
**Goal:** Complete the model pool, monitoring, and security foundation; pull in bounded 0.4 items that are natural extensions of work already done.

---

## Status snapshot

### Done

| Item | Description | Notes |
|---|---|---|
| 0 | Integration snippets / tool onboarding | Catalog, card UI, OS toggle, copy buttons, `sameForAllOS` helper, language tags fixed |
| 0b | Local API-key proxy research | Decision documented in roadmap: external dependency for 0.3, bundling deferred to 0.4+ |
| 1 | Model pool (replaces named lanes) | `Map<alias,{catModel,variantId}>`, `ensureModel`, `resolveIsLoaded`, `poolStatus`, `getAccessLog`, `startWebService` port-binding fix, variant-ID HTTP routing |
| 3 | Network security + access logging | 127.0.0.1 bind (via `webServiceUrls`); access log ring buffer (500 entries); disk log (`appendFileSync`, 7-day rotation, `~/.flint/logs/`); audit trail for 8 destructive/config commands; IPC rejection logging (malformed JSON, schema failures); PII fix (filename → extension only in transcription log) |

### Remaining — 0.3 items

| Item | Description | Blocking deps | Priority |
|---|---|---|---|
| 2 | Monitoring view | Needs backend additions (memory, streaming flag, token accumulator) | P0 — unblocked now |
| 4 | Keyboard shortcuts | None | P1 |
| 5 | Auto-start and default model | Needs Tauri plugin assessment | P2 |
| 6 | CI/CD improvements | None | P3 |
| 0c | Purview SDK governance memo | None | P3 (design memo only) |

### Pulled from 0.4 — fits current sprint

| Item | Source | Rationale |
|---|---|---|
| A | Enterprise controls: audit log export | Access log is built; adding export (JSON/CSV) is a single UI surface |
| B | Enterprise controls: network config UI | 127.0.0.1 is currently hardcoded; configurable bind/port/CIDR is a direct extension of item 3 |
| C | Vision: multi-image + drag-and-drop | Single-image attach already exists; extending to multiple + drop target is bounded UI work |
| D | Model comparison / bake-off | Pool now supports multiple resident models; side-by-side display builds naturally on the monitoring view |

### Not pulling from 0.4 this sprint

- RAG — requires new local vector store dependency; standalone feature
- Tool calling — requires dedicated security design; separate sprint
- Workspace import/export — useful but independent; no dependency on current work
- Azure AI Foundry cloud connections — blocked on 0.3 security foundation (will be ready after this sprint)

---

## Work queue (ordered)

Dependencies flow top-to-bottom. Items in the same tier can run in parallel.

```
Tier 1 (backend, unblocked)
  2a. Monitoring sidecar additions
  B.  Network config: configurable bind/port in sidecar

Tier 2 (frontend, needs Tier 1 done)
  2b. Monitoring view UI (Monitor tab)
  A.  Audit log export button (inside monitor tab)
  B.  Network config settings panel

Tier 3 (independent frontend)
  4.  Keyboard shortcuts
  C.  Vision multi-image + drag-and-drop

Tier 4 (independent)
  5.  Auto-start and default model
  D.  Model comparison tab
  6.  CI/CD improvements
  0c. Purview SDK memo
```

---

## Per-item scope

### Item 2a — Monitoring: sidecar backend additions

The monitoring view needs data that isn't exposed yet. These additions go into `foundry-sidecar.js`:

**Add to `poolStatus` response:**
- `memoryMb: number | null` — process RSS in MB (`process.memoryUsage().rss / 1024 / 1024`); not per-model (Foundry Local doesn't expose per-model RSS) but good enough for a runtime gauge
- `streaming: { active: boolean, modelAlias: string | null, elapsedMs: number | null }` — whether a chat or audio stream is currently in flight and for how long

**Add session token accumulator:**
- In-memory `Map<alias, { tokensIn: number, tokensOut: number }>` — incremented in `appendAccessLog` when `entry.tokensIn` / `entry.tokensOut` are non-null
- Expose via `poolStatus` as `tokenTotals: [{ alias, tokensIn, tokensOut }]`
- Reset on `stopService` (session boundary)

**What to leave out:**
- Per-model memory (not available from Foundry Local SDK without undocumented internals)
- Source IP in access log (all IPC-originated; external HTTP proxy deferred to 0.3 item 0b follow-on)

---

### Item 2b — Monitoring view UI

New **Monitor** tab in the nav sidebar (between Models and Integrations, or after Diagnostics — decide at implementation time based on visual flow).

**Pool panel:**
- Table: alias | variantId (truncated) | loaded? | accel | tokens in | tokens out
- Refresh: poll `poolStatus` every 5 s while the tab is active; pause when hidden
- "Unload" button per row (calls existing `unload` command)

**Resource panel:**
- Process memory gauge: RSS bar vs. a soft ceiling (user-set or heuristic from installed RAM)
- Active stream indicator: pulsing badge + "streaming to [alias] for Xs" when `poolStatus.streaming.active`

**Access log table:**
- Rolling display of the last 100 `getAccessLog` entries
- Columns: time | type | model | duration | tokens in | tokens out | ok
- Auto-scroll to bottom; pause-on-hover
- Clear button (calls `getAccessLog` to reset? — actually just clears the UI buffer; disk log is immutable)

**What to leave out:**
- Historical charts (no persistent storage yet; post-0.3)
- Source IP column (all IPC, not meaningful yet)
- Memory trend graph

---

### Item A — Audit log export

Inside the monitoring view (or Diagnostics tab if it fits better):

- **Export button** — "Export access log" → downloads `flint-access-log-YYYY-MM-DD.json` or `.csv`
- **Format:** JSON = full `accessLog` array as returned by `getAccessLog`. CSV = flat table with headers.
- **Retention note** in UI: "Disk log at `~/.flint/logs/` retained 7 days. In-memory log holds last 500 requests."
- **No new sidecar command needed** — uses existing `getAccessLog`.

---

### Item B — Network config UI

**Sidecar changes:**
- `startService` currently always uses `http://127.0.0.1:${port}`; make the bind address configurable
- New optional field `bindAddress` on `startService` payload (default `'127.0.0.1'`)
- Add to `COMMAND_SCHEMA` and `FIELD_TYPES`
- When `bindAddress !== '127.0.0.1'`: add a prominent `log('warn', ...)` and an `audit` entry

**Frontend settings panel:**
- Settings > Network section
- Bind address: radio — `127.0.0.1 (local only, recommended)` | `0.0.0.0 (all interfaces)` | custom
- Port: number input (default 5273)
- Allowed CIDR: text field, optional, only shown when bind is not 127.0.0.1
- Warning banner: "Binding to all interfaces exposes your local models to other machines on your network."
- Persisted to `localStorage` (same PERSIST_KEY pattern), applied on next `startService`

**What to leave out:**
- Per-client IP enforcement (requires proxy layer; deferred to 0.3 item 0b follow-on)
- CIDR enforcement in sidecar (document that it's advisory for now; actual firewall enforcement is OS-level)

---

### Item 4 — Keyboard shortcuts

**Shortcuts to implement:**
| Action | Default (Win/Linux) | Default (macOS) |
|---|---|---|
| Send message | Ctrl+Enter | Cmd+Enter |
| New chat | Ctrl+Shift+N | Cmd+Shift+N |
| Push-to-talk (hold) | Ctrl+Space | Cmd+Space (may conflict — make configurable) |
| Navigate to Chat | Ctrl+1 | Cmd+1 |
| Navigate to Models | Ctrl+2 | Cmd+2 |
| Navigate to Audio | Ctrl+3 | Cmd+3 |
| Navigate to Monitor | Ctrl+4 | Cmd+4 |
| Navigate to Integrations | Ctrl+5 | Cmd+5 |
| Navigate to Settings | Ctrl+, | Cmd+, |
| Toggle sidebar | Ctrl+B | Cmd+B |

**Implementation approach:**
- `keydown` listener on `document` in `+page.svelte` (global scope)
- Detect `event.ctrlKey` / `event.metaKey` based on `navigator.platform`
- Configurable bindings: stored as `shortcuts` object in `localStorage` PERSIST_KEY
- Shortcut reference panel: accessible via `?` key or link in footer — displays a table of all bindings
- Tauri global shortcuts (for system-level shortcuts like push-to-talk when window is unfocused): use `@tauri-apps/plugin-global-shortcut` if available; fallback to in-window only

**What to leave out:**
- Chord shortcuts (two-key sequences) — deferred
- Per-conversation shortcut customization — global only for 0.3

---

### Item C — Vision: multi-image + drag-and-drop

**Scope:**
- Allow attaching up to 4 images per message (current: 1)
- Thumbnail strip in the chat input area showing pending images with remove buttons
- Drag-and-drop: `dragover` / `drop` handlers on the chat input container
- Paste from clipboard: already works for first image; extend to append to the strip
- Scope gate: only show attach controls when the selected model has vision capability

**What to leave out:**
- Inline image previews inside the sent message bubble (the image is referenced by data URL; displaying it is a `MessageRenderer` change — defer)
- File size cap UI (the current base64 size validation stays; just add a user-visible error message)

---

### Item 5 — Auto-start and default model

**Scope:**
- Settings > Startup panel
- Checkbox: "Start local service automatically when Flint opens"
- Dropdown: "Default chat model" (from catalog) — pre-selected on launch
- Dropdown: "Default audio model" (from catalog) — pre-selected on launch
- "Default chat/audio" markers stored in `localStorage`; applied in `onMount` when auto-start is enabled
- OS-level startup (login item): use Tauri's `app-auto-launch` (`tauri-plugin-autostart`) — assess availability first; fall back to a documented manual step if the plugin isn't in the current Tauri version

**What to leave out:**
- Multiple startup models (beyond one chat + one audio)
- Startup health check (verify model is still cached before loading — use existing `isCached` from `listModels`)

---

### Item D — Model comparison / bake-off

**Scope:**
- New **Compare** tab (or modal — decide at implementation)
- User selects 2–3 models from the loaded pool (or loads them on demand)
- Single prompt input; sends same messages to each model simultaneously
- Responses displayed in side-by-side columns
- Per-column: model alias, token count, latency badge
- Simple thumbs up/down rating stored in `localStorage` (not synced)
- Export comparison as markdown

**Dependencies:**
- Model pool must support ≥2 concurrent models (done ✅)
- `chatCompletion` must be callable with `stream: false` for simpler parallel fetching (already supported)

**What to leave out:**
- Async streaming comparison (show responses as they stream side-by-side) — defer; synchronous is sufficient for 0.3
- Preference log aggregation / analytics — just `localStorage` per comparison for now

---

### Item 6 — CI/CD improvements

**Scope:**
- **Signed installers:** set up Tauri code signing for Windows (EV cert or self-signed for now) and macOS (Developer ID + notarization) in GitHub Actions
- **Version bump:** `tauri.conf.json` version driven by git tag in CI (`tauri-apps/tauri-action@v0` handles this)
- **Delta update channel:** configure Tauri updater (`tauri-apps/plugin-updater`) with a GitHub Releases endpoint
- **Changelog:** `git-cliff` or `conventional-changelog` on tag push

**What to leave out:**
- MSIX packaging (complex; EXE installer is sufficient for 0.3)
- Auto-update UI (progress bar, release notes) — functional update check is enough; polish in 0.4

---

### Item 0c — Purview SDK governance memo

**Deliverable:** `docs/PURVIEW_GOVERNANCE.md` — a short design memo (~2 pages) covering:
1. Which Purview ingestion path fits Flint's event types (Activity Log API vs. Audit log vs. Information Protection labels)
2. Metadata schema for Flint events (model-load, endpoint-access, session-start/stop) — no prompt/response content by default
3. Opt-in UX: where the toggle lives, what the user sees, what happens on toggle-on
4. Constraints: all reporting off by default; gated by machine-level policy; no PII/employee pay data

**Not in scope:** implementation (lands in 0.4 enterprise controls).

---

## Success criteria for 0.3 exit

| Area | Criterion |
|---|---|
| Model pool | Multiple models load and serve requests simultaneously; pool visible in Monitor tab |
| Access log | Every IPC-originated chat and audio request appears in Monitor tab and in `~/.flint/logs/` |
| Audit trail | `init`, `download`, `load`, `unload`, `deleteModel`, `startService`, `stopService`, `setLogLevel` all produce `type:audit` entries on disk |
| Monitoring view | Pool table, resource gauge, access log table, and export button all functional |
| Network config | Bind address and port configurable from settings; 127.0.0.1-only default preserved |
| Keyboard shortcuts | At minimum: send, new chat, view navigation, push-to-talk all functional with visible shortcut reference |
| Auto-start | Default chat + audio model pre-selected on launch when configured |
| Vision | Multiple images attachable per message with thumbnail strip |
| Model comparison | Two models can respond to the same prompt side-by-side |
| CI/CD | Signed build artifact produced on tag push; updater endpoint configured |
| Build warnings | `logListEl` Svelte warning and unused CSS selector warnings resolved ✅ |
