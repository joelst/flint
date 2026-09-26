---
"flint": patch
---

The gateway now refuses non-multipart `/v1/audio/transcriptions` requests, so clients can no longer make Foundry decode arbitrary local file paths.
