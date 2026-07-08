# Flint Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are normally produced via [Changesets](https://github.com/changesets/changesets) (`npm run changeset` → Version Packages PR).

## [Unreleased]

### Added

- (Changesets will populate entries here when Version Packages PRs are merged.)

### Notes

- App version may already read `0.3.0` in package manifests while this file awaits a reconciled **0.3.0** section (see [RELEASE_ROADMAP.md](./RELEASE_ROADMAP.md) ship checklist and [docs/BACKLOG.md](./docs/BACKLOG.md)).

## [0.2.0]

### Minor Changes

- Setup Changesets for PR-driven versioning. New pull requests must now include a changeset (via `npm run changeset`) so that they drive the next app version bump across `package.json`, `tauri.conf.json`, and `Cargo.toml`. Added sync script, CI enforcement, and GitHub Action to manage Version Packages PRs.

## [0.1.0] - Initial

- Initial Flint MVP.
