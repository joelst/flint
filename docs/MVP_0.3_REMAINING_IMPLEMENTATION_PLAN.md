# MVP 0.3 Remaining Implementation Plan

**Branch:** `mvp-0.3`  
**Date:** 2026-06-28  
**Status:** Draft for review  
**Goal:** Complete the three incomplete areas for MVP 0.3 exit so the release meets the success criteria in `docs/SPRINT_PLAN_0.3.md`.

## Overview of Incomplete Items

From `docs/SPRINT_PLAN_0.3.md`, the remaining work falls into these three categories:

1. **Item 6: CI/CD improvements** (core 0.3, P3)
2. **Item 0c: Purview SDK governance memo** (core 0.3, P3, design-only)
3. **Pulled 0.4 features still open** (Vision multi-image + Model comparison)

Many other 0.3 items (model pool, monitoring, autostart, network config, shortcuts, audit logging, etc.) are functionally complete based on recent commits and code inspection.

**Scope clarification (per feedback):** For CI/CD we will focus on making release builds produce **signed installers** and **updater-compatible artifacts** (using self-signed certificates to start). Full runtime "Check for updates" UI, auto-update experience, and user-facing update flows are deferred until just before the 1.0 release.

This plan provides **detailed, actionable steps**, current state analysis, file changes, sequencing, risks, testing, and verification for each.

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

**Success criterion (from plan):** "Signed build artifact produced on tag push; updater endpoint configured."

### Detailed Implementation Steps

#### 1.1 Add Tauri Updater Plugin (Foundation)
- Frontend: `npm install @tauri-apps/plugin-updater`
- Rust side:
  - Add to `src-tauri/Cargo.toml`:
    ```toml
    tauri-plugin-updater = "2"
    ```
  - In `src-tauri/src/lib.rs`: `.plugin(tauri_plugin_updater::Builder::new().build())`
- Capabilities: Update `src-tauri/capabilities/default.json`:
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

#### 1.3 Update tauri.conf.json for Updater
Add under root (or `plugins`):
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
- Also add `bundle > updater` if needed for old format (Tauri 2 prefers plugins).
- Ensure `bundle.active: true` and correct targets.

#### 1.4 Update Release Workflow for Updater Artifacts + Signing
Enhance `.github/workflows/release.yml`:

- After version set:
  - For updater: The tauri-action can produce the `latest.json` and signature when configured.
  - Add step to generate `latest.json` if action doesn't (use `tauri build --bundles updater` logic).
- Add signing:
  **macOS:**
  - Use `apple-actions/import-codesign-certs` + `xcrun notarytool`.
  - Secrets needed: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
  **Windows:**
  - Use `tauri-action` signing or explicit `signtool`.
  - Secrets: `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` (or Azure Trusted Signing for EV).
- In matrix jobs, conditionally sign based on OS.
- Upload release assets including signatures.
- Ensure tag push produces signed bundles + updater metadata.

Example addition (pseudocode):
```yaml
- name: Import Apple Certificate (macOS)
  if: matrix.os == 'macos-latest'
  uses: apple-actions/import-codesign-certs@v3
  with:
    p12-file-base64: ${{ secrets.APPLE_CERTIFICATE }}
    p12-password: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
```

- Update `tauri-action` call to include signing env vars and `releaseBody` improvements.

#### 1.5 Changelog Automation
- Option A (preferred, since we have changesets): Configure changesets to update `CHANGELOG.md` on version PR.
- Option B: Add `git-cliff` (as mentioned in plan).
  - Add `cliff.toml` config.
  - In release workflow (or version.yml): `git cliff --tag $VERSION > CHANGELOG.md`
- Commit changelog as part of release or version bump.
- Reference in release notes.

#### 1.6 Wiring + Polish
- Add a "Check for updates" button in Settings (using the updater plugin JS API: `check()`, `downloadAndInstall()`).
- Handle update UI (simple modal or toast) — keep lightweight per plan ("functional update check is enough").
- Update `README.md` and copilot-instructions with release process.
- Test locally with `tauri build` + manual `latest.json`.
- Add GitHub release template mentioning "Auto-updates via Tauri updater".

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
- `README.md`, `docs/SPRINT_PLAN_0.3.md` (mark complete)
- `src/routes/+page.svelte` (optional update UI in Settings)

### Risks & Mitigations
- Signing secrets: Use repository secrets + docs for contributors. Start with self-signed / test certs for Windows.
- macOS notarization delays: Use `notarytool` (faster than altool).
- Updater endpoint security: Use GitHub releases (signed with tauri key).
- Breaking changes to release process: Use `workflow_dispatch` for testing.
- Cost: Self-sign first; EV cert later.

### Verification
- Tag `v0.3.0` (or test tag) → signed artifacts appear + `latest.json` + signature.
- App can check + download update.
- Changelog populated in release.

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
- `let attachedImage: string | null = $state(null);`
- UI button + checkmark only for `isVisionModel` (name heuristics: vision/multimodal/phi).
- `attachImage()` uses hidden `<input type=file>`, reads single Data URL.
- `clearImage()`.
- **Critical gap:** `attachedImage` is **never** added to `chatMessages` or `inferenceMessages`. `getMessagesForInference()` and `normalizeForAlternatingChat()` produce only string `content`. Sidecar `toSdkMessages()` does `String(m.content)`.
- Sidecar has `getVisionModels` filter and audio base64 handling precedent, but vision chat content is text-only.
- Single image "support" is a UI stub only.

#### Requirements (from plan)
- Up to **4 images** per message.
- Thumbnail strip with remove buttons.
- Drag-and-drop on chat input container.
- Extend clipboard paste.
- Gate on vision-capable model.
- Leave inline rendering in bubbles for later (just send the data).

#### Detailed Steps
1. **State change:** `let attachedImages: string[] = $state([]);` (array of data URLs). Update `isVisionModel` usage.
2. **Update attach:**
   - Allow multiple files (remove `disabled=!!` or allow append).
   - `for` loop over `files`, read each as DataURL, push to array (enforce <=4).
3. **Thumbnail strip UI (in chat input area):**
   - Below/above input: flex row of small `<img>` (max-height 60px) + red X button.
   - Each image has remove handler: filter array.
   - Show count "3/4 images".
4. **Drag & drop:**
   - Add handlers to chat input container (`.chat-input` or equivalent):
     - `ondragover`, `ondragenter` (add highlight class).
     - `ondrop`: `e.dataTransfer.files`, filter images, read as dataurl, append (respect limit).
     - `ondragleave` remove highlight.
   - Visual drop zone hint when dragging (CSS).
5. **Clipboard paste enhancement:**
   - Existing paste probably works for first. Hook `paste` event or in existing handler:
     - If `items` contain image files, read them as dataurl and append to array (don't replace).
6. **Message payload changes (critical):**
   - In `sendMessage`, before pushing user message:
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
   - Clear `attachedImages = []` after push (before API call).
7. **Inference & normalization updates:**
   - `getMessagesForInference()`: Return content as-is (support array or string).
   - `estimateTokensForMessages()`: If content array, sum text parts + rough overhead per image (e.g. +500 tokens/image or use metadata).
   - `normalizeForAlternatingChat()`: Keep content as provided for vision messages (don't force string).
8. **Sidecar update (`foundry-sidecar.js`):**
   - Update `toSdkMessages`:
     ```js
     .map((m) => ({
       role: m.role,
       content: m.content  // pass array or string through
     }))
     ```
   - The Foundry SDK / OpenAI client should accept the standard vision content array when model supports it.
   - Add validation/size limit (reuse audio base64 idea; e.g. warn > few MB total).
9. **Clearing & UX:**
   - Clear images on send, on model change (if not vision), on new chat.
   - Disable attach when 4 images or streaming or non-vision.
10. **CSS:** Extend `.vision-attach` for strip (flex, small previews with border, hover X).
11. **Error handling:** File too large, too many, non-image.
12. **Testing:** Manual with vision model (e.g. qwen2-vl or phi-3-vision). Verify multi-image sent in correct format.

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
- **Vision format change:** Update toSdkMessages carefully; test with non-vision + vision models. Keep backward (string content still works).
- **Concurrency in comparison:** Pool already supports; add small delay or queue if GPU pressure.
- **Large base64 images:** Enforce limits early (e.g. 4MB total decoded per message). Mirror audio limits.
- **CI signing:** Requires org secrets + cert procurement. Plan for "unsigned release first, signed in follow-up".
- **Updater:** Requires GitHub release artifacts + public key rotation strategy.
- **No real vision models:** Use catalog filtering + note in docs.
- **Testing surface:** Focus on happy path + error cases manually + add 1-2 vitest cases for message normalization.

### Testing & Verification Strategy
- **Unit:** Message normalization + token estimation for arrays.
- **Integration (sidecar test):** Add vision message shape test.
- **Manual:** 
  - Vision: Attach 1→4 images with vision model → verify response references image content.
  - Drag/drop/paste.
  - Comparison: 2-3 models, same prompt, side-by-side, ratings, export.
- **E2E/CI:** Extend release validation to produce signed artifacts (once secrets ready).
- **Success criteria check:** Tick off in sprint plan once verified.
- Run full `npm run check`, tests, `npm run tauri:build` (debug) after each major piece.

### Documentation Updates
- `docs/SPRINT_PLAN_0.3.md` (mark done)
- `README.md` (mention new features + updater)
- `docs/PURVIEW_GOVERNANCE.md` (new)
- `.github/copilot-instructions.md` (add notes for vision content format, compare state)
- Release notes in future tags.

---

## Exit Criteria Summary

When complete:
- Tag-driven signed releases + functional updater.
- Purview memo publi