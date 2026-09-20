---
"flint": patch
---

Fix chat reasoning ("thinking") not collapsing for models whose chat template opens `<think>` in the prompt prefix rather than the returned text, so only the closing tag ever appears in `content` (e.g. qwen3.5-9b). The full chain-of-thought was rendering as plain visible text; it now collapses into the "Thinking" toggle like other reasoning models.
