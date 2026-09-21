---
"flint": patch
---

Bound the priority-restore and exclusive-release joins used when finishing a benchmark run so a stuck (unbounded-by-design) IPC reply can no longer strand the run forever, and fixed a tracking gap where a background retry could lose track of a still-in-flight release, risking it reopening gateway admission after a newer run had already acquired it.
