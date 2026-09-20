---
"flint": patch
---

Extract Benchmark Preview's priority-lease logic (pinning target models during a run and restoring priorities after) into a tested `src/lib/benchmark-priority-lease.ts` module, addressing a review note that it was previously untested inside `+page.svelte`.
