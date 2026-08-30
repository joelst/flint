---
"flint": minor
---

Add approximate timestamped transcripts and model list sorting.

**Timestamped transcripts.** Foundry Local reports no timing data of any kind, so Flint now derives its own. Long-audio transcription still uses ~28 second windows (Whisper-family models degrade on short clips) but snaps each window boundary to a detected pause in the waveform instead of cutting at a fixed offset. Transcripts can be viewed with per-segment times and exported as SRT or WebVTT. Timings are clearly labelled as approximate and derived from silence detection, never presented as model output. Audio with no usable pauses — continuous speech, music, or near-silent recordings — falls back to the previous fixed-length overlapping chunks, and short audio is unchanged.

**Model list sorting.** The Models view can now be sorted by family, name, or newest first, with family headings when grouped. Because the catalog reports no family for any model, families are derived from the model alias. Model search now matches the derived family in addition to the alias, replacing a family filter that could never match.
