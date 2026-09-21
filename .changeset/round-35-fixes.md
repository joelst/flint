---
"flint": patch
---

Benchmark exclusivity now also drains orphaned load/unload/delete operations, and downloads are fenced against active benchmark runs (blocked from starting while one is active, and vice versa).
