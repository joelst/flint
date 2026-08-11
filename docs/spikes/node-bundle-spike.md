# Spike A — Bundled Node runtime

**Status:** **Go** (packaging + N-API proven 2026-08-10). Optional residual: clean-machine install dogfood with Node uninstalled.  
**Date opened:** 2026-08-06 · **Closed (go):** 2026-08-10

## Goal

End-user installers run `foundry-sidecar.js` without Node on PATH.

## Approach

| Piece | Choice |
|---|---|
| Binary source | Official nodejs.org dist (pinned Node **22.18.0** via `NODE_BUNDLE_VERSION`) |
| Packaging | Tauri **`externalBin`**: `binaries/node` |
| Stage script | `npm run ensure:node` → `scripts/ensure-bundled-node.cjs` |
| Smoke | `npm run smoke:node` → version + `FoundryLocalManager.create` under staged binary |
| Spawn | `Command.sidecar('binaries/node', [script])` preferred; PATH `node` fallback |
| Capabilities | Both `binaries/node` (sidecar) and PATH `node` allowed |

## Files

- `scripts/ensure-bundled-node.cjs`, `scripts/smoke-bundled-node.cjs`
- `src-tauri/tauri.conf.json` (`externalBin`, `beforeBuildCommand`)
- `src-tauri/capabilities/default.json`
- `src/lib/sidecar-paths.ts`, `node-runtime.ts`, `sdk.ts` (+ tests)
- `scripts/verify-bundle.cjs`
- `docs/DEVELOPMENT.md`, README / USER_GUIDE / Help copy (bundled-first)

## Prove checklist

| # | Check | Result |
|---|---|---|
| 1 | `npm run ensure:node` stages binary + `node.VERSION` | ✅ 81.3 MB, v22.18.0 |
| 2 | Unit tests (path helpers + messages + fact sheet) | ✅ 40 passed |
| 3 | `tauri:build` packages Node + Foundry; `verify:bundle` | ✅ MSI/NSIS produced; verify passed |
| 4 | N-API / SDK load under bundled Node | ✅ `npm run smoke:node` — manager create ok |
| 5 | Installer size delta | ✅ MSI **~24 → 54.3 MB**; NSIS **~17 → 37.6 MB** (vs 0.3.1 artifacts on disk) |
| 6 | Clean machine (Node uninstalled) full chat | ⬜ Manual residual (not blocking **go**) |

## Overrides

- Build-time: `VITE_FLINT_NODE_RUNTIME=auto|bundled|path`
- Version pin: `NODE_BUNDLE_VERSION=22.18.0`
- Target: `npm run ensure:node -- --target x86_64-pc-windows-msvc`

## Go / no-go

| Result | Meaning |
|---|---|
| **Go** ✅ | Staging, smoke N-API, release package with `node.exe` sidecar, size acceptable (~+30 MB MSI / ~+20 MB NSIS compressed) |
| Residual | Dogfood install with PATH stripped; CI may need `ensure:node` cache |

### Build note

`tauri:build` on this machine completed MSI + NSIS; process exit code 1 only from missing `TAURI_SIGNING_PRIVATE_KEY` (updater artifacts) — unrelated to Node bundling. Use `build-local.ps1` for MSVC/SignTool PATH on Windows.

## Follow-ups (not spike blockers)

- Clean-machine dogfood checklist item in PRODUCT_PLAN C3
- CI: stage Node before `tauri build` on Windows/macOS arm64
- Optional: strip unused Node locales / use smaller runtime if size becomes an issue
