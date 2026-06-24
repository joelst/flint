y

**Date:** 2026-06-24
**Target:** Reach 70-80% MVP readiness (4 critical features)
**Architecture:** Tauri 2 + Svelte 5 + TypeScript + Sidecar pattern

---

## Overview

This plan details the completion of 4 critical MVP features:
1. **Complete Models Page** (Phase 1)
2. **Polish Chat UI** (Phase 2)
3. **Complete Audio UI** (Phase 3)
4. **Diagnostics MVP** (Phase 4)

**Key Constraint:** All heavy operations flow through the sidecar (`foundry-sidecar.js`); frontend is strictly UI-focused.

---

## Phase 1: Complete Models Page

**Goal:** Let users browse, search, download, load/unload, and manage cached models without terminal.

**Status:** ~40% done (list + basic model functions exist; need UI polish + modal + progress)

### 1.1 Models Grid/Table Layout

**Component:** `src/routes/+page.svelte` → new `<section>` for models view

**Tasks:**
- [ ] Create responsive grid layout (4-6 columns on desktop, 1-2 on mobile)
- [ ] Render model cards with:
  - Model alias (bold, prominent)
  - Family / category badge (chat, audio, multimodal)
  - Size badge (e.g., "2.1 GB", "tiny", "base")
  - Hardware recommendation badge (CPU / GPU / NPU)
  - Current status indicator (cached ✓ / loading... / not cached)
  - Quick action buttons (see 1.2)
- [ ] Add search box (filter by alias / family) — already partially done
- [ ] Add sort/filter dropdown:
  - By size (small → large)
  - By type (chat, audio, multimodal)
  - By cached status (cached first, then all)
  - By recommended status (hardware-optimized first)

**Estimate:** 2-3 hours (Svelte styling + grid layout)

**Dependencies:** None (SDK already lists models)

---

### 1.2 Model Detail Modal / Side Panel

**Component:** New component `src/lib/ModelDetailPanel.svelte`

**Tasks:**
- [ ] Create modal/side panel that shows (on card click or dedicated button):
  - Model alias & full name
  - Description (from SDK model.info)
  - Size in MB
  - Supported tasks (chat, audio, vision)
  - Hardware recommendations (CPU / GPU / NPU optimal)
  - Download button → triggers 1.3
  - Load button (if cached) → toggle load/unload
  - "Test in Chat" quick action → switches to chat view + sets current model
  - Remove from cache button (if cached)
- [ ] Show model metadata in structured table or list
- [ ] Close button / click outside to dismiss

**Estimate:** 2-3 hours

**Dependencies:** 1.1 (grid layout), model data already available from SDK

---

### 1.3 Download Progress Bar & Error Handling

**Component:** Extend `src/lib/sdk.ts` + UI feedback in models grid

**Tasks:**

**Sidecar Side (foundry-sidecar.js):**
- [ ] Enhance `download` command to emit progress messages:
  ```json
  { "type": "progress", "alias": "...", "percent": 45, "bytesDownloaded": 123456, "totalBytes": 1000000 }
  ```
- [ ] Emit error messages on download failure:
  ```json
  { "type": "error", "alias": "...", "message": "Network timeout", "code": "TIMEOUT" }
  ```
- [ ] Support cancel via abort signal passed from UI

**Frontend Side:**
- [ ] Modify `downloadAndTrack()` in `+page.svelte` to listen for progress events from sidecar
- [ ] Display overlay progress bar on model card during download:
  - Percent complete
  - MB downloaded / total MB
  - Cancel button (sends abort signal)
- [ ] Handle errors gracefully:
  - Show toast notification ("Download failed: network error. Retry?")
  - Retry button that re-triggers download
  - Disable download button while in progress

**Estimate:** 3-4 hours (sidecar + UI progress tracking)

**Dependencies:** Sidecar progress emission (may need to wire up in sidecar; check foundry-local-sdk progress callback)

---

### 1.4 Cache Management

**Component:** New `src/lib/CachePanel.svelte` or dedicated tab in models view

**Tasks:**
- [ ] Display list of cached models with:
  - Model alias
  - Size on disk (MB / GB)
  - Last accessed date (if available)
  - "Remove" button
- [ ] Show total cache size (sum of all cached models)
- [ ] "Clear all cache" button with confirmation
- [ ] "Open cache folder" button (opens file manager via Tauri)
- [ ] Cache size estimation tooltip ("Removing will free ~2.1 GB")

**Sidecar Integration:**
- [ ] Add sidecar command `clearCache` / `removeFromCache(alias)`
- [ ] Implement in sidecar (use foundry-local-sdk or CLI)

**Frontend:**
- [ ] Hook remove/clear actions to sidecar
- [ ] Refresh model list after removal
- [ ] Show success toast

**Estimate:** 2-3 hours

**Dependencies:** Sidecar cache management commands, Tauri fs plugin (for open folder)

---

### 1.5 Models Page Summary

| Task                 | Effort           | Dependencies           | Blocker? |
| -------------------- | ---------------- | ---------------------- | -------- |
| Grid layout + search | 2-3h             | None                   | No       |
| Detail modal         | 2-3h             | Grid layout            | No       |
| Download progress    | 3-4h             | Sidecar progress event | Possibly |
| Cache management     | 2-3h             | Sidecar commands       | No       |
| **Total**            | **~10-12 hours** |                        |          |

**Recommended Order:**
1. Grid layout (foundation)
2. Detail modal
3. Cache management (independent)
4. Download progress (depends on sidecar readiness)

---

## Phase 2: Polish Chat UI

**Goal:** Best-in-class chat experience with markdown, formatting, and conversation management.

**Status:** ~70% done (streaming works, messages display; need markdown + sidebar + polish)

### 2.1 Markdown Rendering for Responses

**Component:** `src/lib/MessageRenderer.svelte` (new) + chat view integration

**Tasks:**
- [ ] Install markdown renderer:
  - **Option A:** `marked` library (lightweight, ~30KB)
  - **Option B:** `remark` + `remark-html` (more flexible, ~50KB total)
  - Recommendation: `marked` for simplicity
- [ ] Parse assistant messages as markdown
- [ ] Render common markdown:
  - **Bold**, _italic_, `code`
  - Headings (# ## ###)
  - Lists (ordered + unordered)
  - Code blocks (with language highlighting via `highlight.js` or simple styling)
  - Links (clickable, open externally)
  - Tables (if model returns them)
- [ ] Sanitize HTML output to prevent XSS (use `DOMPurify` or trust marked's defaults)
- [ ] Apply CSS styling for nice typography:
  - Code blocks: monospace font, gray background, padding
  - Links: blue, underline on hover
  - Headings: larger font, dark color
  - Lists: bullet indentation, line height

**Estimate:** 2-3 hours (markdown lib + styling)

**Dependencies:** None (add npm dependencies)

---

### 2.2 Conversation Sidebar & List

**Component:** New `src/lib/ConversationSidebar.svelte`

**Tasks:**
- [ ] Left sidebar (collapsible on mobile) showing:
  - "New Chat" button at top
  - List of recent conversations (in-memory for MVP)
  - Each item shows:
    - First message (truncated)
    - Timestamp
    - Indicator for current chat (highlight)
    - Delete button (on hover)
- [ ] Clicking a conversation switches to it
- [ ] "New Chat" clears current messages + generates new session ID
- [ ] Store conversation list in localStorage (alongside existing PERSIST_KEY)

**MVP Scope:** In-memory conversations only (no file persistence yet; that's Phase 5)

**Estimate:** 2-3 hours

**Dependencies:** None (uses localStorage)

---

### 2.3 Message Formatting & UX Polish

**Component:** Refine message rendering in chat view

**Tasks:**
- [ ] User messages:
  - Right-aligned, light background
  - Show timestamp (optional, on hover)
  - Show "Edit" button on hover (stretch; not MVP)
  - Show "Copy" button on hover
- [ ] Assistant messages:
  - Left-aligned, subtle gray background
  - Show markdown-rendered content (from 2.1)
  - Show "Copy" button on hover
  - Show thinking/streaming indicator (dots animation)
- [ ] Improve input field:
  - Multi-line support (expand as user types)
  - Send on Ctrl+Enter (or Cmd+Enter on Mac)
  - "Send" button + "Stop generation" button (swap based on `isStreaming`)
  - Disabled state when model not loaded
- [ ] Auto-scroll chat to newest message during streaming

**Estimate:** 2-3 hours

**Dependencies:** 2.1 (markdown rendering)

---

### 2.4 System Prompt & Model Switcher

**Component:** Refine existing controls; move to persistent header/panel

**Tasks:**
- [ ] System prompt:
  - Move to collapsible "Settings" panel (top-right or side panel)
  - Show current system prompt + edit button
  - Persist to localStorage
- [ ] Model switcher:
  - Move to header (already partially there)
  - Show current model name + avatar badge
  - Dropdown to select model from cached list
  - Warn if model not cached ("Load model first?")
  - Switch mid-conversation (allowed, creates new client)

**Estimate:** 1-2 hours

**Dependencies:** None (refactoring existing code)

---

### 2.5 Chat UI Summary

| Task                     | Effort          | Dependencies       | Blocker? |
| ------------------------ | --------------- | ------------------ | -------- |
| Markdown rendering       | 2-3h            | npm packages       | No       |
| Conversation sidebar     | 2-3h            | localStorage       | No       |
| Message formatting       | 2-3h            | Markdown rendering | No       |
| System prompt / switcher | 1-2h            | None               | No       |
| **Total**                | **~8-11 hours** |                    |          |

**Recommended Order:**
1. Markdown rendering (foundation for nice output)
2. Message formatting (use markdown result)
3. Conversation sidebar (independent)
4. System prompt refactor (polish)

---

## Phase 3: Complete Audio UI

**Goal:** Record audio, select STT model, transcribe, display results.

**Status:** ~40% done (backend wired; need record button, waveform, results display)

### 3.1 Record Button & Microphone Access

**Component:** Enhance audio view in `+page.svelte`

**Tasks:**
- [ ] Large "🎤 Record" button (primary focus)
- [ ] Request microphone permissions on first click:
  - Use `navigator.mediaDevices.getUserMedia({ audio: true })`
  - Handle permission denied gracefully ("Enable mic in settings")
- [ ] Start MediaRecorder on click
- [ ] Show recording state:
  - Button changes to "⏹ Stop Recording" (red)
  - Timer shows elapsed time (00:12 format)
  - Waveform visualization (see 3.2)
- [ ] Stop recording, collect audio chunks into Blob

**Estimate:** 2-3 hours

**Dependencies:** None (browser APIs)

---

### 3.2 Waveform Visualization

**Component:** New `src/lib/WaveformCanvas.svelte`

**Tasks:**
- [ ] Create live waveform display during recording:
  - Use `AnalyserNode` from Web Audio API
  - Draw bars or line graph on HTML canvas
  - Update ~60 FPS during recording
  - Color: blue or teal
- [ ] Alternative (simpler): animated dots or bars that pulse to audio level

**Libraries:**
- Option A: Canvas only (lightweight, custom)
- Option B: `wavesurfer.js` (full-featured, ~60KB)
- Recommendation: Canvas for MVP (smaller footprint)

**Estimate:** 2-3 hours

**Dependencies:** None (Web Audio API built-in)

---

### 3.3 File Upload & Audio Selection

**Component:** Enhance audio view

**Tasks:**
- [ ] "Upload Audio File" button
- [ ] File picker (via Tauri `@tauri-apps/plugin-dialog` or browser File API)
- [ ] Accept formats: .mp3, .wav, .m4a, .flac, .ogg
- [ ] Display selected file info:
  - Filename
  - Duration (optional, requires audio metadata parsing)
  - Size in MB
- [ ] Allow user to switch between recorded and uploaded audio before transcribing

**Estimate:** 1-2 hours

**Dependencies:** Tauri dialog plugin or browser File API

---

### 3.4 STT Model Selection & Transcription

**Component:** Refine existing audio view

**Tasks:**
- [ ] Model selector dropdown:
  - Filter to only show STT models (Whisper family)
  - Show model size + language support
  - Warn if model not cached ("Load model first?")
- [ ] "Transcribe" button:
  - Disabled until model selected + audio ready
  - Shows loading state ("Transcribing...")
  - Calls sidecar `transcribe` command with audio blob + model alias
- [ ] Sidecar integration:
  - Pass audio blob to sidecar (base64 or as file via Tauri)
  - Call SDK `audioClient.transcribe(audioBuffer, language)`
  - Return transcription text + confidence (if available)

**Estimate:** 2-3 hours

**Dependencies:** Sidecar transcribe command wired properly, audio blob serialization

---

### 3.5 Results Display & Actions

**Component:** Audio view result section

**Tasks:**
- [ ] Display transcription result in large, readable text area
- [ ] Action buttons:
  - **Copy** (copy to clipboard)
  - **Append to Chat** (adds transcription as user message to current chat)
  - **Save as Text** (downloads .txt file via Tauri)
  - **Clear** (start new recording)
- [ ] Show transcription metadata:
  - Language detected (if SDK provides)
  - Confidence score (if available)
  - Processing time
- [ ] Error states:
  - "Model not loaded" → offer quick load
  - "No audio provided" → guide user
  - "Transcription failed" → show error message + retry

**Estimate:** 2-3 hours

**Dependencies:** Sidecar transcribe result, Tauri file save plugin

---

### 3.6 Audio UI Summary

| Task                         | Effort           | Dependencies      | Blocker? |
| ---------------------------- | ---------------- | ----------------- | -------- |
| Record button + permissions  | 2-3h             | Browser APIs      | No       |
| Waveform visualization       | 2-3h             | Web Audio API     | No       |
| File upload                  | 1-2h             | Tauri dialog      | No       |
| Model selection + transcribe | 2-3h             | Sidecar command   | Possibly |
| Results display + actions    | 2-3h             | Tauri file plugin | No       |
| **Total**                    | **~10-14 hours** |                   |          |

**Recommended Order:**
1. Record button (foundation)
2. Waveform viz (visual feedback)
3. Model selection + transcribe (core functionality)
4. Results display (user-facing output)
5. File upload (nice-to-have enhancement)

---

## Phase 4: Diagnostics MVP

**Goal:** Show service status, view logs, export diagnostic bundle.

**Status:** ~10% done (structure exists; need UI + functionality)

### 4.1 Service Status & Control

**Component:** New dedicated "Diagnostics" view in `+page.svelte`

**Tasks:**
- [ ] Status card showing:
  - Service running? (🟢 Running / 🔴 Stopped)
  - Local endpoint URL (e.g., `http://localhost:5272/v1`)
  - Uptime (if tracking)
  - Number of loaded models
  - Memory usage (optional, via SDK)
- [ ] Control buttons:
  - **Start Service** (if stopped)
  - **Stop Service** (if running)
  - **Restart Service**
  - Shows loading state ("Starting...")
- [ ] Sidecar integration:
  - Commands: `startService(port)`, `stopService()`, `restartService()`
  - Implement in sidecar (use foundry CLI or SDK)
  - Return status object with endpoint, uptime, etc.

**Estimate:** 2-3 hours

**Dependencies:** Sidecar service control commands

---

### 4.2 Log Viewer

**Component:** New `src/lib/LogViewer.svelte`

**Tasks:**
- [ ] Tabs: "App Logs" vs "Foundry Service Logs"
- [ ] **App Logs:**
  - Display messages from frontend (console errors, SDK events)
  - Use in-memory log buffer (store last 500 lines)
  - Console.log/error/warn → append to buffer
- [ ] **Foundry Service Logs:**
  - Read from `~/.foundry/logs/` (or get via sidecar)
  - Sidecar command: `getLogs(type: "app" | "service", lines: 100)`
  - Tail-like view: show last N lines + auto-scroll
- [ ] Features:
  - Filter by log level (DEBUG, INFO, WARN, ERROR)
  - Search box (filter lines by text)
  - "Refresh" button
  - "Clear logs" button (with confirmation)
  - Copy button (copy all visible logs)
- [ ] Styling:
  - Monospace font
  - Color-code by level (ERROR=red, WARN=yellow, INFO=gray, DEBUG=light gray)
  - Scrollable area (max height)

**Estimate:** 3-4 hours

**Dependencies:** Sidecar log retrieval command

---

### 4.3 Export Diagnostic Bundle

**Component:** "Export" button in diagnostics view

**Tasks:**
- [ ] Button: "Export Diagnostic Bundle"
- [ ] On click:
  - Collect:
    - App logs (from buffer)
    - Foundry service logs (from disk or sidecar)
    - System info (OS, Node version, Tauri version)
    - App config (current model, endpoint, settings)
    - Model catalog snapshot (list of available models)
  - Zip into file: `flint-diagnostics-${timestamp}.zip`
  - Save to `~/Downloads/` via Tauri fs plugin
  - Show success toast ("Exported to ~/Downloads/flint-diagnostics-...")
- [ ] Sidecar command:
  - `exportDiagnostics()` → returns zip buffer or file path
  - Collect logs, config, catalog metadata

**Estimate:** 3-4 hours

**Dependencies:** Sidecar export command, Tauri fs plugin, zip library (or use JS `zip.js`)

---

### 4.4 Endpoint Display & Copy

**Component:** Card or section in diagnostics view (could also be in Learn / header)

**Tasks:**
- [ ] Display:
  - **Endpoint URL:** `http://localhost:5272/v1` (large, monospace)
  - Status: "Ready" or "Starting..."
- [ ] Copy button (copies full URL to clipboard)
- [ ] "Test endpoint" button:
  - Makes GET request to endpoint (e.g., `/models`)
  - Shows result ("✓ Endpoint responding" or "✗ Failed")
- [ ] Collapsible section: "Ready-to-use configs for:"
  - **GitHub Copilot:** Pre-formatted JSON config
  - **Continue.dev:** Pre-formatted settings
  - **Cline / OpenClaw:** Pre-formatted API key setup
  - Each with "Copy" button

**Estimate:** 2-3 hours

**Dependencies:** None (simple UI + fetch request)

---

### 4.5 Diagnostics UI Summary

| Task                     | Effort           | Dependencies             | Blocker? |
| ------------------------ | ---------------- | ------------------------ | -------- |
| Service status & control | 2-3h             | Sidecar commands         | Possibly |
| Log viewer               | 3-4h             | Sidecar log retrieval    | No       |
| Export diagnostic bundle | 3-4h             | Sidecar export, Tauri fs | No       |
| Endpoint display & copy  | 2-3h             | None                     | No       |
| **Total**                | **~11-14 hours** |                          |          |

**Recommended Order:**
1. Service status (foundation)
2. Endpoint display (quick win, independent)
3. Log viewer (most complex UI)
4. Export bundle (uses logs from 3)

---

## Cross-Cutting Concerns

### Error Handling & User Feedback

**Apply to all phases:**
- Toast notifications for success/error (use Svelte store + component)
- Spinners/loaders during async operations
- Graceful fallbacks ("Model not cached? Try downloading first.")
- Empty states ("No conversations yet" / "No logs to display")

**Estimate:** 2-3 hours total (create reusable Toast + Spinner components)

### Styling & Typography

- **Fonts:** Use system defaults or load Poppins/Inter for modern look
- **Colors:** Light/dark mode support (toggle in settings)
- **Spacing:** Consistent margins/padding (use CSS custom properties)
- **Icons:** Use simple emoji or lightweight icon library (Lucide / Feather)

**Estimate:** 2-3 hours (define design system, apply throughout)

### Performance & Accessibility

- Lazy-load models grid (virtualize if >100 models)
- Keyboard navigation (Tab through buttons, Enter to send chat)
- ARIA labels on buttons and inputs
- Focus indicators visible

**Estimate:** 2-3 hours (audits + fixes)

---

## Dependency Graph & Blockers

```
Phase 1 (Models)
  ├─ 1.1 Grid layout [foundation]
  ├─ 1.2 Detail modal [depends on 1.1]
  ├─ 1.3 Download progress [depends on sidecar progress event] ⚠️ BLOCKER
  └─ 1.4 Cache management [depends on sidecar commands]

Phase 2 (Chat)
  ├─ 2.1 Markdown rendering [foundation]
  ├─ 2.2 Conversation sidebar [independent]
  ├─ 2.3 Message formatting [depends on 2.1]
  └─ 2.4 System prompt / switcher [independent]

Phase 3 (Audio)
  ├─ 3.1 Record button [foundation]
  ├─ 3.2 Waveform viz [independent, visual only]
  ├─ 3.3 File upload [independent]
  ├─ 3.4 Transcribe [depends on sidecar command] ⚠️ BLOCKER
  └─ 3.5 Results display [depends on 3.4]

Phase 4 (Diagnostics)
  ├─ 4.1 Service status [depends on sidecar commands] ⚠️ BLOCKER
  ├─ 4.2 Log viewer [depends on sidecar log retrieval] ⚠️ BLOCKER
  ├─ 4.3 Export bundle [depends on sidecar export] ⚠️ BLOCKER
  └─ 4.4 Endpoint display [independent]

Cross-Cutting
  ├─ Toasts & spinners [apply to all]
  ├─ Styling [apply to all]
  └─ A11y [apply to all]
```

**Critical Blockers:**
1. **Sidecar progress events** (Phase 1.3) — check if `foundry-local-sdk` emits progress in download
2. **Sidecar transcribe command** (Phase 3.4) — ensure audio client wired to sidecar
3. **Sidecar service control** (Phase 4.1) — implement start/stop/restart
4. **Sidecar log retrieval** (Phase 4.2) — implement log reading from `~/.foundry/logs/`
5. **Sidecar export** (Phase 4.3) — implement diagnostic bundle export

**Action:** Review `sidecar/foundry-sidecar.js` and add missing commands before starting blocked tasks.

---

## Summary & Effort Estimate

| Phase          | Tasks                 | Effort           | Status          |
| -------------- | --------------------- | ---------------- | --------------- |
| 1: Models      | 4 features            | ~10-12h          | 40% complete    |
| 2: Chat        | 4 features            | ~8-11h           | 70% complete    |
| 3: Audio       | 5 features            | ~10-14h          | 40% complete    |
| 4: Diagnostics | 4 features            | ~11-14h          | 10% complete    |
| Cross-cutting  | Toasts, styling, A11y | ~6-8h            | 0%              |
| **TOTAL**      |                       | **~45-59 hours** | **~40% of MVP** |

**Realistic Timeline:**
- **Full-time (8h/day):** 6-8 days
- **Part-time (4h/day):** 12-15 days
- **With sidecar unblocking:** Subtract 1-2 days

---

## Next Steps

1. **Immediate (next 1-2 hours):**
   - [ ] Review sidecar blockers; add missing commands
   - [ ] Create reusable Toast + Spinner components
   - [ ] Set up design system (CSS custom properties)

2. **Phase 1 (1-2 days):**
   - [ ] Complete models grid + search
   - [ ] Add detail modal
   - [ ] Implement cache management
   - [ ] Polish download progress (if sidecar ready)

3. **Phase 2 (1-2 days):**
   - [ ] Integrate markdown library
   - [ ] Refine message rendering
   - [ ] Add conversation sidebar
   - [ ] Polish system prompt controls

4. **Phase 3 (1-2 days):**
   - [ ] Record button + mic permissions
   - [ ] Waveform visualization
   - [ ] Transcribe integration (if sidecar ready)
   - [ ] Results display + export

5. **Phase 4 (1-2 days):**
   - [ ] Service status controls (if sidecar ready)
   - [ ] Log viewer UI + filtering
   - [ ] Diagnostic export
   - [ ] Endpoint display + snippets

6. **Finish (1 day):**
   - [ ] Cross-cutting polish (A11y, styling, error handling)
   - [ ] Testing on Windows + macOS
   - [ ] README screenshots + install guide
   - [ ] Release candidate build

---

## Success Criteria

MVP is "done" when:
- ✅ All 4 phases have visible, functional UI
- ✅ Models can be downloaded/loaded without terminal
- ✅ Chat streams responses with markdown formatting
- ✅ Audio can be recorded and transcribed
- ✅ Diagnostics show service status and logs
- ✅ No critical sidecar blockers remain
- ✅ App builds + runs on Windows and macOS
- ✅ README is updated with screenshots
- ✅ CI/CD pipelines pass

**Estimated MVP completion:** 2-3 weeks from today (depending on sidecar readiness)

---

**End of Plan**
