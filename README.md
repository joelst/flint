# Flint — Foundry Local Interface (FLInt)

**Flint** (also styled FLInt) is a lightweight, privacy-first desktop GUI for [Microsoft Foundry Local](https://github.com/microsoft/Foundry-Local).

It provides an intuitive interface for:
- Model catalog browsing/search/filter (STT-only for audio via metadata), hardware-aware recs, download/load/unload + progress, WinML/accelerators support
- Chat (streaming) with switcher, localStorage persisted history, system prompt, stop, basic vision image support (emerging in SDK)
- Audio transcription (mic + file) using only STT models (Whisper, Nemotron Speech Streaming, future via task/capabilities - no hardcodes)
- Learn section + local endpoint
- Bundled runtime (sidecar eval for clean prod builds), first-run guidance

Everything runs locally on your device by default.

## Status

MVP features largely implemented (models w/ STT filter, chat streaming+persist+stop+basic vision, audio STT-only). JS build clean (externalize). Sidecar prototype ready. Gaps: full diagnostics, snippets, polished first-run, sidecar runtime wiring. See IMPLEMENTATION_PLAN.md. Ready for 0.1.0-alpha check-in; full 0.1 after sidecar.

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
node scripts/verify-bundle.js
```

### Running the built app

- **During development**: `npm run tauri dev` (recommended, hot reload, uses sidecar)
- **Test a production build without installing the MSI**: `scripts\run-built.bat` (or `pwsh scripts/run-built.ps1`, or double-click the .exe in `src-tauri/target/release/`)
- **Distribute to users**: Use the generated MSI (`src-tauri/target/release/bundle/msi/Flint_*.msi`) or NSIS installer. These create proper Start Menu entries, uninstaller, etc.

See `.github/workflows/` for CI (PR checks + builds) and Release (tagged builds create GitHub releases with artifacts for Windows/macOS).

**Sidecar evaluation (for native SDK issues):**
Direct use of `foundry-local-sdk` (JS + native) from the Svelte frontend has bundling challenges:
- Vite externalizes Node core modules (`fs`, `url`, `module`, etc.) during `tauri build`.
- Native prebuilts + core DLLs are copied via resources, but resolution can fail in the final bundle.
- See `sidecar/foundry-sidecar.js` for a prototype stdio-based sidecar wrapper (JSON protocol). Use `@tauri-apps/plugin-shell` to spawn and communicate from frontend.

**Recommendation**: For production, evaluate moving logic to a **Rust sidecar** (or directly in `src-tauri` using the Rust `foundry-local-sdk` crate). This gives clean native bundling and no JS FFI headaches. Current JS approach is kept for rapid iteration per original design spec.

**Sidecar readiness**: The sidecar now emits `{ "ready": true }` immediately after listener setup and lazy-loads the SDK only on the first `init` command. `resolveResource` + `cwd` + `NODE_PATH` are used for robust script/SDK resolution in dev + prod bundles. Stderr is captured. Timeout is 10s.

**Note on distribution**: Because the sidecar runs `node <script>`, end users of built installers still need Node.js installed and on PATH. (A self-contained .exe sidecar via `pkg` or a Rust port would remove this.)

Run `npm run tauri:build` (may require full MSVC/Rust env) and `node scripts/verify-bundle.js`.

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

## License

MIT

## Contributing

See the design spec for scope and roadmap.

---

Built to make Foundry Local approachable while staying true to its local-first roots.

