# Qwen3 0.6B CUDA INT4 BYOM recipe

This is a pinned candidate recipe for building a Qwen3 embedding folder that
Foundry Local can register as an ONNX Runtime GenAI model. It records the
successful build's source revisions, full Python package versions, modified
Olive config, and export fixes. It does not establish that the registered
catalog artifact came from these sources. Fresh build/output replay succeeds
with both the original and a newly provisioned pinned Python environment.

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
does not establish retrieval quality, MTEB scores, or provenance of the
separately cached catalog artifact.

A second replay created an empty Python 3.12.12 virtual environment, restored
`requirements.lock.txt` from public PyPI and the CUDA 12.6 wheel index, and
passed `pip check`. With the optional TensorRT DLL hidden only during the Olive
run and restored afterward, the pinned source copy and checked-in config
produced all 12 prepared files byte-for-byte identical to the first portable
replay, including the ONNX graph. Its isolated Flint import, fresh-process
restart, IPC and gateway embedding calls on GPU 1, source-hash check, removal,
and confirmed shutdown also passed. Wheel hashes and the host driver are not
pinned; these runs do not establish bit-for-bit reproducibility on other hosts.

## Retrieval evaluation

The [SciFact](https://huggingface.co/datasets/BeIR/scifact) corpus and queries
are pinned to revision `b3b5335604bf5ee3c4447671af975ea25143d4f5`;
the [test judgments](https://huggingface.co/datasets/BeIR/scifact-qrels) are
pinned separately to `2938d17dc3b09882fdb8c12bbbe2e2dc0e75a029`.
Download `corpus/corpus-00000-of-00001.parquet` and
`queries/queries-00000-of-00001.parquet` from the first revision and `test.tsv`
from the second into an isolated directory. The downloaded SHA-256 hashes,
respectively, are `243324b35f03d82bd6d98a5f575966876e86cad7ce16e5333a35b1b793dc4f45`,
`1c37956c5dc8b810b60302323c24d1a9e79e26411ba8f5ad9d0888642e2a9034`,
and `0864bb985e0ca2367ba217977e72004d549054b2b06666ed9d4825ac7c21284c`.

With Python and `pyarrow` installed, convert the pinned input and run the
portable export through Flint's isolated sidecar:

```text
python scripts\byom\prepare_scifact.py --corpus corpus.parquet --queries queries.parquet --qrels test.tsv --output dataset.json
set "CUDA_VISIBLE_DEVICES=GPU-b48de894-88e9-a1a3-282a-223dbf11faf6"
src-tauri\binaries\node-x86_64-pc-windows-msvc.exe scripts\byom-gateway-live.mjs --model <portable-build-output> --copy --embeddings --retrieval dataset.json
```

The runner sends the 5,183 full-corpus title-plus-abstract documents through
Flint's gateway in batches of at most 32, truncating only the two documents
above Flint's 8,192-character admission limit. It evaluates all 300 judged
test queries (339 relevance judgments), each prefixed with the recorded
retrieval instruction, against normalized document vectors using cosine
similarity, Recall@10, and nDCG@10. Its separate IPC/gateway smoke call checks
vector agreement before the ranking run. Neither equal dimensions nor a
successful smoke request substitutes for a ranked-retrieval measurement.

The portable 12-file replay returned 1,024-component vectors from IPC and
gateway with cosine agreement above 0.999999. On the full SciFact corpus and
all judged test queries, gateway embedding retrieval reached **Recall@10
0.83489** and **nDCG@10 0.70395**. The source hashes were unchanged; removal
and graceful sidecar shutdown were confirmed. The run did not restart the
sidecar: a separate copy/restart attempt exited with native Windows access
violation `3221225477` during accelerator registration after restart. The
active execution provider was still not reported, and this result does not
establish the provenance or quality of the separately cached catalog artifact,
cross-host reproducibility, or full MTEB performance.

Continue 2.0.0 requests `encoding_format: base64` for OpenAI embeddings. The
local-model gateway previously rejected that request with HTTP 400, so no
vectors were stored. With float32 little-endian base64 encoding supported,
an isolated Continue profile indexed two synthetic documents through this
portable BYOM model on GPU 1. The paired request returned two 1,024-component
vectors; the two persisted `lance_db_cache` rows each held 1,024 components,
and their float32 SHA-256 digests matched the respective HTTP response bytes
exactly (`1778e9e7228c589241528f7638496cc43dcea88ff7394955cf3cb9d0759c930c`
and `d43959bff22365456d21da6f9e8c28d45900d5f8fd2f65630baffafa74ca21ad`;
the JSON request body SHA-256 was
`7eee83d9c588912a861e18fce9fd0f86a94803734cdff1841cc20edfdb685107`).
The index lock was released and sidecar shutdown was confirmed.
This proves the local BYOM path, not the previously observed 256-component
rows from the separately cached catalog variant; that discrepancy still
needs a paired capture for the cached artifact.
