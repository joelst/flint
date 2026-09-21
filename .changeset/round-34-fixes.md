---
"flint": patch
---

Fixed benchmark runs being able to overlap leftover inference from a previous run after a reload, which could corrupt benchmark timing results; fixed a benchmark export that could fail if the download hadn't started yet.
