# Spike — Foundry Local SDK 2.1.0

**Status:** Recorded 2026-10-07. Checks 1–3 and 7 passed for the Qwen 2.5 0.5B CPU folder. Checks 4 and 5 failed: Foundry's listener returned HTTP 404 for the registered id. Check 6 left the spike catalog file empty after the second 0.5B run. Listener chat was not proven. The production pin has since moved to 2.1.0.
**Date opened:** 2026-10-07
**Production pin:** `foundry-local-sdk` **2.1.0** exact, in `package.json` and [SDKV2_MIGRATION.md](../SDKV2_MIGRATION.md). This file records the 2026-10-07 measurement. It does not by itself prove listener chat.
**npm:** `foundry-local-sdk@2.1.0` was published 2026-09-29. The GitHub release is [v2.1.0](https://github.com/microsoft/Foundry-Local/releases/tag/v2.1.0).

## Goal

Learn whether SDK 2.1.0 is how Flint should register a local ONNX GenAI folder, chat with it, and complete one tool call. Flint's job stays the same: make local models easier to manage, discover, test, and prove.

The production pin is 2.1.0. Listener chat and a tool call were not proven by this measurement.

## What 2.1.0 claims

- Register and unregister an ONNX Runtime GenAI directory in the local catalog. The folder stays where it is. The caller supplies task, device, execution provider, and context length.
- The registered alias then uses the same discovery, load, and session APIs as a catalog model.
- Tool calls accept custom tools on chat completions, including a raw text payload and enum arguments. A malformed call can be recovered, and a tool-call boundary can survive the next turn.
- Streaming inference cancels when the client disconnects. Model-download cancellation works again. Usage, output-limit reporting, audio language, and sampling behavior are fixed. ONNX Runtime GenAI is 0.17.1.

The release notes do not mention the Gemma 4 chat template. Web search for that model stays a separate request on whatever build this spike produces.

## Out of scope

- **WinMLServer.** A later Windows-only possibility, tracked in [BACKLOG.md](../BACKLOG.md). Watch llama.cpp compatibility and the experimental server API. The closed `WinMLServer.exe` binary is not part of this spike.
- **Model prep as a product.** If registration accepts execution provider and context length, Flint may be able to stop writing `inference_model.json` for folders that are already ONNX GenAI. The Windows ML CLI (`winml analyze`, `build`, `perf`) may later prepare a plain ONNX file before that registration. Both are follow-ups, recorded only if this spike shows the gap.
- A contributed model list, its lint, or a test harness.
- GGUF. Flint keeps rejecting a GGUF folder. Foundry registration is ONNX GenAI.
- `/v1/responses` on Flint's gateway, unless chat completions cannot express the tool call.
- The installer, the native cache, and the benchmark 503. Those are re-checked on the branch after a go, against port 5272: 200, then 503 while **Running**, then 200 again.

## Isolation

Quit Flint before any command that creates a manager. A second native core beside the app makes both results unusable.

The runner installs `foundry-local-sdk@2.1.0` under `%TEMP%\flint-foundry-210-spike` (or `--work`). It refuses a work directory inside this repo. The manager uses app name `flint-spike-210`, a cache directory inside the work directory, and `disableNonessentialTelemetry`. After a model loads, it starts Foundry's own listener on the port the SDK chooses, runs the live OpenAI checks, and stops that listener before exit. It does not bind port 5272.

`--model` points at a folder you already have. The runner records that folder's file count, sizes, and mtimes before register and after unregister, and records how many bytes the spike cache grew. Unregister runs on the way out.

## Prove

| # | Check | Pass when | Result |
|---|---|---|---|
| 1 | Versions | The isolated package reports SDK 2.1.0. Record `deps_versions.json` and any ONNX Runtime GenAI file name the package shipped. | Pass. Isolated `foundry-local-sdk` 2.1.0. `deps_versions.json` pins onnxruntime 1.30.0, onnxruntime-genai 0.17.1, and windows-ai-machinelearning 2.4.89. The package shipped `prebuilds/win32-x64/onnxruntime-genai.dll`, `onnxruntime.dll`, and `onnxruntime_providers_shared.dll`. The repo pin stayed 2.0.1. |
| 2 | API names | The runner prints the real register and unregister methods. Fill those names in below. Do not copy the Rust sample's `register_model` and treat it as JavaScript. | Pass. Preferred surface is `manager.getCatalog(Local)`, catalog name `local`, methods `registerModel` and `unregisterModel`. The default `manager.catalog` is the public Azure catalog and is not the registration target. `new MutableModelInfo()` accepted `task`, `execution_provider`, and `context_length`, then disposed. That call did not register a folder. |
| 3 | Register | One existing ONNX GenAI folder is registered. The source listing is unchanged, and the spike cache does not grow by about the size of that folder. The alias is visible to this spike's catalog lookup. | Pass on the folder and the cache. `qwen2.5-0.5b-instruct-generic-cpu-4\v4` (878 MB, 10 files, both JSON files present) registered with `MutableModelInfo`. The source listing was unchanged. The spike cache grew by 1,104 bytes at register and 99,751 bytes after use. The local catalog reported 1 new model. `getModel('flint-spike-model:1')` missed it; the model object says the alias is `flint-spike-model` and the id is `flint-spike-model:1`. `deviceType` came back `Invalid`. |
| 4 | Chat | `GET /v1/models`, one non-streaming `POST /v1/chat/completions`, and one streaming completion that ends with `[DONE]` all succeed against Foundry's listener. `inspect.json` records the served model id, usage when the body includes it, and the execution provider when the model object exposes one. | Fail. The listener came up at `http://127.0.0.1:54299/v1`. `GET /v1/models` returned 48 rows from the Azure catalog and did not include the registered id. Chat and the stream returned HTTP 404. The log says `GetModelVariant` did not find `flint-spike-model:1` and then fetched the public catalog. In-process `load` had already logged `model loaded successfully`. |
| 5 | Tool call | One streamed `POST /v1/chat/completions` sends `pick_color` with enum `red` or `blue`. When that call has an id, a second request includes the tool result. The report records whether the arguments parsed and whether the second request finished. Use a folder whose chat template can emit a tool call. Gemma 4 E2B is the known template crash and does not decide this check. | Fail. The tool request was HTTP 404, so no `pick_color` call was parsed. This does not decide the Gemma 4 template. |
| 6 | Cleanup | Unregister removes the alias. The source folder remains, with the same listing as check 3. | Mixed. The first unregister returned and the Qwen 2.5 folder stayed unchanged. A later process that tried to register Qwen 3.5 9B CUDA was told `flint-spike-model:1` was already registered; that folder stayed unchanged. After that process exited, `getModels()` was empty and unregister of both the id and the alias returned "model not found". The second 0.5B run registered again, unregister returned, and `foundry.local.modelinfo.json` was `models: []`. |
| 7 | Flint still starts | After the spike process exits, installed Flint loads one catalog model it could load before. | Pass. After the second 0.5B run exited, installed Flint loaded a catalog model. |

### Registration methods (filled in by check 2)

| Surface | Method | Arity | Notes |
|---|---|---|---|
| `manager.getCatalog(Local)` | `registerModel` | 3, declared | `(modelPath, modelId, metadata: MutableModelInfo) => Promise`. Catalog `name` is `local`. The Qwen 2.5 call with metadata returned a model. |
| `manager.getCatalog(Local)` | `unregisterModel` | 1, declared | `(aliasOrModelId) => Promise`. The type says this does not delete the folder. |
| module | `MutableModelInfo` | constructor | Also exported as `ModelInfoBuilder`. `setStringProperty` / `setIntProperty`. Keys `task`, `execution_provider`, and `context_length` accepted in a constructor probe. |

## Go / no-go

**Current evidence:** A real Llama 3.2 3B ONNX GenAI folder absent from the current 48-model public catalog passed local registration, load, Flint IPC chat, gateway discovery, buffered chat, and streamed chat through the session-backed gateway. All eight source files had matching SHA-256 snapshots before and after; the isolated junction was removed. The native Foundry listener itself still omits the registration and returns 404. The separate enum-tool check did not produce a call, and this model reports no tool-calling capability metadata.

The BYOM chat gate is demonstrated for this CPU model, not the full SDK 2.1.0 release. Source-repository revision/license provenance, a tool-capable control model, cancellation, download cancellation, GPU/provider behavior, and installed-app qualification remain open. Do not treat a model without tool-call capability as a tool regression.

**2026-10-07 native-listener result.** `registerModel` kept the Qwen 2.5 0.5B CPU folder in place and the in-process load succeeded. The Foundry listener did not serve `flint-spike-model:1`, so direct HTTP chat and the enum tool call failed; installed Flint still loaded a catalog model afterward. This native-listener result remains true and is distinct from Flint's gateway adapter.

**Real external-model run.** `scripts/byom-gateway-live.mjs` linked an existing 3.66 GB Llama 3.2 3B ONNX GenAI folder into an isolated app home. The public catalog probe returned 48 models and no Llama 3.2 match. Flint discovered `flint-byom-live`, loaded variant `flint-byom-live:1`, and returned `6 times 7 equals 42.` through IPC, buffered gateway chat, and gateway streaming; the SSE stream ended with `[DONE]`. The source snapshot contained eight files and was unchanged after unlink/delete. This proves real CPU chat through this branch's sidecar and gateway, not tool, GPU, or installed-app behavior.

## Runner

`scripts/spike-foundry-210.mjs` is research tooling. It is not wired into the app. `node .\scripts\spike-foundry-210.mjs --self-test` checks folder diffs, tool-call assembly, and the work-directory guard. That command does not load Foundry. When listener checks fail, the runner also attempts a direct `ChatSession` probe so an HTTP 404 does not hide whether the model can run in process.

`scripts/byom-gateway-live.mjs --model <onnx-genai-folder>` qualifies a real folder through Flint's sidecar and gateway. It refuses to run while `Flint.exe` is open, links the source under an isolated temporary app home, records SHA-256 for every source file, tests IPC and buffered/streaming gateway chat, unloads and deletes the isolated registration, verifies the source hashes, and removes the temporary home. It never copies or edits the external folder.

`--install` puts the package in the work directory and can run while Flint is open. Every other command, except `--self-test`, creates a manager and refuses to start while `Flint.exe` is running unless `--force` is passed.

The manager report lists package version, `deps_versions.json`, ONNX Runtime GenAI file names, declaration lines that mention registration, and the methods on the manager and any catalog it can read. It asks `getCatalog(CatalogType.Local)` and `getCatalog(CatalogType.Public)` in addition to the default catalog getter. The register and unregister names are whichever methods are present. A surface whose name contains `local` wins when several exist. On the 2026-10-07 run that surface was `manager.getCatalog(Local)`. Metadata is `new MutableModelInfo()`, also exported as `ModelInfoBuilder`.

`--model` refuses a folder that contains a `.gguf` file and no `genai_config.json`. For an ONNX folder it records whether `genai_config.json` and `inference_model.json` exist. When the SDK exposes a metadata object, the runner sets `task`, `execution_provider`, and `context_length` and records which setters accepted them. Defaults are `chat-completion`, `CPUExecutionProvider`, and `4096`. Override with `--task`, `--ep`, and `--context`. A CUDA-only folder can be retried with `--ep CUDAExecutionProvider`.

The register call uses the Rust sample's order: folder path, alias `flint-spike-model:1`, then metadata. If that call fails for a reason other than argument count, the runner tries once without metadata. An argument-count error stops there so a second guess cannot register the folder under the wrong shape. Both outcomes land in `inspect.json`.

Chat, streaming, the enum tool call, the tool-result turn, the unknown-model error envelope, and stream abort are real HTTP requests to Foundry's listener. `scripts/openai-live.mjs` performs them with `fetch`. Gateway unit tests and the in-app self-test suite still substitute a peer; they do not satisfy this spike. The same script can target a running Flint gateway without starting a second runtime:

```powershell
node .\scripts\openai-live.mjs --base http://127.0.0.1:5272/v1 --model <id>
```

`--embed-model` and `--speech-model` add `POST /v1/embeddings` and `POST /v1/audio/transcriptions`. `POST /v1/responses` is recorded and does not decide the required result. The tool is `pick_color` with enum `red` or `blue` and `tool_choice` `auto`. When the streamed call carries an id, the next request includes the assistant tool call and the tool result. If the listener is unavailable or its required HTTP checks fail, the runner also attempts a `ChatSession` `openai-json` request and records the HTTP and in-process outcomes separately.

`inspect.json` records the model id, execution provider when the object exposes one, token usage, whether the enum arguments parsed, and whether the second request finished. Exit code 2 means the SDK was not 2.1.0, the manager failed, registration did not return a model, or a required live check failed. Required checks are `GET /v1/models`, non-streaming chat, streaming chat, the tool request itself, the OpenAI error envelope, and stream abort. A model that returns HTTP 200 with no well-formed `pick_color` call still exits 0 so the report can be read; that result remains a no-go until the enum call is well-formed. `--keep` leaves the alias registered. Check 7 stays a person opening installed Flint after the process exits.

## Run

From this repo:

```powershell
node .\scripts\spike-foundry-210.mjs --self-test
node .\scripts\openai-live.mjs --self-test
node .\scripts\byom-gateway-live.mjs --self-test
node .\scripts\spike-foundry-210.mjs --install
```

Quit Flint, then:

```powershell
node .\scripts\spike-foundry-210.mjs
node .\scripts\spike-foundry-210.mjs --model "D:\models\some-onnx-genai-folder"
node .\scripts\byom-gateway-live.mjs --model "D:\models\some-onnx-genai-folder"
```

The inspect file is `%TEMP%\flint-foundry-210-spike\inspect.json`. The Result column records the measured run above; a repeat must record its own SDK, model, and listener evidence. Current implementation sequencing and release gates live in the [SDK/BYOM shipping plan](../PRODUCT_PLAN.md#sdk-210-and-real-byom-shipping-plan).

## Follow-ups after a go

- A branch that bumps the exact pin to 2.1.0 and replaces the previous Windows native libraries on install.
- The benchmark 503 sequence on that branch.
- Hermes and OpenClaw against that branch, using the tool-call result from check 5.
- One embedding folder, only after chat registration is reliable.
