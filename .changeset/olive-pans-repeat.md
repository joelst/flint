---
"flint": patch
---

Pin the vulnerable `adm-zip` transitive dependency to `^0.6.0` via an npm override (GHSA-xcpc-8h2w-3j85) while keeping `foundry-local-sdk` on the 1.x line, whose `foundry-local-core/<platform>/` native layout Flint's sidecar loader and bundle verifier depend on.
