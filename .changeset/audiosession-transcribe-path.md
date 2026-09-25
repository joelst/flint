---
"flint": patch
---

Try the new Session/Request/Item AudioSession API first when transcribing audio, falling back to the deprecated AudioClient automatically for models it doesn't yet support (Nemotron, Parakeet). No user-visible change for those models; Whisper-family models now transcribe via the API that will replace AudioClient before its end-of-2026 removal.
