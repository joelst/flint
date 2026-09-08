# Purview SDK Governance Memo for Flint

**Date:** 2026-06-28  
**Status:** Draft for 0.3 (design memo only; implementation deferred to 0.4+)

## 1. Background

Flint is a local-first desktop application (Tauri + Svelte) that provides a GUI for Microsoft Foundry Local. It runs inference models entirely on the user's machine.

Current audit surface (implemented in 0.3):
- Sidecar produces structured logs: `audit()` entries for destructive/config commands (`download`, `load`, `unload`, `deleteModel`, `startService`, `stopService`, `setLogLevel`, `init`).
- Access log ring buffer (last 500) + on-disk rotation (7 days in `~/.flint/logs/`).
- Access entries include: timestamp, model alias/variant, duration, tokens in/out, success status, bind address (sanitized).
- No raw prompts, responses, or user-generated content are logged by default (transcription already strips filenames to extensions only).
- All activity is local; no telemetry is sent unless explicitly opted in.

Enterprise users (especially in regulated environments) need governance, auditability, and compliance reporting for local AI usage without compromising the local-first privacy model.

## 2. Purview Ingestion Path Recommendation

**Recommended path:** Microsoft Purview Unified Audit Log (via the Audit (Standard) or Premium APIs / Search-UnifiedAuditLog) or the Microsoft Purview SDK for custom applications.

**Why this path:**
- Unified audit log supports custom / non-Microsoft applications (pay-as-you-go for non-MS AI apps: ~$15 per 1M records ingested, 180-day retention for Standard).
- Provides searchable, exportable records for security investigations, compliance, and internal audits.
- Precedent exists with GitHub Copilot and custom Copilot Studio / Azure AI apps streaming audit logs into Purview.
- Supports the Microsoft Purview SDK for .NET (and similar) for easy embedding of logging, DLP, and sensitivity labeling.

**Alternatives considered:**
- **Azure Activity Log API**: Better suited for Azure resource operations (e.g., if using cloud endpoints later). Less relevant for pure desktop local events.
- **Information Protection + DLP / sensitivity labels**: Useful if users load private documents or want to classify model outputs, but secondary to basic audit logging of usage.
- Direct custom Event Hub / Log Analytics: More flexible but requires more custom plumbing; Purview unifies this for Microsoft-centric enterprises.

**Rationale for 0.3/0.4 scope:** Focus on metadata-only usage events. Full prompt/response capture is explicitly out of scope for privacy reasons.

## 3. Metadata Schema for Flint Events

Proposed events (all metadata-only; no prompt or response content):

- `Flint.ModelLoad` / `Flint.ModelUnload` / `Flint.ModelDownload` / `Flint.ModelDelete`
- `Flint.ServiceStart` / `Flint.ServiceStop`
- `Flint.EndpointAccess` (or `Flint.InferenceRequest`)
- `Flint.SessionStart` / `Flint.SessionStop`

**Common fields (example JSON record):**
```json
{
  "EventType": "Flint.EndpointAccess",
  "Timestamp": "2026-06-28T12:34:56Z",
  "AppVersion": "0.3.0",
  "ModelAlias": "qwen2.5-7b",
  "VariantId": "chat",
  "Accelerator": "CUDA",
  "TokensIn": 142,
  "TokensOut": 87,
  "DurationMs": 1240,
  "Success": true,
  "BindAddress": "127.0.0.1",
  "SessionId": "opaque-uuid-here"
}
```

**Constraints:**
- Never include raw user prompts, model outputs, or file contents.
- Filenames are already sanitized (extension only) in related transcription paths.
- Opaque session IDs; no user identifiers or PII.
- Rate-limited local buffering before any export.

## 4. Opt-in UX

**Location:** Settings → Enterprise / Compliance (or a new "Governance" section). Placed behind an "Advanced" toggle or feature flag for 0.4 implementation.

**Toggle label:** "Enable Microsoft Purview audit logging (enterprise only)"

**On toggle ON:**
- Clear explanation dialog: "No prompts or model responses are ever sent. Only usage metadata (models loaded, token counts, session durations, errors) will be reported to your organization's Purview tenant."
- Link to privacy note and admin policy docs.
- Confirmation required.

**Behavior when enabled:**
- Background export of selected audit/access events (via Purview SDK or log forwarder).
- Local logs continue to be written (user can still inspect `~/.flint/logs/`).
- Toggle can be disabled at any time (stops new exports; may require admin policy to re-enable).

**Admin / machine-level controls (0.4+):**
- Registry key or config file override to force the setting on or off.
- Group policy support for enterprise deployment.

## 5. Constraints & Guardrails

- **Default OFF.** Must be explicitly enabled by the user.
- No PII or content ever leaves the machine without opt-in.
- All reporting respects existing local-first posture and `~/.flint` directory conventions.
- Events are aggregated where possible to minimize record volume/cost.
- Scope strictly limited to 0.4+ implementation (this memo is design only for 0.3).
- Must integrate cleanly with existing access/audit log machinery (reuse `audit()` and `appendAccessLog`).

## 6. Open Questions & Next Steps (post-0.3)

- Exact export mechanism: direct Purview SDK calls from sidecar/frontend vs. writing to a local log that an enterprise agent ships.
- Tenant configuration: how does the app discover the customer's Purview endpoint/tenant ID?
- Retention & eDiscovery integration.
- DLP / sensitivity label application to any exported records.
- Full implementation and UI (including toggle, status, and export history) lands in 0.4 enterprise controls.

This memo satisfies the 0.3 requirement for a short (~2 page) governance design document. Implementation is explicitly out of scope for this release.

---

**Cross-references:** [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) (0.3 scorecard / 0.4 enterprise controls), archived sprint note in [docs/archive/SPRINT_PLAN_0.3.md](./archive/SPRINT_PLAN_0.3.md) (Item 0c), and sidecar audit/access logging code for current implementation details.