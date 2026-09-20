---
"flint": minor
---

Add a Benchmark Preview UI (opt-in, off by default) for measured, repeatable multi-model runs under Build, alongside Playground and Model Arena. Hardens the run lifecycle: target models stay pinned against eviction only for the run's duration, and a run is verified against its stored reservation before executing.
