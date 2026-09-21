---
"flint": patch
---

Benchmark exclusivity now also drains orphaned load/unload/delete operations left by a previous page instance. Same-page model downloads are now fenced against active benchmark runs (blocked from starting while one is active, and vice versa); this does not cover a download orphaned by a page reload.
