---
"flint": minor
---

Add BYOM (bring your own model) import so Flint can run ONNX models that are not in the
Foundry catalog. `inspectModelFolder` validates a folder and explains why it is unusable
(GGUF, missing tokenizer, incomplete download, weights that `genai_config.json` does not
point at) before anything is copied. `importModelFolder` stages the copy, authors the
Foundry-specific `inference_model.json` — which almost no public ONNX repo ships — picks a
prompt template from the model's own chat template, then activates it with a single atomic
rename and removes the staging directory on any failure. `linkModelFolder` registers a
model that lives elsewhere through a directory junction, so a second copy of a multi-gigabyte
model is unnecessary and the source folder is never written to.
