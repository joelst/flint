# Qwen3 0.6B CUDA INT4 BYOM recipe

This is a pinned candidate recipe for building a Qwen3 embedding folder that
Foundry Local can register as an ONNX Runtime GenAI model. It records the
successful build's source revisions, full Python package versions, modified
Olive config, and export fixes. It does not establish that the registered
catalog artifact came from these sources. A fresh build/output replay reused
the pinned Python environment; rebuilding that environment remains unverified.

## Pinned inputs

- Model: `Qwen/Qwen3-Embedding-0.6B` at Hub revision
  `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`.
- Upstream recipe: `microsoft/olive-recipes` at commit
  `1ebab74ab474869c53575954fda0772cee723ecf`, under
  `Qwen-Qwen3-Embedding-0.6B/cuda`.
- Build host: Windows x64, Python 3.12.12, CUDA 12.6 PyTorch build.
- Python packages: the complete recorded environment is in
  [`requirements.lock.txt`](../../scripts/byom/qwen3_embedding_cuda_int4/requirements.lock.txt).
  Versions are pinned, but wheel hashes and the host NVIDIA driver are not.
- The derived
  [`olive-config.json`](../../scripts/byom/qwen3_embedding_cuda_int4/olive-config.json)
  uses a local, revision-pinned model snapshot and the successful build's
  workaround for Olive failing to quantize the input embedding layer:
  `passes.r.embeds` is `false`, with only the `lm_head` override retained.

## Reproduction

Use a new, isolated work directory outside the Flint and Olive checkouts. From
the Flint repository root, run these commands in Windows Command Prompt:

```text
set "FLINT_REPO=%CD%"
set "WORK_DIR=%TEMP%\flint-qwen3-olive-run-%RANDOM%"
if exist "%WORK_DIR%" exit /b 1
mkdir "%WORK_DIR%"
cd /d "%WORK_DIR%"
git clone --filter=blob:none --no-checkout https://github.com/microsoft/olive-recipes.git olive-recipes
git -C olive-recipes checkout 1ebab74ab474869c53575954fda0772cee723ecf
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install --requirement "%FLINT_REPO%\scripts\byom\qwen3_embedding_cuda_int4\requirements.lock.txt" --extra-index-url https://download.pytorch.org/whl/cu126
hf download Qwen/Qwen3-Embedding-0.6B --revision 97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3 --local-dir source
copy "%FLINT_REPO%\scripts\byom\qwen3_embedding_cuda_int4\olive-config.json" olive-config.json
copy "%FLINT_REPO%\scripts\byom\qwen3_embedding_cuda_int4\prepare_export.py" prepare_export.py
```

The model repository is public; no Hugging Face login or token is required.
`hf download` writes the exact pinned revision into `source`.

The recorded build temporarily hid
`.venv\Lib\site-packages\onnxruntime\capi\onnxruntime_providers_tensorrt.dll`
so the CUDA-only Olive run would not register the optional TensorRT provider.
If reproducing that workaround, rename only that DLL in this isolated venv to
`onnxruntime_providers_tensorrt.dll.disabled`, then restore its original name
immediately after the run (including after a failed run). Do not alter a system
Python installation.

Run Olive from the work directory so the relative `source`, `build-output`, and
`build-cache` paths in the config resolve there:

```text
.venv\Scripts\olive.exe run --config olive-config.json
.venv\Scripts\python.exe prepare_export.py --source source --output build-output
certutil -hashfile build-output\model.onnx SHA256
```

`prepare_export.py` copies the source `config_sentence_transformers.json` into
the output, sets `tie_word_embeddings` to `true` in the exported `config.json`,
and removes Olive's `model_config.json` build manifest after checking its
shape. That manifest contains absolute work-directory paths and is not needed
by the registered Foundry model; leaving it in the package makes the export
host-specific. Its standard-library tests run with:

```text
py -3.12 -B scripts\byom\qwen3_embedding_cuda_int4\test_prepare_export.py
```

## Recorded output and remaining qualification

The original successful export had 13 files totaling 828,305,485 bytes.
`model.onnx` was 812,372,350 bytes with SHA-256
`c329c06087fc940b48491f32d66c5c46b7d0c89f0208014cf2388d9ae3dbae61`.
The original Olive recipe's unmodified config and unpinned requirements do not
produce this exact build procedure.

A replay from a separate work directory, using copied pinned model inputs,
the checked-in config, an empty build cache/output, and the prior pinned Python
environment completed every Olive pass. Its ONNX graph and eleven other files
matched the original output byte-for-byte; only Olive's `model_config.json`
contained different absolute build paths. After `prepare_export.py`, the
portable output has 12 files totaling 828,266,615 bytes and the same ONNX hash.
No exported JSON contains the replay work-directory path.

An isolated SDK/core 2.4.0 sidecar imported the 12-file replay into its own
app home, restarted without re-importing, and returned two finite
1,024-component vectors from both `embedTexts` IPC and gateway alias
`/v1/embeddings` requests on physical GPU 1. Corresponding IPC/gateway vectors
had cosine similarity above 0.999999; the source's 12 file hashes were
unchanged, removal succeeded, and both sidecar shutdowns reported confirmed
cleanup. The runtime still reported no active-provider identity. The replay
does not establish a newly provisioned Python environment, retrieval quality,
MTEB scores, or provenance of the separately cached catalog artifact.
