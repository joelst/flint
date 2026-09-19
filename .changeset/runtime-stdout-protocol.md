---
"flint": patch
---

Protect the runtime protocol from dependency/native stdout noise so operations do not fail with invalid JSON frames.
Keep redirected sidecar diagnostics out of the error log, and show Starting… for every queued service start or restart.
