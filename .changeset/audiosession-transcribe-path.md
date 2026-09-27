---
"flint": patch
---

Route Whisper and Nemotron through supported single-inference AudioSession paths, validate WAV chunk boundaries, defer uncertain speech-family routing until load, reject known unsupported Parakeet models early, and preserve transcription errors when cleanup also fails.
