---
"flint": patch
---

Stop the sidecar from also echoing its ready message to stderr, which showed up in the SDK log panel as a spurious "error" entry on every startup even though nothing failed.
