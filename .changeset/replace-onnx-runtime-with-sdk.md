---
"flint": patch
---

Windows installs now replace the Foundry SDK and its ONNX Runtime instead of keeping the previous version's DLLs, and put the previous SDK back if the install fails or is cancelled. Builds no longer package an ONNX Runtime DLL that is not the pinned version.
