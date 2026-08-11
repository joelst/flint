---
"flint": patch
---

Fix release workflow failing on non-strict-semver tags (e.g. `v0.4-mvp`) by normalizing a missing patch component to `0` before validating and syncing the version across `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.
