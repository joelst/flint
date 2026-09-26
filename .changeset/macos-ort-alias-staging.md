---
"flint": patch
---

Accept the macOS ONNX Runtime alias after Tauri copies release resources. The staged `libonnxruntime.dylib` is a regular file, not the symlink the SDK installer created, and the bundle check was failing the release on that copy.
