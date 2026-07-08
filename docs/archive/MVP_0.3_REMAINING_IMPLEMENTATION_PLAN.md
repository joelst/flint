# MVP 0.3 Remaining Implementation Plan

**Branch:** `mvp-0.3`
**Date:** 2026-06-28
**Status:** Draft for review — Significant progress:

- Vision multi-image: implemented + gating improved
- Model comparison: basic functional tab implemented + strengthened
- CI/CD: updater foundation + self-signed workflow + signing guide
- Purview: memo created
- Docs: sprint plan updated with status
**Goal:** Complete the three incomplete areas for MVP 0.3 exit so the release meets the success criteria in `docs/SPRINT_PLAN_0.3.md`.

## Overview of Incomplete Items

From `docs/SPRINT_PLAN_0.3.md`, the remaining work falls into these three categories:

1. **Item 6: CI/CD improvements** (core 0.3, P3)
2. **Item 0c: Purview SDK governance memo** (core 0.3, P3, design-only)
3. **Pulled 0.4 features still open** (Vision multi-image + Model comparison)

Many other 0.3 items (model pool, monitoring, autostart, network config, shortcuts, audit logging, etc.) are functionally complete based on recent commits and code inspection.

**Scope clarification (per feedback):** For CI/CD we will focus on making release builds produce **signed installers** and **updater-compatible artifacts** (using self-signed certificates to start). Full runtime "Check for updates" UI, auto-update experience, and user-facing update flows are deferred until just before the 1.0 release.

This plan provides **detailed, actionable steps**, current state analysis, file changes, sequencing, risks, testing, and verification for each.

## Assumptions (applies across all sections)

- The model pool and concurrent model support (recently implemented) remain stable.
- Existing patterns (Svelte 5 runes, localStorage persistence via PERSIST_KEY, sidecar command style, changesets for versioning) will be followed.
- We are targeting a 0.3 release that is "feature complete per the sprint plan" but may use self-signed certs for distribution. Proper code signing certs are a post-0.3 polish item.
- No new external services or heavy dependencies unless explicitly called out.

---

## 1. CI/CD Improvements (Item 6)

### Current State

- `.github/workflows/ci.yml`: Runs `npm run check`, tests, and debug Tauri builds (`tauri-action@v0 --debug`) on PRs/pushes for Windows + macOS.
- `.github/workflows/release.yml`: Triggered on `v*` tags. Sets version from tag (now via `scripts/sync-versions.cjs`), builds release bundles (msi/nsis + dmg/app) using `tauri-action@v0`, creates draft GitHub release.
- `src-tauri/tauri.conf.json`: No `plugins.updater` section. Version managed via sync script + changesets (recently added).
- `package.json` / `Cargo.toml`: No updater plugin.
- No code signing steps.
- No changelog generation automation (though `CHANGELOG.md` exists and changesets can populate it).
- Versioning partially addressed by new `.github/workflows/version.yml` (changesets) + sync script.

**Adjusted 0.3 goal:** Get the release pipeline producing **signed installers** (self-signed certs to bootstrap) and **updater metadata** in GitHub releases. Runtime update checking UI is explicitly deferred until pre-1.0.

**Success criterion (from plan, adjusted for scope):** "Signed build artifact produced on tag push; updater endpoint configured." (Infrastructure + build artifacts; full end-user auto-update flow later.)

### Detailed Implementation Steps

#### 1.1 Add Tauri Updater Plugin (Foundation)

- Frontend: `npm install @tauri-apps/plugin-updater`
- Rust side:
  - Add to `src-tauri/Cargo.toml`:
    ```toml
    tauri-plugin-updater = "2"
    ```
  - In `src-tauri/src/lib.rs`: `.plugin(tauri_plugin_updater::Builder::new().build())`
- Capabilities: Update `src-tauri/capabilities/default.json` (add these even though runtime calls are deferred — they are harmless and prepare for 1.0):

  ```json
  "updater:allow-check",
  "updater:allow-download-and-install"
  ```

- Add `updater` to `tauri.conf.json` (see 1.3).

#### 1.2 Generate and Configure Updater Keys + Endpoints

- Run: `npx tauri signer generate -w ~/.tauri/flint.key` (or via `tauri signer generate`).
- Store private key securely (never commit).
- Public key goes into `tauri.conf.json`.
- Endpoints: GitHub Releases (Tauri provides a standard `latest.json` format).
  Example endpoint: `https://github.com/<org>/flint/releases/download/latest/latest.json` or use the release JSON.

#### 1.3 Update tauri.conf.json for Updater (build-time config)
Add the updater plugin configuration. This is required so that released bundles are "updater-aware" even if we do not yet call the updater APIs at runtime:
```json
"plugins": {
  "updater": {
    "pubkey": "<YOUR_PUBLIC_KEY_HERE>",
    "endpoints": [
      "https://github.com/YOUR_ORG/flint/releases/download/{{current_version}}/latest.json"
    ],
    "windows": {
      "installMode": "passive"
    }
  }
}
```
- Also add under `bundle` if needed for compatibility.
- Ensure `bundle.active: true` and correct targets.
- **Note:** Runtime usage of the updater plugin (check/download) is deferred. We only need the config so the release artifacts are ready.

#### 1.4 Update Release Workflow for Updater Artifacts + Signing (self-signed bootstrap)
Enhance `.github/workflows/release.yml` with the goal of producing signed release artifacts + updater metadata on every `v*` tag.

- After the version-set step:
  - Configure the tauri-action call to produce updater artifacts. Common pattern:
    ```yaml
    with:
      args: --target ${{ matrix.target }} --bundles appimage,deb,app,dmg,msi,nsis,updater
    ```
    (or run a separate `tauri build` step for the updater bundle if the action needs help).
  - Add a post-build step (or rely on tauri-action outputs) that uploads `latest.json` and the `.sig` files as release assets.
- Add signing steps using **self-signed certificates to get started**:
  **Self-signed certificate generation (do this once locally):**
  - Windows: Use PowerShell or `New-SelfSignedCertificate` + `Export-PfxCertificate` to create a code-signing PFX. Base64-encode it for the secret.
  - macOS: `security create-keypair`, `codesign` with a self-signed cert, or use a Developer ID Application cert from Apple (self-signed will still show warnings).
  **In the workflow:**
  **macOS:**
  - Use `apple-actions/import-codesign-certs` (or manual `security` + `codesign`).
  - `xcrun notarytool` can be skipped or made optional for the initial self-signed phase.
  **Windows:**
  - Import the PFX from secret.
  - Use `signtool sign /f cert.pfx ...` on the output executables/installers (or tauri-action's built-in signing if configured via env).
- Secrets (self-signed bootstrap):
  - `WINDOWS_CERTIFICATE` (base64 of .pfx) + `WINDOWS_CERTIFICATE_PASSWORD`
  - `APPLE_CERTIFICATE` etc. when moving beyond pure self-signed.
- Upload all signed bundles + updater files.
- Ensure a tag push always produces a draft release containing the signed installers and the files needed for future delta updates.

- Update the `tauri-action` call to pass signing-related environment variables when available.
- Improve `releaseBody` to reference the changelog or the new release artifacts.

#### 1.5 Changelog Automation
- Primary: Use the existing changesets setup (already configured with `@changesets/cli/changelog`).
  - When the "Version Packages" PR is merged, it should update `CHANGELOG.md`.
  - In the release workflow, ensure the changelog is committed/updated before building.
- Fallback / enhancement: Add `git-cliff` later if more control over conventional commits is desired.
  - Add `cliff.toml` only if we decide to go beyond changesets.
- In release notes: Reference the generated CHANGELOG or include a summary.
- The `releaseBody: "See CHANGELOG for details."` can stay or be made more dynamic.

#### 1.6 Release Pipeline Polish & Documentation (UI deferred)
- Update `README.md`, `docs/SPRINT_PLAN_0.3.md`, and `.github/copilot-instructions.md` with the new release process (tag-driven signed builds + self-signed bootstrap).
- Test the full pipeline locally where possible (`tauri build`) and via `workflow_dispatch` on the release workflow.
- Add a GitHub release template or `RELEASE.md` notes mentioning signed installers and planned future auto-updates.
- Reference the new `docs/RELEASE_SIGNING.md` guide.
- **Explicitly deferred to pre-1.0:** Any "Check for updates" button, in-app update UI, or calls to the updater JS API (`check()`, `downloadAndInstall()`).

#### 1.7 CI Polish
- Keep debug builds unsigned/fast in `ci.yml`.
- Add a separate "Release build validation" workflow (on workflow_dispatch or tag) if needed.
- Update build matrix if Linux is added later.

### Files to Modify
- `package.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`
- `src-tauri/tauri.conf.json`
- `.github/workflows/release.yml` (primary)
- `.github/workflows/version.yml` (minor, for changelog)
- New: `cliff.toml` (if using git-cliff) or changesets config tweak
- `README.md`, `docs/SPRINT_PLAN_0.3.md` (mark complete), and a short `docs/RELEASE_PROCESS.md` if desired
- (No changes to `src/routes/+page.svelte` for this milestone — update UI deferred)

### Risks & Mitigations
- Signing with self-signed certs: Use repository secrets for the PFX/certificate. Self-signed will trigger Windows SmartScreen and macOS "unidentified developer" warnings initially. This is acceptable to bootstrap the pipeline. Document the limitation and plan for proper EV/Developer ID certs later.
- macOS notarization: Can be skipped or run optionally in the first iteration when using self-signed. Use `xcrun notarytool` when real certs are available.
- Updater endpoint security: Use GitHub releases (the artifacts themselves are signed with the Tauri key).
- Breaking changes to release process: Use `workflow_dispatch: true` on the release workflow for safe testing of tag-less runs.
- Secrets & contributor experience: See `docs/RELEASE_SIGNING.md` (local cert generation) and the new `docs/GITHUB_RELEASE_BUILDS_SETUP.md` (exact GitHub repo settings, secrets, permissions, and testing steps). Start with self-signed to unblock 0.3 releases.

### Verification (CI/CD focus)
- Create a test tag (e.g. `v0.3.0-test`) or use `workflow_dispatch` → the release workflow produces:
  - Signed installer bundles using self-signed certificates (Windows .exe/.msi and macOS .app/.dmg).
  - Updater metadata files (`latest.json` + `.sig`) attached to the GitHub release.
- Bundles contain the `plugins.updater` configuration (pubkey + GitHub endpoints).
- Changelog is populated.
- No "Check for updates" UI or runtime calls are added in this milestone.

---

## 2. Purview SDK Governance Memo (Item 0c)

### Current State
- No `docs/PURVIEW_GOVERNANCE.md` exists.
- Flint already produces rich local audit/access logs (see `sidecar/foundry-sidecar.js`: `audit()`, `appendAccessLog()`, disk logs in `~/.flint/logs/`).
- Events include: model download/load/unload/delete, service start/stop, setLogLevel, plus access entries (tokens, duration, ok status).
- No existing telemetry export or compliance integration.

### Deliverable
A ~2-page design memo (not implementation). Use Markdown with clear sections.

### Recommended Memo Outline (follow spec exactly)
```markdown
# Purview SDK Governance Memo for Flint

## 1. Background
- What Flint is (local AI desktop for Foundry Local).
- Current audit surface (list key events from code).
- Enterprise need: governance for local model usage (compliance, audit, data flow).

## 2. Purview Ingestion Path Recommendation
- **Preferred:** Microsoft Purview Unified Audit Log (via Microsoft 365 / Entra-integrated app) or the new Purview SDK for .NET / custom ingestion.
- Alternatives evaluated:
  - Activity Log API (good for Azure resources, less for desktop events).
  - Audit log (Premium/Standard) — best fit for user/admin actions.
  - Information Protection labels + DLP (for sensitive data classification if users load private docs).
- Rationale: Unified audit log supports custom apps; pay-as-you-go for non-MS AI; searchable/exportable.

## 3. Metadata Schema for Flint Events
Proposed events (no PII/prompt content by default):
- `ModelLoad`, `ModelUnload`, `ModelDownload`, `ModelDelete`
- `ServiceStart`, `ServiceStop`
- `EndpointAccess` (alias, variantId, tokensIn/Out, durationMs, success, timestamp)
- `InferenceRequest` (aggregated, no content)
- Session: start/stop, duration.

Fields: ts, eventType, appVersion, modelAlias, accelerator, tokensIn, tokensOut, success, endpointBind (sanitized), sessionId (opaque).

## 4. Opt-in UX
- Settings > Enterprise / Compliance section (behind "Advanced" or feature flag).
- Toggle: "Enable Microsoft Purview audit logging (enterprise)".
- On enable: Shows "No prompts or responses are sent. Only metadata (model usage, errors, config) is reported."
- Confirmation dialog + link to privacy note.
- Once enabled: Background export (via Purview SDK or log shipper) of selected audit entries.
- Disable anytime; clear local buffers if needed.

## 5. Constraints & Guardrails
- OFF by default.
- Machine-level policy / admin override (registry or config file) to force on/off.
- Never send raw prompts, responses, or user data.
- No PII (filenames → extensions only — already done for transcription).
- Rate limiting + local buffering.
- Opt-in telemetry respects existing `~/.flint` privacy posture.
- Scope limited to 0.4+ implementation.

## 6. Open Questions / Next Steps
- Exact ingestion method (direct SDK vs log forwarder).
- Retention & export UI.
- Integration with existing access/audit log.
```

### Steps to Create
1. Gather exact event list (use `grep` on sidecar + sdk for `audit`, `appendAccessLog`, `getAccessLog`).
2. Research latest Purview (see notes from 2026 docs: unified audit, SDK for developers, pricing per record for non-MS AI apps, Copilot/Github integration precedent).
3. Write concise memo in `docs/PURVIEW_GOVERNANCE.md`.
4. Cross-link from `RELEASE_ROADMAP.md`, `SPRINT_PLAN_0.3.md`, and README (Enterprise section).
5. No code changes (pure design).

### Risks
- Scope creep into implementation — strictly forbid.
- Terminology accuracy — reference official Microsoft docs.

### Verification
- Memo reviewed (peer + any security/compliance stakeholder).
- ~2 pages when rendered.
- All 4 required topics covered.

---

## 3. Feature Completion: Vision Multi-Image + Drag-and-Drop + Model Comparison (Items C & D)

These were pulled from 0.4 because model pool enables them. They are the last major UX gaps per success criteria.

### 3A. Vision: Multi-Image + Drag-and-Drop (Item C)

#### Current State (Important)
- `let attachedImage: string | null = $state(null);` (single image only).
- UI button + checkmark only for `isVisionModel` (currently a crude name heuristic).
- `attachImage()` uses hidden file input and reads a single Data URL.
- `clearImage()`.
- **Critical gap:** The image is never sent. `getMessagesForInference()` / `normalizeForAlternatingChat()` always produce string `content`. Sidecar `toSdkMessages()` does `String(m.content ?? '')`.
- The SDK already exposes `getVisionModels()` (and the sidecar has filtering logic), but it is not used in the UI for gating.
- Single-image "support" is currently a non-functional UI stub.

#### Requirements (from plan)
- Up to **4 images** per message.
- Thumbnail strip with remove buttons.
- Drag-and-drop on chat input container.
- Extend clipboard paste.
- Gate on vision-capable model.
- Leave inline rendering in bubbles for later (just send the data).

#### Detailed Steps
1. **State change:** `let attachedImages: string[] = $state([]);` (array of data URLs).
   - Prefer the proper `getVisionModels()` API from the SDK (instead of the current name heuristic `isVisionModel`) for gating the attach UI.
2. **Update attach:**
   - Allow multiple files (remove the `disabled=!!attachedImage` guard or change it to support append).
   - Loop over selected files, read each as Data URL, push to the array (hard limit of 4).
3. **Thumbnail strip UI (in chat input area):**
   - Below/above the input: a flex row of small `<img>` previews (max-height ~60px) with a remove "X" button per image.
   - Show "X/4 images attached".
4. **Drag & drop:**
   - Attach `ondragover`, `ondragenter`, `ondrop`, `ondragleave` to the main chat input container.
   - On drop: filter for image files, read as Data URLs, append (respect limit).
   - Add visual feedback (e.g. dashed border highlight class).
5. **Clipboard paste enhancement:**
   - Hook into paste (or improve the existing handler): if clipboard items contain images, read them as Data URLs and append (do not replace existing ones).
6. **Message payload changes (critical):**
   - In `sendMessage`, construct user content as OpenAI vision format when images exist:
     ```ts
     let userContent: any = userContentText;
     if (attachedImages.length > 0) {
       userContent = [
         { type: "text", text: userContentText },
         ...attachedImages.map(url => ({ type: "image_url", image_url: { url } }))
       ];
     }
     chatMessages.push({ role: "user", content: userContent });
     ```
   - Immediately clear `attachedImages = []`.
7. **Inference & normalization updates:**
   - `getMessagesForInference()` and `normalizeForAlternatingChat()`: pass `content` through as-is (support string or array).
   - `estimateTokensForMessages()`: handle array content by summing text + a rough per-image overhead (document as approximate for 0.3).
8. **Sidecar update (`foundry-sidecar.js`):**
   - Change `toSdkMessages` to preserve the original content shape:
     ```js
     .map((m) => ({ role: m.role, content: m.content }))
     ```
   - The local SDK clients should handle the standard `[{type, text}, {type: 'image_url', ...}]` format for vision models.
   - Add a size guard (e.g. total decoded size) similar to audio handling.
9. **Clearing & UX:**
   - Clear attached images on send, on switching away from a vision model, on new chat / conversation change.
   - Disable the attach button when at limit or not a vision model.
10. **CSS & polish:** Extend `.vision-attach` styles for the thumbnail strip.
11. **Error handling:** Clear user-friendly messages for oversized files, too many images, or non-image drops.
12. **Testing:**
    - Manual with real vision models.
    - Verify both single and multi-image messages reach the model in correct format.
    - Regression test that plain-text chat is unaffected.

**Leave out (per plan):** Inline image previews in assistant/user bubbles (data URL already in history if we store the structured content).

### 3B. Model Comparison / Bake-off (Item D)

#### Current State
- No "compare" view, no side-by-side UI.
- Model pool fully supports concurrent models.
- `chatCompletion` (non-stream) and streaming both available.
- `poolStatus` / loaded models visible in Monitor.

#### Requirements
- New **Compare** tab (add to sidebar after Monitor or before Settings).
- Select 2–3 models (from currently loaded pool preferred; allow on-demand load).
- Single prompt.
- Parallel execution → side-by-side results.
- Per-result: alias, latency, token usage, markdown content, thumbs rating.
- Export as Markdown.
- Use sync `chatCompletion` for simplicity (plan allows).

#### Detailed Steps
1. **Navigation:**
   - Add `"compare"` to `type View`.
   - Add sidebar `<button>` for Compare (use a split-screen icon).
   - Keyboard: `Ctrl/Cmd+6` or similar (extend existing handler).
2. **State:**
   ```ts
   let compareSelected: string[] = $state([]); // aliases, max 3
   let comparePrompt = $state("");
   let compareResults: Record<string, { content: string; latencyMs: number; tokens?: number; rating?: 'up'|'down'|null }> = $state({});
   let isComparing = $state(false);
   ```
3. **Compare View UI:**
   - Header + "Select models (2-3)".
   - Checkboxes or pills from `state.models.filter(m => m.isCached || loaded)`.
   - "Load on demand" toggle or button that calls load for unselected.
   - Large prompt textarea + "Run Comparison" (disabled if <2 models or empty prompt).
   - Results grid (CSS grid 2 or 3 columns):
     - Card per model: header (model name + unload btn), latency badge, token badge, `<MessageRenderer>` for content, thumbs (clickable, toggle).
   - Export button (build markdown string with all responses + metadata → download).
4. **Run logic (`runComparison`):**
   - `isComparing = true`.
   - Use `Promise.allSettled` over selected models.
   - For each: `const start = Date.now(); const res = await chatCompletion(alias, [{role:'user', content: comparePrompt}], {...}); const latency = Date.now()-start;`
   - Store result + latency + (estimate tokens from response if available).
   - Non-stream preferred per plan.
   - Handle partial failures gracefully (show error in that column).
5. **Ratings:** Simple `compareResults[alias].rating = 'up'`. Persist to `localStorage` under compare key or just session (no sync per plan).
6. **Integration:**
   - Pull current loaded models from `state` / pool.
   - Optionally auto-select up to 3 recently used.
   - After compare, option to "Continue in Chat" with winner.
7. **Export:**
   ```markdown
   # Comparison: prompt...

   ## Model A (latency 1234ms, ~tokens)
   ...
   ```
8. **Polish:** Loading spinners per column, clear results button, limit enforcement.

### Shared for Features
- Update `type View` and nav consistently.
- Add to keyboard shortcuts handler.
- Ensure concurrent models don't break existing pool/monitor.
- Add basic error toasts.
- Update any persisted state if needed.

### Files to Modify (Features)
- `src/routes/+page.svelte` (main changes: state, UI, send logic, new view, handlers)
- `sidecar/foundry-sidecar.js` (toSdkMessages for vision)
- Possibly `src/lib/sdk.ts` (if extra helpers needed for structured content)
- `src/lib/message-rendering.ts` (future, leave mostly)
- CSS in the Svelte file
- Update sprint plan + success criteria

---

## Sequencing, Dependencies, Risks, Testing

### Recommended Order
1. **Purview memo** (independent, can be parallel, low risk, design work).
2. **Vision multi-image** (foundational for multimodal; fixes current stub; unblocks future work).
3. **Model comparison** (leverages pool + non-stream chat; good dogfood for pool).
4. **CI/CD** (last; needs stable product; signing requires external setup).

Parallel: Memo + Vision can start together. Comparison depends lightly on pool stability.

### Cross-Cutting
- Use existing patterns (localStorage persist, $state, sidecar commands).
- Update `docs/SPRINT_PLAN_0.3.md` success criteria as items complete.
- Bump version via changesets when merging.
- Add entries to CHANGELOG.md via the mechanism.

### Risks & Mitigations
- **Vision format change:** This touches the hot chat path. Update `toSdkMessages` carefully and add a regression test that plain-text messages continue to work unchanged.
- **Concurrency in comparison:** The pool supports it, but we should add basic safeguards (small stagger or respect pool limits) if GPU memory pressure appears.
- **Large base64 images:** Enforce limits early (total decoded size). Mirror the existing audio base64 guard.
- **CI signing:** Self-signed will trigger warnings. Document this clearly and plan migration to proper certs post-0.3.
- **Updater:** Needs GitHub release artifacts + a public key. The key must be kept safe.
- **Vision model detection:** Prefer `getVisionModels()` over heuristics.
- **No real vision models in test env:** Rely on catalog filtering + manual testing notes.
- **Testing surface:** Prioritize happy paths + one regression test for message shape.

### Testing & Verification Strategy
- **Unit / Contract:**
  - Message normalization and token estimation for both string and array content.
  - Add/update a sidecar test that exercises vision-shaped messages.
- **Use existing helpers:** Wire and test `getVisionModels()` for UI gating.
- **Manual verification checklist:**
  - Vision: 1–4 images via button / drag-and-drop / paste with a real vision model.
  - Plain text chat is unaffected after the content format change.
  - Comparison: 2–3 models respond side-by-side, metrics are shown, export works, ratings persist in session.
- **CI / Release:**
  - After changesets version bump + features, create a test tag and verify signed bundles + `latest.json` appear.
- **General:** Run `npm run check`, full test suite, and `npm run tauri:build` (debug) after each major chunk.
- Success criteria from `SPRINT_PLAN_0.3.md` should be ticked off as each area is verified.

### Documentation Updates
- `docs/SPRINT_PLAN_0.3.md` (mark done)
- `README.md` (mention new features + updater)
- `docs/PURVIEW_GOVERNANCE.md` (new)
- `.github/copilot-instructions.md` (add notes for vision content format, compare state)
- Release notes in future tags.

---

## Exit Criteria Summary

When complete:
- Tag-driven **signed releases** (self-signed bootstrap) + updater metadata (`latest.json` etc.) in GitHub releases. Runtime "check for updates" UI deferred to pre-1.0.
- Purview memo published.
- Multiple images (≤4) attachable via button/drag/paste on vision models; sent correctly.
- Compare tab functional with 2-3 models, parallel results, export, ratings.
- All success criteria from SPRINT_PLAN_0.3.md satisfied or explicitly deferred.

This plan is actionable and can be broken into PRs (e.g. one per major section).
