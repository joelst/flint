# Development Guide

How to build, run, test, and version Flint locally.

For product overview and screenshots, see [README.md](../README.md).  
For release status and planning, see [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md).  
For signed release pipeline setup, see [RELEASE.md](./RELEASE.md).

---

## Prerequisites

- **Node.js** + npm
- **Rust** + Cargo (Tauri)
- Windows: Visual Studio Build Tools / MSVC for native builds

On Windows, install the WinML SDK variant for better acceleration:

```bash
npm run setup:winml
```

---

## Common commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm run tauri dev` | Dev app (hot reload + sidecar) |
| `npm run check` | Svelte/TS check |
| `npm run check:watch` | Watch mode type check |
| `npm test` | Vitest unit tests |
| `npm run test:coverage` | Tests + coverage |
| `npm run build` | Frontend web build only |
| `npm run tauri:build` | Package installers (msi/nsis/dmg) |
| `npm run verify:bundle` | Post-build bundle resource check |
| `npm run run:built` | Launch a release build without installing MSI |
| `cd src-tauri && cargo check` | Rust/Tauri compile check |

---

## Architecture (short)

- **Frontend:** Svelte 5 + SvelteKit SPA (`src/routes/+layout.ts` sets `ssr = false`). Most UI lives in `src/routes/+page.svelte`.
- **SDK boundary:** `src/lib/sdk.ts` — do not import Foundry Local directly into the web bundle.
- **Sidecar:** `sidecar/foundry-sidecar.js` speaks JSON-lines over stdio; Rust/Tauri is intentionally thin.
- **Vite** externalizes `foundry-local-sdk`, `foundry-local-sdk-winml`, and Node builtins so the web bundle stays buildable.

When adding sidecar commands: update **both** `src/lib/sdk.ts` (and IPC contracts if applicable) and `sidecar/foundry-sidecar.js`.

### Why a sidecar?

Direct use of `foundry-local-sdk` from the Svelte frontend hits bundling limits (Node core modules externalized; native prebuilts/DLL resolution). The JS sidecar is the current production path for rapid iteration. A self-contained Rust (or packaged) sidecar would remove the **end-user Node.js on PATH** requirement.

The sidecar emits `{ "ready": true }` after listener setup and lazy-loads the SDK on first `init`. Production resolution uses `resolveResource` + `cwd` + `NODE_PATH`. Stderr is captured; init timeout is 10s.

---

## Running a production build

```bash
npm run tauri:build
npm run verify:bundle
```

- **Dev:** `npm run tauri dev`
- **Test release exe without MSI:** `npm run run:built` or `scripts\run-built.bat`
- **Distribute:** MSI/NSIS under `src-tauri/target/release/bundle/`

---

## Versioning & changesets

App version lives in **three** places and must stay in sync:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

Workflow:

1. Make code changes.
2. `npm run changeset` — choose patch/minor/major and a short summary.
3. Commit the generated `.changeset/*.md` with the PR.
4. CI fails PRs that change code without a changeset (docs-only may be exempt depending on CI rules).
5. `npm run version` runs `changeset version` and `scripts/sync-versions.cjs`.
6. Releases: push a `v*` tag (release workflow builds installers). See [RELEASE.md](./RELEASE.md).

---

## Icons

```powershell
pwsh .\scripts\flint-icon-generator.ps1 -SourceImage .\static\flint-master-1024.png -RepositoryRoot .
```

Updates `static\` and `src-tauri\icons\` (including `.ico`). SVG generation is intentionally excluded (was producing raster-wrapped output).

---

## Model pool spike (optional)

Empirical co-residency / HTTP routing tests for multi-model load:

- Protocol: [POOL_SPIKE.md](./POOL_SPIKE.md)
- Script: `sidecar/scripts/pool-spike.mjs`
- Canonical result: [pool-spike-results](./pool-spike-results/)

---

## UI / state conventions

- Svelte 5 runes (`$state`, `$derived`, `$effect`) in `+page.svelte`.
- Chat persistence: `localStorage` key `flint-chat-persist`.
- STT/vision filtering is metadata-driven (`task`, `capabilities`, aliases) — avoid hardcoded model family lists.
- Diagnostics and Integrations surface the local OpenAI-compatible endpoint; keep them aligned with sidecar service state.

AI/coding-agent conventions: [`.github/copilot-instructions.md`](../.github/copilot-instructions.md).
