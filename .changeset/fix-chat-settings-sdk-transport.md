---
"flint": patch
---

Fix chat completions silently ignoring requested temperature/maxTokens whenever the SDK transport is used (the common case) — they are now applied to the model's ChatClient settings, matching the audio path.
