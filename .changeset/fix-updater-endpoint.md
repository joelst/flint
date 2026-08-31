---
"flint": patch
---

Fix the auto-updater never finding a new version. The endpoint resolved to the manifest attached to the release the user was already running, so every client reported "up to date"; it now points at the floating latest-release URL.
