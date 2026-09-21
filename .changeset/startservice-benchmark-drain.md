---
"flint": patch
---

Drain an in-flight `startService` restart before a benchmark takes exclusive admission, so an orphaned pool clear/repopulate from a previous page instance can no longer race a new benchmark run.
