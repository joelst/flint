---
"flint": minor
---

Add a Benchmark Preview UI (opt-in, off by default) for measured, repeatable multi-model runs under Build, alongside Playground and Model Arena. Hardens the run lifecycle: target models stay pinned against eviction only for the run's duration, a run is verified against its stored reservation before executing, variant bindings are validated and durably persisted for correct Resume, validation errors are accurately diagnosed, concurrent starts of the same run can no longer double-dispatch, benchmark runs and Model Arena runs are mutually exclusive since both share the same model pool, and Models/Monitor/Arena load, unload, delete, and stop-and-unload controls are blocked while a benchmark run is active so its pinned targets can't be unloaded or replaced mid-run.
