# Flint Changelog

## 0.4.2

### Patch Changes

- 9496298: Fix Azure OIDC-based Windows signing by pinning the release job to the stable GitHub environment `release`, preflighting the OIDC subject, and supporting stable-branch rebuilds of existing tags.

## 0.4.1

### Patch Changes

- 5fdf366: Integrate Windows release code signing with Azure Trusted Signing private trust.
- e8a7c81: Fix release workflow failing on non-strict-semver tags (e.g. `v0.4-mvp`) by normalizing a missing patch component to `0` before validating and syncing the version across `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
- a6a7e51: Add mocked Pester coverage for the Azure Trusted Signing invocation path.

## 0.4.0

### Minor Changes

- 814c3af: Bundle Node 22 for the Foundry JS sidecar in release builds (Tauri externalBin; PATH Node remains a dev fallback). Ship Help/first-run coach, empty-state CTAs, and About strip. Document optional control CLI as non-goal for 0.4; regenerate package-lock for npm ci on Node 22.

## 0.3.4

### Patch Changes

- 631a81f: Remove unsupported x86_64-apple-darwin (Intel macOS) target from the release build matrix. Foundry Local SDK does not publish native cores for darwin-x64, which caused the release build to fail intentionally rather than ship a broken sidecar.

## 0.3.3

### Patch Changes

- f16d761: 0.3.2: package Foundry natives in installers as Flint.exe, fix production sidecar resolution and service rebind on network Apply & restart, and confirm non-loopback bind settings.

## 0.3.1

### Patch Changes

- c413a91: Add acceleration-aware notifications for newer downloaded model variants.
- 724eecf: Fix release build failure by using platform-specific bundle targets (msi/nsis on Windows, dmg/app on macOS) and enabling updater artifacts via `createUpdaterArtifacts` in the Tauri config.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are normally produced via [Changesets](https://github.com/changesets/changesets) (`npm run changeset` → Version Packages PR).

## [Unreleased]

### Added

- (Changesets will populate entries here when Version Packages PRs are merged.)

## [0.3.0]

### Added

- **Model pool** — concurrent multi-model load with variant-ID HTTP routing; pool visible in Monitor.
- **Monitor** — live pool table, resource gauges, access log, audit export (CSV/JSON).
- **Access log + audit trail** — ring buffer + `~/.flint/logs/` rotation; audit entries for destructive/config sidecar commands.
- **Network config** — configurable bind address and port in Settings (loopback default; warning for non-loopback).
- **Keyboard shortcuts** — view navigation, new chat, send, push-to-talk, `?` reference panel.
- **Autostart + defaults** — OS login-item toggle; default chat/audio model pre-selection.
- **Vision** — multi-image attach (up to 4), thumbnails, paste and drag-and-drop.
- **Model comparison** — side-by-side bake-off, ratings, markdown export.
- **Model update notifications** — detect newer catalog versions for each downloaded acceleration-specific variant and provide a direct update download.
- **Integrations** — data-driven OpenAI-compatible tool snippets with OS toggle and copy.
- **Host-aware chat context** — compact identity every turn; expanded fact sheet when the user asks about Flint/Foundry.
- **Guarded web-fetch → chat context** — user-initiated URL fetch with SSRF/size limits and article extraction.
- **Purview governance memo** — design-only (`docs/PURVIEW_GOVERNANCE.md`).
- **Release pipeline scaffolding** — updater plugin hooks, signing workflow steps (self-signed bootstrap).
- **Node.js preflight** — check Node 22+ on PATH before starting the JS sidecar (security-supported floor); actionable install guidance when missing or too old.
- **Docs consolidation** — living docs index, DEVELOPMENT/RELEASE guides, archived historical plans, backlog for deferred items.

### Changed

- README and design spec aligned to 0.3 status; honest prerequisites (bundled Foundry runtime; Node required for sidecar).

### Notes

- Version was bumped to 0.3.0 across package manifests; this section records shipped scope for the tag. Updater pubkey and code-signing secrets remain release-operator steps (see `docs/RELEASE.md` and `RELEASE_ROADMAP.md`).

## [0.2.0]

### Minor Changes

- Setup Changesets for PR-driven versioning. New pull requests must now include a changeset (via `npm run changeset`) so that they drive the next app version bump across `package.json`, `tauri.conf.json`, and `Cargo.toml`. Added sync script, CI enforcement, and GitHub Action to manage Version Packages PRs.

## [0.1.0] - Initial

- Initial Flint MVP.
