---
"flint": patch
---

Harden packaging verification and audio input validation.

`verify:bundle` only ever looked at `src-tauri/target/release`, but release builds
run `tauri build --target <triple>` and write to `src-tauri/target/<triple>/release`.
Every staging and installer check therefore found nothing and silently reported
success on exactly the builds that ship. It now accepts `--target`, plus a
`--require-build` flag that turns a missing output tree into a hard failure instead
of a skip.

`verify:bundle` and `smoke:node` existed but were never run by any workflow. Both now
run in CI on Windows and macOS and in the release workflow after the build, so a
bundle missing the native Foundry core fails the pipeline rather than shipping.

Transcription rejected nothing: the sidecar renamed any upload to `.wav` because the
model's decoder is strict, but renaming does not convert, so non-WAV bytes reached
the native decoder and failed with `Cannot read properties of null`. Audio containers
are now sniffed by magic bytes before a model is loaded, and the error names the
actual format.

Coverage now includes the sidecar and runtime-path modules, and the thresholds move
from 65/45 to 88/72 to match the coverage those files actually have.
