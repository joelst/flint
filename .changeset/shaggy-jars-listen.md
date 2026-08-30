---
"flint": patch
---

Surface the real Azure Trusted Signing failure instead of Tauri's opaque `failed to run pwsh`. The sign command now logs detailed errors to `src-tauri/target/flint-signing.log`, and the release workflow runs a signing preflight check and publishes the log.
