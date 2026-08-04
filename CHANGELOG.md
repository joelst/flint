# Flint Changelog

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
