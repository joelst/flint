---
"flint": patch
---

Fix release build failure by using platform-specific bundle targets (msi/nsis on Windows, dmg/app on macOS) and enabling updater artifacts via `createUpdaterArtifacts` in the Tauri config.
