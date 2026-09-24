---
"flint": patch
---

Requests through the local endpoint that name a model alias, or a model that is not loaded yet, work again on Foundry Local 2.0.1: the gateway recognizes its not-loaded and not-found replies, loads the cached model, and replays under the loaded variant id. An explicit `:<version>` that is not cached is no longer served by another version.
