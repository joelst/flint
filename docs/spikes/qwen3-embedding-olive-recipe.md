# Qwen3 0.6B CUDA INT4 BYOM recipe

This is a pinned candidate recipe for building a Qwen3 embedding folder that
Foundry Local can register as an ONNX Runtime GenAI model. It records the
successful build's source revisions, full Python package versions, modified
Olive config, and export fixes. It does not establish that the registered
catalog artifact came from these sources, and the checked-in procedure has not
yet been replayed from a clean environment.

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
the output and sets `tie_word_embeddings` to `true` in the exported
`config.json`. Its standard-library tests run with:

```text
py -3.12 -B scripts\byom\qwen3_embedding_cuda_int4\test_prepare_export.py
```

## Recorded output and remaining qualification

The successful export had 13 files totaling 828,305,485 bytes.
`model.onnx` was 812,372,350 bytes with SHA-256
`c329c06087fc940b48491f32d66c5c46b7d0c89f0208014cf2388d9ae3dbae61`.
The original Olive recipe's unmodified config and unpinned requirements do not
produce this exact build procedure.

The exported model passed a sidecar 2.4.0 import and embedding smoke check on
physical GPU 1; gateway and IPC returned matching finite vectors. GPU 0 remained
idle. This is not a clean replay of the checked-in config, retrieval-quality
evidence, MTEB evaluation, or proof of provenance for the catalog's cached
artifact. Those checks remain open.
