# Development Guide

How to build, run, test, and version Flint locally.

For product overview and screenshots, see [README.md](../README.md).  
For release status and planning, see [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md).  
For signed release pipeline setup, see [RELEASE.md](./RELEASE.md).

---

## Prerequisites

- **Node.js 22+** + npm (needed to *build* Flint; release installers **bundle** a Node binary for the sidecar — Spike A)
- **Rust** + Cargo (Tauri)
- Windows: Visual Studio Build Tools / MSVC for native builds (use `build-local.ps1` if `cl.exe` / SignTool paths need wiring)

`npm install` runs the Foundry Local SDK install script, which downloads native core libraries into `node_modules/foundry-local-sdk/foundry-local-core/<platform>/`. Release builds also run `npm run ensure:node` and `npm run ensure:foundry` via Tauri `beforeBuildCommand`.

### Bundled Node runtime (Spike A)

End-user installers ship Node as a Tauri **externalBin** sidecar (`binaries/node`), so PATH Node is not required when the package is complete.

| Piece | Location |
|---|---|
| Stage script | `npm run ensure:node` → `scripts/ensure-bundled-node.cjs` |
| Binary (gitignored) | `src-tauri/binaries/node-<target-triple>[.exe]` |
| Version pin | `NODE_BUNDLE_VERSION` (default `22.18.0`) or `src-tauri/binaries/node.VERSION` after stage |
| App selection | Prefer bundled → fall back to PATH `node` (dev) |
| Override (build-time) | `VITE_FLINT_NODE_RUNTIME=auto\|bundled\|path` |

Dev without staging still works if Node 22+ is on PATH. For release/dogfood of “no PATH Node”:

```bash
npm run ensure:node
npm run smoke:node
# Windows local: use build-local.ps1 so cl.exe / SignTool are on PATH
npm run tauri:build
npm run verify:bundle
```

Spike A (2026-08-10): MSI ~**54 MB** / NSIS ~**38 MB** with bundled Node (~+30 / +20 MB vs pre-spike 0.3.1 artifacts). Details: [spikes/node-bundle-spike.md](./spikes/node-bundle-spike.md).

**CI:** `cargo check` and Tauri builds require `src-tauri/binaries/node-<triple>` to exist (`externalBin`). Workflows run `npm run ensure:node` after `npm ci` (see `.github/workflows/ci.yml` and `release.yml`).

`ensure:foundry` prefers the **build target**, not the host:

- Uses `TAURI_ENV_PLATFORM` / `TAURI_ENV_ARCH` / `TAURI_ENV_TARGET_TRIPLE` when set by `tauri build --target …`
- Overrides: `FOUNDRY_PLATFORM_KEY=darwin-arm64` or `npm run ensure:foundry -- --target aarch64-apple-darwin`
- When host arch ≠ target, it re-runs the SDK install script with patched `os.platform()` / `os.arch()` so the correct NuGet RID is downloaded

Supported Foundry core layouts today: `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `darwin-arm64` (no `darwin-x64` in current SDK).

---

## Common commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies (+ host Foundry native cores) |
| `npm run ensure:foundry` | Ensure Foundry cores for host or build target |
| `npm run ensure:node` | Download/stage bundled Node for Tauri externalBin |
| `npm run smoke:node` | Prove staged Node 22 + foundry-local-sdk native load |
| `npm run tauri dev` | Dev app (hot reload + sidecar) |
| `npm run check` | Svelte/TS check |
| `npm run check:watch` | Watch mode type check |
| `npm test` | Vitest unit tests |
| `npm run test:coverage` | Tests + coverage |
| `npm run build` | Frontend web build only |
| `npm run tauri:build` | Package installers (msi/nsis/dmg); runs ensure:node + ensure:foundry first |
| `npm run verify:bundle` | Post-build bundle resource check |
| `npm run run:built` | Launch a release build without installing MSI |
| `cd src-tauri && cargo check` | Rust/Tauri compile check |

---

## Architecture (short)

- **Frontend:** Svelte 5 + SvelteKit SPA (`src/routes/+layout.ts` sets `ssr = false`). Most UI lives in `src/routes/+page.svelte`.
- **SDK boundary:** `src/lib/sdk.ts` — do not import Foundry Local directly into the web bundle.
- **Sidecar:** `sidecar/foundry-sidecar.js` speaks JSON-lines over stdio; Rust/Tauri is intentionally thin.
- **Vite** externalizes `foundry-local-sdk` and Node builtins so the web bundle stays buildable.

When adding sidecar commands: update **both** `src/lib/sdk.ts` (and IPC contracts if applicable) and `sidecar/foundry-sidecar.js`.

### Local OpenAI-compatible endpoint

- **Bind address** (Settings → Network) controls which interface the service *listens* on (`127.0.0.1`, `0.0.0.0`, or a custom IP).
- **Client / Integrations URL** (`sharedEndpoint`) is always `http://127.0.0.1:<port>/v1` so this app and local tools connect over loopback even when the service is bound to all interfaces.
- Use **Apply & restart** after changing port or bind so the sidecar re-creates the Foundry manager with the new `webServiceUrls`.

### Why a sidecar?

Direct use of `foundry-local-sdk` from the Svelte frontend hits bundling limits (Node core modules externalized; native prebuilts/DLL resolution). The JS sidecar is the current production path for rapid iteration.

**Spike A (in progress):** ship a **bundled Node** binary via Tauri `externalBin` so end users need not install Node. A full Rust Foundry bridge remains the longer-term path to remove the Node *process* entirely (see PRODUCT_PLAN / BACKLOG).

The sidecar emits `{ "ready": true }` after listener setup and lazy-loads the SDK on first `init`. Production resolution uses `resolveResource` + `cwd` + `NODE_PATH`, and spawns `binaries/node` (bundled) or PATH `node`. Stderr is captured; init timeout is 10s.

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
