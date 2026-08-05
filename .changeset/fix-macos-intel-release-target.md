---
"flint": patch
---

Remove unsupported x86_64-apple-darwin (Intel macOS) target from the release build matrix. Foundry Local SDK does not publish native cores for darwin-x64, which caused the release build to fail intentionally rather than ship a broken sidecar.
