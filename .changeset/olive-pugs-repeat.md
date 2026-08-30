---
"flint": patch
---

Fix `Sidecar init failed: require is not defined` on packaged builds. The SDK fallback loader used CommonJS `require` inside the ESM sidecar, so installed apps could never load `foundry-local-sdk` from bundled resources. Added a regression test that runs the sidecar against a simulated installer layout.
