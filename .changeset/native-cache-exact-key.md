---
"flint": patch
---

Builds no longer reuse a cached Foundry native runtime from a different SDK version; the CI cache is keyed to the exact lockfile.
