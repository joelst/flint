---
"flint": patch
---

Harden release packaging and audio input. `verify:bundle` now understands `--target` builds (it previously inspected only `target/release`, so every check silently passed on the builds that ship) and gains `--require-build`; it and `smoke:node` now run in CI and at release. Non-WAV uploads are rejected by magic-byte sniffing before a model loads, instead of failing inside the native decoder. Coverage now includes the sidecar and runtime-path modules at 88/72.
