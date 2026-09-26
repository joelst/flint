---
"flint": patch
---

Gateway (OpenAI-compatible endpoint) rows in the Access Log now report token counts, time-to-first-token, and decode throughput for chat completions, instead of always showing "—". Captured from the response the proxy already parses for normalization, with no extra buffering of streamed responses.
