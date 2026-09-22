---
"flint": patch
---

`embedTexts` now calls the non-deprecated `EmbeddingsSession` instead of `EmbeddingClient`; the returned shape (`data[].embedding`) is unchanged.
