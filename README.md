# Flint — Foundry Local Interface (FLInt)

**Flint** (also styled FLInt) is a lightweight, desktop GUI for [Microsoft Foundry Local](https://github.com/microsoft/Foundry-Local).

It provides an intuitive interface for:

- Model catalog browsing/search/filter (STT-only for audio via metadata), hardware-aware recommendations, download/load/unload + progress, and WinML/accelerator preference support
- Chat (streaming) with conversation sidebar, persona selector, localStorage persisted history, system prompt controls, stop/cancel, and basic vision image support (emerging in SDK)
- Audio transcription (mic + file) using STT models with copy/download transcript actions
- Diagnostics with service controls, endpoint visibility/copy snippets, and active execution provider inventory
- Learn section + local endpoint
- Bundled runtime (sidecar eval for clean prod builds), first-run guidance

Everything runs locally on your device by default.

## Status

Flint is now at an **MVP 0.1-ready baseline** for dogfood/public-preview use:

- Models: catalog/search/filter + download/load/unload + model metadata details
- Chat: streaming + conversation UX + thinking-trace rendering + cancellation path + persona presets
- Audio: STT model selection + mic/file transcription + transcript copy/download
- Diagnostics: service controls + endpoint/snippet visibility + execution provider inventory
- Test baseline: unit + sidecar protocol tests + coverage gating

See release evaluation + roadmap: [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md)

## MVP 0.1 Interface

### Main window

![Flint main window](./images/flint-main-window.png)

### Model selection

![Flint model selection](./images/flint-model-selection.png)

### Chat window

![Flint chat window](./images/flint-chat-window.png)

### Known Limitations (0.1)

- Multi-endpoint orchestration is not implemented; most flows assume one active endpoint/model lane.
- Diagnostics export and cache operations are functional but not yet fully hardened/polished.
- Security posture is improved but not yet least-privilege complete (shell capability scope will be tightened in 0.2).
- Test coverage is foundational (good baseline), not full UI/E2E depth yet.
- Some audio features may not work as desired.

## Working Features (MVP 0.1)

### Models

- Browse and search local model catalog
- Metadata-driven model filtering (including STT-focused audio lane)
- Download/load/unload models with progress feedback
- Model details panel (task/context/capabilities)

### Chat

- Streaming assistant responses
- Conversation sidebar with persisted history
- Persona selector and editable system prompt
- "Thinking" trace rendering in chat responses
- Stop/cancel active generation
- Basic image attach flow for vision-capable models

### Audio

- Microphone transcription
- File transcription
- STT model selection
- Copy transcription text
- Download transcription text

### Diagnostics

- Sidecar/service status and controls
- Local endpoint display
- Copy-ready endpoint snippets
- Execution provider list and active provider visibility

### Testing & quality baseline

- `npm run check` static/type validation
- Vitest unit tests for core utilities
- Sidecar protocol smoke test
- Coverage thresholds in CI/dev test runs

## Tech

- Tauri 2 (Rust + WebView)
- Svelte 5 + SvelteKit + TypeScript
- `foundry-local-sdk` (primary) + `foundry` CLI (supporting)

## Getting Started (Development)

```bash
npm install
npm run tauri dev
```

**Prerequisites**

- Node.js + npm
- Rust + Cargo (for Tauri)
- The runtime is bundled in builds (no separate install needed for end users)

On Windows prefer the WinML variant for best acceleration:

```bash
npm run setup:winml
```

## Building & Packaging

```bash
npm run tauri:build
node scripts/verify-bundle.cjs
```

### Running the built app

- **During development**: `npm run tauri dev` (recommended, hot reload, uses sidecar)
- **Test a production build without installing the MSI**: `scripts\run-built.bat` (or `pwsh scripts/run-built.ps1`, or double-click the .exe in `src-tauri/target/release/`)
- **Distribute to users**: Use the generated MSI (`src-tauri/target/release/bundle/msi/Flint_*.msi`) or NSIS installer. These create proper Start Menu entries, uninstaller, etc.

See `.github/workflows/` for CI (PR checks + builds) and Release (tagged builds create GitHub releases with artifacts for Windows/macOS).

## Icon asset generation

To refresh app icon assets from a source image:

```powershell
pwsh .\scripts\flint-icon-generator.ps1 -SourceImage .\static\flint-master-1024.png -RepositoryRoot .
```

This updates icon assets in `static\` and `src-tauri\icons\` (including `.ico`).
SVG generation is intentionally excluded because it was producing raster-wrapped output rather than true vector artwork.

**Sidecar evaluation (for native SDK issues):**
Direct use of `foundry-local-sdk` (JS + native) from the Svelte frontend has bundling challenges:

- Vite externalizes Node core modules (`fs`, `url`, `module`, etc.) during `tauri build`.
- Native prebuilts + core DLLs are copied via resources, but resolution can fail in the final bundle.
- See `sidecar/foundry-sidecar.js` for a prototype stdio-based sidecar wrapper (JSON protocol). Use `@tauri-apps/plugin-shell` to spawn and communicate from frontend.

**Recommendation**: For production, evaluate moving logic to a **Rust sidecar** (or directly in `src-tauri` using the Rust `foundry-local-sdk` crate). This gives clean native bundling and no JS FFI headaches. Current JS approach is kept for rapid iteration per original design spec.

**Sidecar readiness**: The sidecar now emits `{ "ready": true }` immediately after listener setup and lazy-loads the SDK only on the first `init` command. `resolveResource` + `cwd` + `NODE_PATH` are used for robust script/SDK resolution in dev + prod bundles. Stderr is captured. Timeout is 10s.

**Note on distribution**: Because the sidecar runs `node <script>`, end users of built installers still need Node.js installed and on PATH. (A self-contained .exe sidecar via `pkg` or a Rust port would remove this.)

Run `npm run tauri:build` (may require full MSVC/Rust env) and `node scripts/verify-bundle.cjs`.

## Vision / Multimodal

- Added basic support in Chat: image attach (base64) when model alias suggests vision/multimodal.
- Messages use OpenAI-style content array for images.
- Helper `getVisionModels()` in SDK (based on task/capabilities).
- Full support is emerging in the local SDKs (chat models with vision capabilities exist in catalog like certain Phi/Qwen variants; image input via the compatible API). Currently best-effort; test with actual vision models. No dedicated vision tab yet.

## CI/CD

- PRs: Lint, checks, cross-platform debug builds
- Releases: Push `vX.Y.Z` tag → automated release with installers

## Design

- [FLINT_DESIGN_SPEC.md](./FLINT_DESIGN_SPEC.md)
- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)
- [MVP_FEATURE_COMPLETION_PLAN.md](./MVP_FEATURE_COMPLETION_PLAN.md)
- [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md)

## License

MIT

## Contributing

See the design spec for scope and roadmap.

---

Built to make Foundry Local approachable while staying true to its local-first roots.
