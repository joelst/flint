---
"flint": patch
---

Transcription no longer fails with "Unable to decode audio data" for WAV files some WebView2/Chromium builds reject: Flint parses standard PCM WAV itself instead of relying solely on the browser decoder. Other formats (MP3, etc.) that still fail to decode now report which container was detected and suggest converting to WAV.
