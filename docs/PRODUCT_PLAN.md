# Flint reliability execution plan

**Status:** **0.10.0** is the current published stable release. **0.11.0** is
the next release and carries the SDK 2.4.0 / real-BYOM work below. The external
Llama 3.2 3B ONNX GenAI model has passed CPU registration, IPC chat, and
buffered/streaming gateway chat on SDK 2.4.0, both as a metadata-free copy and
as a metadata-bearing link, with unchanged source hashes and confirmed shutdown.
The seven shared artifacts match the pinned public source revision; broader
lifecycle and SDK qualification, and installed-app
evidence remain. No 1.0 date until the remaining process gates in
[RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) are done.

**Scope:** 1.0 production is Windows. macOS Apple Silicon remains evaluation-only (unsigned). Linux is deferred.

**Release ownership:** [CHANGELOG.md](../CHANGELOG.md) owns version assignments and release history. [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) owns the forward plan through 1.0 and the 1.0 release bar. This document owns 1.0 implementation sequencing and acceptance gates. [BACKLOG.md](./BACKLOG.md) holds deferred and post-1.0 work.

## 0.11.0 SDK/BYOM release preparation

### SDK 2.4.0 and real BYOM shipping plan

**Target:** 0.11.0 pins `foundry-local-sdk` and the matching native core at
**2.4.0** exact. The pin is inclusive: the release qualifies the behavior
shipped from 2.1.0 through the surfaces this package still supports. Ranking
sessions, typed decisions, and the deprecated OpenAI client constructors stay
out. GitHub has no `v2.4.0` release notes. The npm package, published
2026-11-09, is the source for this pin.

**Status:** The integration branch pins SDK 2.4.0. It contains
local-catalog registration, merged frontend discovery, local load/delete
handling, runtime version reporting, and live-probe scripts. The linked
external-model spike demonstrates CPU inference through IPC and the
session-backed OpenAI gateway on 2.4.0 for copy and link, including a copy whose
source has no `inference_model.json`. Local automated gates, fresh unsigned
target-specific Windows packaging, bundle verification, and executable runtime
smoke pass on this pin. These are not installed-app or full SDK qualification.
Do not publish until the
gates below pass on 2.4.0. `.changeset/foundry-sdk-2.1.0.md` describes the
2.1.0 integration. The 2.4.0 pin, coding-task, and shared-host changes have
their own changesets.

**Implementation sequence:** The existing model paths move onto exact 2.4.0,
including the Windows x64 CUDA runtime directory and registering CUDA before
TensorRT. The 2.4.0 JavaScript catalog does not expose a minimum SDK version,
so Flint does not add a second download filter. Task `coding` stays text-only
chat, and the shared-host opt-in stays off unless the user turns it on.
Ranking, typed decisions, and the deprecated OpenAI client constructors stay
out. Llama CPU copy/link chat is qualified. Whisper URI transcription and the
expected Parakeet pre-load refusal are probed on 2.4.0; normal all-provider GPU
startup, broader lifecycle, and installed-app checks remain open.

**Scope:** Qualify every existing Flint model operation on 2.4.0: discovery,
download, import/link, load/unload/delete, Playground chat/vision/tools,
embeddings, speech, gateway clients, Arena/Benchmark, cancellation, recovery, and
packaging. SDK custom-tool payloads are a transport feature, not permission to
execute files, patches, or shell commands. A new runtime, GGUF, hosted Qwen API
integration, and a general `/v1/responses` implementation are not prerequisites
and must not be presented as part of this work.

#### Model scope: existing ONNX GenAI packages

**Release gate:** working BYOM for an existing compatible ONNX Runtime GenAI
package, including one real model outside the current Foundry Local catalog.
Use the measured Qwen 2.5 0.5B CPU folder as a harness control, not as the
external-model proof. Renaming a catalog model does not satisfy this gate.

The input package must already be ONNX GenAI; the model's original training or
checkpoint format is not the criterion. Converting non-ONNX weights, building
new architecture/operator support, or adopting another runtime is out of scope
and must not block SDK 2.4.0/BYOM shipping.

[Qwen3.8-Flash-Next](https://huggingface.co/Qwen/Qwen3.8-Flash-Next) is an example
of a desirable model, not a named release requirement. Its published
[configuration](https://huggingface.co/Qwen/Qwen3.8-Flash-Next/blob/de4b8e4d43b917e7706784d8bb445c9af86a3540/config.json)
uses `qwen4_exp`, and this repository has no verified compatible ONNX GenAI
recipe for it. Unless an existing supported package is available, record it as
outside this spike's scope and choose another model. Do not open a conversion
workstream or advertise Flash-Next support from the SDK pin alone.

#### Non-catalog ONNX model test spike

**Objective:** establish one repeatable recipe for a popular model that is
absent from Foundry Local's current public catalog, using real external ONNX
GenAI weights rather than synthetic fixtures or a renamed catalog download.

**Measured candidate:** Llama 3.2 3B Instruct passed the isolated CPU chat spike
and the public-catalog absence check recorded in the
[spike evidence](./spikes/foundry-2.1.0-spike.md#go--no-go). The original
and imported source files match the pinned upstream revision; license terms
require review before any redistribution of weights. Remaining
lifecycle/provider checks still need qualification. A
smaller published ONNX GenAI package is an alternative when the target
provider/memory budget requires it and the same selection checks pass.

1. Capture the current public catalog after accelerator setup and compare the
   candidate's actual family, checkpoint, aliases, and variants. Do not count a
   new alias or quantization of a catalog-listed checkpoint as a new model.
2. Pin the external package's repository/revision, license, tokenizer, template,
   `genai_config.json`, weights/external data, quantization, and execution
   provider. Check architecture compatibility, disk space, RAM/VRAM, and context
   budget before acquiring weights. A Transformers.js/plain ONNX export alone
   is not an ONNX GenAI package.
3. With Flint closed, use an isolated app/cache to prove native registration,
   load, and meaningful generation. Record native listener behavior separately
   so a listener 404 is not mistaken for a bad model. Stop the isolated runtime
   before testing Flint; do not alter the external source folder.
4. Exercise the same package through Flint copy and link: discover, load,
   non-streaming/streaming IPC with HTTP off, gateway discovery/chat/streaming,
   unload/reload, restart, unregister/delete. Verify the served identity and
   unchanged external-file hashes. Test tool calls when the package supports
   them; otherwise label that capability unverified and use the separate
   tool-capable control for the SDK tool gate.
5. Record the exact commands, outputs, catalog snapshot, package manifest, and
   pass/fail/blocked results with the existing spike evidence. A successful
   recipe becomes the real external-model release evidence and user-guide
   recipe. Distinguish Flint integration bugs from unsupported model packages.

**Bound:** try at most two existing ONNX GenAI packages before reporting the
specific package/runtime/hardware blocker and revisiting selection. Do not
expand the spike into conversion, training, new kernels, GGUF, or a replacement
runtime. No specific model's unsupported architecture becomes a release gate;
the supported external-ONNX BYOM path still requires a successful real-model
recipe.

#### Implementation order

| Order | Deliverable | Exit gate |
|---|---|---|
| 1 | SDK/native compatibility and startup | Exact 2.4.0 JS package and matching native assets, replacing any earlier payload; accelerator registration precedes the catalog snapshot/local-registration work; one manager per process; generation-owned readiness and About data; existing catalog operations still work. |
| 2 | Reliable local-model lifecycle | Durable, collision-safe registrations with explicit task/provider/device/context/capability metadata; copy/link/restart/recovery/unregister/delete matrix passes without modifying or deleting external assets. |
| 3 | Real BYOM sessions | Control model and genuine external package produce meaningful non-streaming and streaming answers through Flint IPC, including a fresh launch and HTTP service off. |
| 4 | BYOM OpenAI endpoint | The same registered models appear in gateway discovery and work by advertised name and alias, cold and resident, with streaming, tool results, usage, correct errors, admission, and activity accounting. Flint's gateway must handle local registrations without exposing the native listener's 404. |
| 5 | SDK 2.1.0–2.4.0 feature adoption | Native cancellation, download cancellation, tool-call fixes, parameter/usage/output-limit handling, audio behavior, and the 2.2.0–2.3.1 gates in section 5 are exercised on real 2.4.0 models; unsupported features fail explicitly. Ranking and typed decisions stay out. |
| 6 | Installed-app qualification and release | Full automated gates plus a fresh target-specific Windows package, installed-app BYOM dogfood, source-file preservation, and updater/rollback evidence pass for the same release candidate. |

Steps 1-2 precede 3; 3 precedes 4; 5 builds on the same lifecycle and inference
ownership, and all precede 6. The non-catalog spike's package/catalog selection
can run alongside steps 1-2; its Flint inference matrix closes steps 3-4.
Each implementation slice gets its own focused changeset and review;
do not combine a runtime replacement or storage-format change with this upgrade.

**1. SDK/native and startup**

- Audit the installed 2.4.0 declarations and actual calls, not just release
  notes: local `Catalog`, `MutableModelInfo`, session/request APIs, cancellation,
  download signals, catalog v2 metadata, and the minimum Foundry version used
  for model selection. Prefer session paths; test that normal 2.4.0 operations
  never invoke deprecated clients. Compatibility fallbacks must not hide a
  primary inference error or submit it a second time. A 2.1.0 declaration audit
  does not close this gate.
- Verify `deps_versions.json` and native-cache manifests on clean install and
  package staging. Report JS/core mismatches; do not reuse an incompatible
  cached native payload or describe a load smoke as inference qualification.
- Move startup registration out of the current `init` fast path into the
  serialized, accelerator-ready catalog lifecycle. Respect offline/deferred
  catalog startup, Stop authorization, partial provider failures, and recovery
  generations. Reuse the manager; never initialize the native core twice.

**2. Local registration and ownership**

- Use the local catalog, not the public default. Carry catalog ownership through
  resolution/load/delete rather than treating every public lookup failure as
  permission to hide the error with a local fallback.
- Reconcile persisted registrations with owned imports and explicit links on
  restart/recovery. Check path, identity, version, task, provider, and source
  availability; handle moved folders and duplicate aliases/ids explicitly.
  Never unregister an unrelated existing row just because a lookup failed or a
  task is missing. Do not present a stale registration as cached/loadable.
- Add reviewed metadata overrides to inspection/import/link contracts, SDK
  wrappers, sidecar validation, and UI. Filename heuristics are suggestions,
  not proof of architecture, vision, tool calling, or a working provider.
- Serialize registration/update/unregister against model admission and eviction.
  Revalidate assets under the residency lock. Invalidate derived indexes on
  every mutation; surface local-catalog read and registration failures rather
  than returning an empty/success-shaped result.
- Both copy and link must distinguish files added, registration established,
  load verified, and restart required. Report partial outcomes and safe retry
  instructions. On cleanup failures, report what remains; never imply rollback.
- Keep template synthesis for owned copies until a real model proves it is no
  longer needed. Test registration without `inference_model.json`; links must
  never author it in the source. Unregister before removing owned assets, but
  capture/validate cleanup identity while the SDK handle is still usable.
  Deleting a link removes only that link. Imported/linked/unmanaged folder tests
  must check source hashes, not just successful return values.

**3-4. Sessions and the OpenAI gateway**

- `scripts/byom-gateway-live.mjs` now exercises a real model through Flint's
  sidecar and gateway; `scripts/spike-foundry-210.mjs` separately records the
  native listener behavior. The Llama 3.2 3B CPU runs on SDK 2.4.0 pass
  IPC with HTTP off, gateway discovery, buffered chat, streaming chat,
  unload/delete, source-file integrity, and confirmed graceful shutdown for
  both copy and link. Copy accepts the original source without inference metadata.
- The gateway now appends cached local registrations to `/v1/models`. Continue
  qualifying canonical alias/version resolution against frontend discovery and
  the exact loaded build; unknown or uncached remote identifiers must never
  trigger a download.
- The native listener still does not route local registrations. Flint now
  dispatches those requests through `ChatSession` under the existing manager,
  residency/admission locks, and in-flight lease. Tool/usage parity and
  installed-app behavior are not yet proven. Ordinary catalog-model proxy
  behavior remains unchanged.
- Complete the lifecycle/error matrix: unknown model/version, missing source,
  registration/load failure, malformed/oversized request, disconnect,
  concurrent requests, model switch, idle eviction, benchmark-exclusive 503,
  Stop & Unload, and terminal Quit. No finite control-plane deadline may cut
  off a successful inference stream.

**5. Native 2.1.0–2.4.0 feature completion**

Exercise the 2.1.0 contracts below on the 2.4.0 pin. Passing them on the
current 2.1.0 branch does not close the gate. Then qualify the behavior that
landed after 2.1.0:

- **2.2.0–2.2.1 catalog and cache.** Catalog v2 is the catalog Flint reads.
  The 2.4.0 JavaScript catalog does not expose a minimum SDK version, so Flint
  does not add a second filter. Alias download stays on `getModel` /
  `getModelVariant`. Removing an incomplete or corrupted model cache must not delete a verified
  cache or a provider DLL that is still loaded. Recheck Providers still
  rebuilds a broken CUDA or WebGPU cache and leaves a registered provider in
  place.
- **2.2.1 Windows CUDA runtime.** The CUDA execution provider no longer
  bundles the CUDA toolkit or cuDNN runtime. Windows x64 needs a separate
  CUDA 12 and cuDNN 9 install. Before CUDA registration, the toolkit runtime
  directory has to be on the DLL search path with `AddDllDirectory`; the
  packaged sidecar includes the koffi binding that makes that call. The
  cached CUDA provider directory must also be on the sidecar's `PATH` so
  provider dependencies such as cuDNN resolve. `PATH` alone does not satisfy
  the GenAI CUDA bridge. A missing toolkit runtime is an explicit failure, not
  a silent CPU fallback presented as CUDA. Register CUDA before TensorRT-RTX;
  2.3.0 fixed out-of-memory failures from the reverse order. Windows ARM64 uses
  CUDA 13 and does not need that extra `AddDllDirectory` step. It is not the
  0.11.0 production target. Linux CUDA registration stays out of this release.
- **2.2.1 tools and disconnect.** An invalid generic tool schema fails the
  request. Flint must not report that failure as a successful tool call.
  Where Flint already sends a parallel-tool-call disable, 2.4.0 must honor
  it. This does not widen Playground into a tool executor. Non-streaming
  gateway disconnect must reach native cancellation under the same honesty
  rule as streaming: caller completion is not native completion.
- **2.3.0 defaults, speech, and cache ownership.** An explicit Flint
  generation setting wins over an SDK chat default. An omitted setting uses
  the pinned SDK default and stays visible as that default. The cached Whisper
  Tiny CUDA variant passed a real `transcribeAudio` sidecar request on 2.4.0.
  Parakeet was refused before loading on this pin and remains unsupported.
  Do not claim native word timestamps. 2.3.0 adds a shared model cache across
  Foundry Local SDKs.
  Flint keeps `~/.flint` and does not opt into another product's cache.
  An isolated sidecar init and cache-inventory probe with a seeded
  `~/.foundry/cache/models` marker left it unchanged and reported no Flint
  entries; this does not establish cross-app model loading.
- **2.4.0 pin.** The package keeps the 2.1.0 through 2.3.1 behavior Flint
  already uses, and it adds ranking and typed-decision sessions that stay out
  of this release. `deps_versions.json` records ONNX Runtime 1.31.0, ONNX
  Runtime GenAI 0.19.0, and Windows AI Machine Learning 2.5.96. There is no
  separate `foundry-local-core` NuGet version, so the native core pin is the
  package version, 2.4.0. Do not assume the 2.1.0 runtime (ONNX Runtime
  1.30.0, GenAI 0.17.1), the 2.3.1 runtime (GenAI 0.18.0, Windows ML 2.4.89),
  or an unverified CLI pairing.

The 2.1.0 contracts, re-run on 2.4.0:

- IPC ChatSession one-shot and streaming paths now forward the request-owned
  `AbortSignal`; streaming retains its activity lease through the terminal
  `response`. Automated tests cover that fence. A direct real-model SDK adapter
  cancellation and concurrent-completion probe is recorded below; still
  qualify sidecar IPC completion/cancel races, actual queued requests,
  legacy-client fallback, and sidecar gateway wiring independently. A real
  streaming and buffered client-disconnect check passed through a direct
  gateway harness, but neither proves native cancellation; sidecar integration
  and native quiescence remain open. The UI Stop acknowledgement is not proof
  of native completion.
- Model downloads now pass an AbortSignal to `IModel.download` and expose
  `cancelDownload` through the UI/sidecar. Flint waits for native settlement and
  refreshes cache state; automated tests cover cancellation and admission
  release. A real SDK 2.4.0 Whisper Tiny CPU download was cancelled after its
  first positive native progress update; the operation settled, its pre-existing
  2.7-KiB partial cache entry was cleared and no longer appears in inventory.
  The variant remained uncached, and a regression test verifies that a
  now-cached variant is preserved. Broader real-model races and native
  quiescence remain open; a checkpoint delay or cancellation acknowledgement
  alone is not proof the download stopped.
- Prove Qwen enum arguments, fragmented/cumulative tool calls, malformed-call
  recovery, a tool-result follow-up, unique ids, and a tool-free final answer.
  Keep Llama text-call compatibility model-scoped and subject to the existing
  consent, allowlist, two-round, size, and schema limits.
- Add a bounded discriminated transport representation for SDK custom/raw-text
  tools if exposed through Flint's public contracts, with explicit support or
  rejection on each transport. Never JSON-parse a custom payload as a function
  argument or add an executor to Playground.
- Verify sampling, reasoning, tool-choice, structured output, usage and
  output-limit/finish reasons across IPC, fallback, and gateway. The SDK
  adapter does not support nonzero frequency penalties; Flint now rejects them
  before inference in the UI, IPC, and gateway, while omitting neutral zero.
  Do not claim that nonzero frequency-penalty semantics are supported.
- A cached Nemotron 0.6B CPU WAV probe on SDK/core 2.4.0 recognized locally
  synthesized speech; Parakeet was refused before loading. Cached Whisper Tiny
  CUDA URI transcription also succeeded. Its cuDNN dependencies require the
  cached CUDA EP directory on the sidecar `PATH`; `prepareCudaRuntime` now adds
  it before provider registration. Do not infer success from the old 2.0.1
  shapes or the 2.3.0 release note, and do not claim native word timestamps.
  SDK/core 2.4.0 lists `qwen3-embedding-0.6b` and
  `qwen3-embedding-8b`; the cached variants for both are CUDA-only. A fresh
  manager initially reported CUDA unregistered; explicit
  registration using the cached EP assets succeeded. The cached 0.6B variant
  returned two finite 1024-dimensional vectors through `EmbeddingsSession` and
  the Flint gateway `/v1/embeddings` alias-rewrite path. The sidecar
  `embedTexts` command returned the same vector shape through IPC. The cached
  8B variant returned one finite 4096-dimensional vector through `embedTexts`;
  the gateway alias request also returned a finite 4096-dimensional vector.
  A pinned Qwen3 0.6B CUDA INT4 candidate recipe is recorded in
  [the Olive recipe note](./spikes/qwen3-embedding-olive-recipe.md); fresh
  build/output replay passed with both the prior and a newly provisioned
  pinned environment. Its separately replayed BYOM export reached SciFact
  Recall@10 0.83489 and nDCG@10 0.70395 through the Flint gateway on GPU 1;
  that score does not apply to the separately cached catalog artifact. The
  native router's unquoted 2.4.0 `Model not found: X` alias rejection is
  recognized by the gateway classifier.
- Native ChatSession paths use `preflightRequest` when the SDK exposes it and
  refuse requests that exceed the structural token limit before inference.
  An isolated cached Qwen2.5 0.5B CUDA catalog run on SDK/core 2.4.0
  and physical GPU 1 passed ordinary IPC chat and gateway buffered/streaming
  chat. Its 40,000-word IPC request was rejected in both buffered and
  streaming modes by native structural preflight:
  40,062 required tokens versus a 32,768-token limit (7,294 deficit).
  The source's ten file hashes were unchanged and graceful sidecar shutdown
  was confirmed. This does not qualify packaged-app admission or prove native
  memory reservation. Preserve whole-turn packing, reply reserve and
  untrusted-envelope rules; structural fit does not reserve runtime memory.

#### Required evidence and release decision

For each real model, record source URL/revision, artifact hashes, conversion
recipe/version, license, quantization, task, template, provider, device, RAM/VRAM,
context/output limits, SDK/core/native versions, app commit/build, served id,
commands and results. Keep model weights and prompt bodies out of the repo.
Store repeatable measurements with the existing spike evidence; keep this plan
for remaining gates, not a running history.

The live runner requires the requested model in the listing and valid usage,
and with `--require-tools` requires a well-formed tool call and a tool-result
turn followed by an answer without another tool call. The required tool probe
uses `tool_choice: required` rather than leaving the call to model discretion.
Run disconnect last, after all functional probes; a client abort proves neither
native quiescence nor released memory.

| Qualification | Required checks |
|---|---|
| Automated | `npm run check`, `npm run build`, `npm run verify:ipc-contracts`, `npm run verify:markdown-links`, `npm test`, `npm run test:coverage`; native BYOM E2E and both live-runner self-tests; new guards demonstrated red then green. |
| Real models | Copy and link, no-metadata import, direct IPC with HTTP off, gateway discovery/chat/stream/tools, restart/recovery, unload/reload/delete with unchanged external source; CPU control and supported GPU/provider; separate vision, embedding and speech checks. |
| Runtime coexistence | Catalog and external models together; model swap, concurrent requests, leases/pins/eviction, Arena/Benchmark exclusivity and recovery; gateway 200 before a run, 503 while Running, 200 after release. |
| Packaged Windows | Fresh target-specific build; `npm run verify:bundle -- --target x86_64-pc-windows-msvc --require-build`, `npm run smoke:node`, `npm run smoke:runtime`; installed copy/link/load/chat/stream/tools/delete/relaunch without PATH Node; signed-installer and updater/rollback qualification per [RELEASE.md](./RELEASE.md). |

**Current local qualification (SDK 2.4.0):** `npm run check`, `npm run build`,
`npm run test:coverage`, IPC-contract and Markdown-link verification pass.
Coverage passes all configured thresholds; the focused SDK/BYOM suites and
native registration E2E pass. Both live-runner self-tests, bundled Node smoke,
debug/release Rust checks, fresh unsigned target-specific Windows packaging,
bundle verification, and executable runtime smoke pass. CUDA, WebGPU, and
TensorRT registration completed in an isolated runtime; that is not GPU inference
proof. The Llama 3.2 3B CPU copy and link runs prove real external-model
registration, IPC chat with HTTP off, gateway discovery, buffered/streaming chat,
unload/delete, and confirmed graceful shutdown. All seven original source files
and all eight metadata-bearing source files retained their hashes. Local
Windows results do not prove the Linux/macOS jobs pass.
Fresh-process restart with the same isolated app home passed link and copy
re-discovery, IPC and gateway chat/streaming, removal, source-hash comparison,
and confirmed shutdown without re-import. One earlier copy/restart attempt
exited with native Windows access-violation code `3221225477` before the
sidecar returned a command reply; two subsequent copy/restart runs passed.
That failure's phase and cause were not captured, so restart stability remains
an open gate rather than a clean qualification.
A real SDK local registration of a synthetic linked folder was marked uncached
in the model list when its source was temporarily moved. Loading its alias
returned an explicit admission error; gateway discovery omitted it and an
alias chat request returned 404 without autoload. After restoring the source,
deletion removed the junction without deleting the source. This checks the
missing-source admission and ownership boundary, not real-model inference.
An isolated sidecar with GPU visibility restricted to the RTX 4080 on physical
GPU 1 completed normal, unfiltered provider registration: TensorRT-RTX, CUDA,
and WebGPU registered with no failed providers. Cached Qwen2.5 0.5B and
Phi-4 Mini CUDA variants each returned nonempty IPC and gateway chat answers.
Both were advertised by their exact versioned variant ids; gateway chat also
accepted their friendly aliases. The live runner passed its required checks
against the advertised Qwen variant without tool qualification. On Phi-4 Mini,
it passed required discovery, errors, chat, usage, streaming, forced tool call,
tool-result follow-up, tool-free final answer, and client-disconnect checks.
The model was explicitly unloaded before confirmed shutdown. Load reported
`acceleration.active: null`, so registration and the CUDA variant name do not
prove which provider executed inference. Phi's optional `GET /v1/models/{id}`
returned 404 and `POST /v1/responses` returned 500; neither endpoint is
qualified. These isolated runs do not prove installed-app operation or native
quiescence after client abort.
On the cached Qwen2.5 0.5B CPU variant, SDK and core 2.4.0 real-model probes
settled IPC stream cancellation 23 ms after acknowledgement with no later
deltas; a concurrent canceled request emitted no deltas while the first had
emitted 36. A buffered gateway request aborted while pending (540 ms) returned
`AbortError`; the first pool snapshot, 10.1 seconds later, showed `inFlight: 0`.
A separate 256-token gateway request completed in 21.6 seconds. These are
caller/lease observations, not proof of native quiescence; IPC replies did not
include cancellation certainty.

On `qwen2.5-0.5b-instruct-cuda-gpu:4`, a direct `createSessionChatClient`
probe restricted to physical GPU 1 emitted one chunk, then signal cancellation
settled as `AbortError` after 20 ms with no later chunks; a fresh non-streaming
request succeeded. A separate one-shot call aborted 165 ms after invocation
settled as `AbortError` after 232 ms, and a fresh one-shot request then
succeeded. In another run, a one-shot request started after the first stream
chunk and before abort; the stream settled as `AbortError` in 24 ms and the
one-shot completion succeeded in 26 ms. These verify adapter-level
cancellation and reuse, not sidecar IPC, queue ordering, or native
quiescence. A buffered request through the direct gateway harness was aborted
123 ms after request start; the client settled as `AbortError`, its activity
lease ended (one start/one end), and a later request succeeded. This also does
not establish native quiescence. The uncached 131-MB
`openai-whisper-tiny-generic-cpu:4` download was cancelled after positive native
progress; cancellation settled, its partial marker and metadata files were
removed, the inventory no longer reports the entry, and the variant remained
uncached. The now-empty variant directory was removed during probe cleanup.
No complete model weights were downloaded.
A full `sidecar/foundry-sidecar.test.ts` run passed all 154 tests, including
queued IPC chat drain, buffered and streaming cancellation, legacy `ChatClient`
fallback, and refusal to replay a dispatched `ChatSession` failure. The suite
uses a fake SDK, so this verifies sidecar IPC coordination, not native runtime
behavior or quiescence.
A real SDK 2.4.0 sidecar run on cached `qwen2.5-0.5b-instruct-cuda-gpu:4`,
restricted to the RTX 4080 by UUID, returned `42` over IPC. A streaming IPC
request was cancelled after its first delta; cancellation was acknowledged,
no later deltas arrived, a concurrent request returned `42`, and the pool
reported `inFlight: 0` after settlement. The terminal cancellation reply was
success-shaped without a certainty field, so this is not native-quiescence
proof. With a temporary test-only preloader restricting provider discovery to
CUDA (the current `~/.flint/ep` cache has no TensorRT provider), sidecar service
startup and loopback gateway chat also succeeded. `GET /v1/models` returned
versioned variant ids without parent aliases; gateway chat by friendly alias
returned `42`. Graceful sidecar shutdown exited cleanly. The preloader bypasses
normal all-provider startup and does not qualify that release path.
A second real SDK 2.4.0 sidecar run on cached
`Phi-4-mini-instruct-cuda-gpu:5`, restricted to physical GPU 1 and using the
same test-only CUDA discovery filter, returned the enum-constrained
`pick_color({"color":"blue"})` call over IPC in both non-streaming and
`stream:true` terminal results. The non-streaming usage totals were consistent,
and a tool-result turn returned “The color blue has been confirmed.” The
streaming request emitted no text frames; its completed tool call arrived in
the terminal result. The pool reported `inFlight: 0`, and the model was
unloaded before shutdown. This qualifies the real sidecar ChatSession IPC path
for this model, not normal all-provider startup or native cancellation.
A real SDK 2.4.0 sidecar run on cached
`qwen3-vl-2b-instruct-cuda-gpu:2`, using the same CUDA-only discovery filter and
physical GPU 1, passed a synthetic PNG containing a green square through the
ChatSession image path over IPC; the response identified it as “green” with
valid usage. The pool reported `inFlight: 0`; the model was unloaded and the
sidecar exited cleanly. This qualifies IPC vision for this model, not gateway
vision, packaged-app behavior, or normal all-provider startup.
A Continue 2.0.0 codebase-indexing run against the real SDK/core 2.4.0 gateway
used cached `qwen3-embedding-0.6b` variant
`qwen3-embedding-0.6b-cuda-gpu:1` on physical GPU 1. It completed 101
`/v1/embeddings` requests, populated 3,179 vector-cache rows for 782 indexed
paths, and ended with pool `inFlight: 0` and no indexing lock. This verifies
Continue's configured `embed` role and `codebase` provider against Flint's real
local endpoint; it does not qualify normal all-provider startup, retrieval
quality or packaged-app behavior. The separately replayed BYOM recipe is not
the cached catalog artifact used by Continue.
Inspection of the exact `v2.0.0-vscode` source shows `LanceDbIndex` persists
the vectors returned by `ILLM.embed()` unchanged, and the OpenAI embedding path
maps the response vectors without dimension slicing or a `dimensions` request
field. A paired GPU-1 capture on the cached catalog variant found that Continue
requested `encoding_format: base64` for two inputs, but the native gateway
returned HTTP 200 with two 1,024-component float arrays. Continue persisted
two 256-component all-zero vectors instead of either returned vector. The
bundled OpenAI client decodes the unlabelled float arrays as base64, accounting
for the bad cache rows. The gateway now encodes native float arrays as
little-endian float32 base64 for explicit base64 requests; float requests and
upstream errors retain their prior paths. Focused red/green gateway tests cover
both resident and autoloaded catalog models. A direct SDK/core 2.4.0 GPU-1
request through the patched endpoint returned two finite 1,024-component
base64 vectors with HTTP 200 and confirmed sidecar cleanup. A post-fix paired
Continue 2.0.0 run used an isolated portable VS Code 1.146.0 profile and the
same cached catalog variant on physical GPU 1. Its one two-input request
specified `encoding_format: base64` (request SHA-256
`63516bf8c3554622b9b4c081cdb865fcffd0a3645b7775eef926f8fc2f72a685`)
and received HTTP 200 with two 1,024-component vectors. The two
`lance_db_cache` rows also held 1,024 components; their little-endian float32
SHA-256 hashes exactly matched the decoded HTTP responses in order:
`f4e94b17222bd0a3a82f8947f28d42d9d49f14e66b15a1296da855f0bc6e8f6f`
and `95280885f7ec48fe9d42f061e881f2e2567843f64c67268c8db37c90fa08057e`.
The index lock was released and both the isolated IDE and sidecar shut down,
with native cleanup confirmed. This closes the cached catalog stored-vector
dimension/byte-parity gate for that controlled two-document index, not
large-workspace retrieval or installed-app behavior.
The portable BYOM embedding export was tested separately with Continue 2.0.0:
the client requested `encoding_format: base64`, which the local-model gateway
previously rejected with HTTP 400. After adding float32 little-endian base64
responses, an isolated two-document index received two 1,024-component vectors
over HTTP and persisted two 1,024-component `lance_db_cache` rows. Both stored
float32 hashes exactly matched the paired HTTP response bytes and the index
lock was released. This closes the BYOM-side dimension question. The paired cached catalog
failure and its successful post-fix Continue rerun are described above.
The SDK/core 2.4.0 catalog also exposes `qwen3-embedding-0.6b` and
`qwen3-embedding-8b`; their cached variants are CUDA-only. CUDA EP assets exist
in the local cache. Explicit CUDA registration succeeded; the cached Qwen3
0.6B variant returned two finite 1024-dimensional vectors through
`EmbeddingsSession` and the Flint gateway `/v1/embeddings` alias-rewrite path.
The native service returns the bare 2.4.0 `Model not found: X` alias rejection,
which the gateway recognizes. Flint's `embedTexts` IPC
handler returned two finite 1024-dimensional vectors on the 0.6B variant and
one finite 4096-dimensional vector on the 8B variant. Both cached variants
also returned embeddings through gateway alias autoload.
The cached 0.6B variant's `model.onnx` is 501,754,600 bytes with SHA-256
`9e0e70798d8563b2d2f72584a026cd1ba3b55ad0dd147e72c5cad2c969435be9`.
The separately built portable export's graph is 812,372,350 bytes with SHA-256
`c329c06087fc940b48491f32d66c5c46b7d0c89f0208014cf2388d9ae3dbae61`.
The cached `config.json` has `quantization_config.embeds: true` and an
8-bit input-embedding override; the portable export has `embeds: false`.
Their `tokenizer.json`, `vocab.json`, and `merges.txt` match byte-for-byte,
but the graphs and GenAI configs do not.
The SDK/core 2.4.0 public catalog identifies the exact CUDA variant as
`azureml://registries/azureml/models/qwen3-embedding-0.6b-cuda-gpu/versions/1`,
with parent `azureml://registries/azureml/models/qwen3-embedding-0.6b/versions/1`,
Apache-2.0 license, and declared `CUDAExecutionProvider`. These are catalog
metadata, not a remote artifact digest or observed active-provider identity;
the isolated metadata probe did not load or cache this variant.
This proves the cached artifact is not the measured portable export; it does
not identify the cached graph's source revision. An isolated SDK/core 2.4.0
sidecar copied this exact cached variant into its own catalog cache (without
registering it as BYOM), discovered and loaded the public alias and exact
variant, and evaluated the pinned SciFact corpus through Flint's gateway on
physical GPU 1. Across 5,183 documents and 300 judged queries (339 judgments),
its 1,024-component vectors reached **Recall@10 0.83256** and **nDCG@10
0.70513**. The same evaluator and pinned inputs gave the separately built
portable export 0.83489 and 0.70395, respectively; these are measurements of
different graphs, not interchangeable scores or evidence of provider identity.
The source's 12 file hashes were unchanged, IPC and gateway smoke vectors
agreed, and graceful shutdown was confirmed. The cached artifact's provenance
and active execution provider remain unverified. Reproduction inputs and commands are in the
[embedding recipe note](./spikes/qwen3-embedding-olive-recipe.md#retrieval-evaluation).
With physical GPU 1 selected by UUID, an isolated sidecar's normal unfiltered
registration reported TensorRT-RTX, CUDA, and WebGPU ready with no failed
providers. The cached Qwen3 0.6B CUDA variant then returned two
1024-dimensional vectors through `embedTexts` IPC and two matching-length
vectors through gateway alias requests. It was explicitly unloaded and
shutdown reported confirmed cleanup. Load still reported
`acceleration.active: null`; these vectors do not establish which provider
executed inference.
A source-pinned Qwen3 0.6B INT4 build used upstream revision
`97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3` and the local Olive recipe checkout
at `1ebab74ab474869c53575954fda0772cee723ecf`. Its isolated toolchain pinned
Python 3.12.12, Olive 0.11.0, Torch 2.6.0+cu126, onnxruntime-gpu 1.24.1,
onnxruntime-genai-cuda 0.12.2, Transformers 4.52.4, Accelerate 1.15.0, and
Datasets 3.6.0. The unchanged recipe's RTN pass failed while quantizing the
input embedding layer, so this build used `passes.r.embeds=false`; Olive's
optional TensorRT provider DLL was temporarily hidden for CUDA-only provider
registration and restored afterward. The 13-file export totals 828,305,485
bytes; `model.onnx` is 812,372,350 bytes with SHA-256
`c329c06087fc940b48491f32d66c5c46b7d0c89f0208014cf2388d9ae3dbae61`.
The export also received the README's post-export fixes: copy
`config_sentence_transformers.json` and set top-level `tie_word_embeddings`
to `true`.
An isolated SDK/core 2.4.0 sidecar imported a copy into a temporary cache,
registered CUDA, TensorRT RTX, and WebGPU without provider failures, and
autoloaded the local registration on its first gateway `/v1/embeddings` request.
With `CUDA_VISIBLE_DEVICES` restricted to physical GPU 1 by UUID, both the
gateway and `embedTexts` IPC returned two finite 1,024-dimensional vectors
for the same inputs, with zero maximum absolute difference. GPU 0 remained at
0% utilization in the before/after snapshots. This is inference smoke evidence,
not retrieval-quality or MTEB evidence. The upstream recipe remains unmodified;
the derived config and version-pinned environment are recorded in
[the Olive recipe note](./spikes/qwen3-embedding-olive-recipe.md).
A separate build/output replay using copied revision-pinned source inputs and
the checked-in config and the prior pinned Python environment matched the
original ONNX hash. Export preparation excluded Olive's absolute-path
`model_config.json`; the remaining 12 files total 828,266,615 bytes and have
no replay work-directory references in JSON. An isolated sidecar imported that
portable output into a fresh app home, restarted without re-importing, and
returned two finite 1,024-component vectors from both IPC and gateway alias
requests on physical GPU 1. Corresponding IPC/gateway vectors had cosine
similarity above 0.999999. Source hashes were unchanged; removal and both
shutdowns were confirmed. A second replay in a newly provisioned Python
3.12.12 venv restored the recorded requirements, passed `pip check`, and
produced the same 12 portable file hashes. Its separate isolated import,
fresh-process restart, IPC/gateway embeddings on GPU 1, source-hash check,
removal, and confirmed shutdown also passed. Wheel hashes and host driver
remain unpinned. A full-corpus SciFact test of the portable BYOM export
embedded 5,183 documents and 300 judged test queries through Flint's gateway
on physical GPU 1, with 1,024-component vectors, 339 relevance judgments,
Recall@10 0.83489, and nDCG@10 0.70395. Two documents exceeded Flint's
8,192-character admission limit and were explicitly truncated. Source hashes
remained unchanged, removal succeeded, and graceful shutdown was confirmed.
A separate copy/restart attempt exited with native Windows access violation
`3221225477` during accelerator registration after restart, before the
retrieval phase. A follow-up on the same portable export with GPU 1 selected by
UUID passed two additional copy/restart embedding probes but reproduced the
same access violation on a third, again during post-restart `ensureAccelerators`, before
model load. No diagnostic stderr or Windows Application fault event was
recorded for that untraced run; the native crash's cause and restart stability
remain open. The traced failure returned success from all three provider
registration calls before the restarted sidecar exited without an
`ensureAccelerators` reply.
Six further catalog-traced runs passed. A later boundary-traced run reproduced
the access violation inside the restarted SDK `Catalog.registerModel` call
after provider discovery and local catalog acquisition; the call did not
return. Its native trigger and the active provider remain unidentified. The
SDK's synchronous registration passed six isolated comparison runs. Flint now
uses that method only while re-registering owned models; new imports remain
async. Eight further uninstrumented GPU-1 copy/restart runs passed embedding
IPC/gateway parity, unchanged source hashes, removal, and confirmed shutdown.
One synchronous registration took 19 ms for this folder, but blocks the
sidecar event loop and does not prove the crash impossible for other models or
filesystems. The portable export lacks `inference_model.json` and cannot be
linked without altering its source. An isolated copy with that metadata added
passed three GPU-1 link/restart embedding runs, source-hash preservation,
junction removal, and confirmed shutdown. The BYOM gate remains open for
cached catalog-artifact provenance.
Qwen2.5
0.5B CPU rejected a real 38,708-word request during structural preflight (39,249
estimated tokens against a 32,768 limit), before any stream event or in-flight
model work. A cached Nemotron 0.6B CPU WAV transcription recognized the local test phrase.
The actual sidecar `transcribeAudio` path also recognized the local phrase
through `AudioSession` URI on `openai-whisper-tiny-cuda-gpu:3`; the CUDA EP
cache directory must be on the sidecar `PATH` for its cuDNN dependencies, and
the CUDA preparer now configures it before registration. Parakeet was refused
before load.
Qwen2.5 0.5B declares tool support, and strict `openai-live --require-tools`
passed all required checks when given its exact listed variant id, including
usage, streamed tool call, tool-result follow-up, tool-free final answer, and
disconnect. A separate direct `createGateway` harness with the native 2.4.0
listener passed the same required checks on the cached CUDA variant; its
streaming client-disconnect settled, but the runner cannot establish that
native generation stopped. This harness did not exercise sidecar startup or
IPC. Qwen3 0.6B CUDA also passed the strict tool, follow-up, and disconnect
checks through the direct gateway harness. The direct gateway probe against
Phi-4 Mini CUDA passed ordinary chat, streaming, and client-disconnect checks,
but did not produce the required tool call. Its optional `/v1/responses` probe
failed with HTTP 500 and a CUDA `invalid argument` diagnostic; the cause was
not isolated. The friendly alias
also passed inference/tool checks but was not a `/v1/models` row; SDK 2.4.0
returned full versioned variant ids without a `parent` alias in this probe.
Gemma 4 E2B CUDA (`gemma-4-e2b-it-cuda-gpu:3`) passed ordinary chat, usage,
streaming, disconnect, and `/v1/responses`; although catalog metadata declares
tool support, a required function call was rejected because structured tools
need model-published opening and closing markers. Mistral Nemo 12B CUDA passed
ordinary chat, usage, streaming, and disconnect, but its strict tool stream
ended without `[DONE]`; its optional `/v1/responses` check returned HTTP 500
with a CUDA `Zero` invalid-argument diagnostic. Neither is positive evidence
for structured tool calling on Gemma 4 or Mistral Nemo.
Strict `openai-live --require-tools` CUDA probes for SmolLM3 3B, Ministral 3
3B, and OLMo 3 7B also passed ordinary chat, usage, streaming, and disconnect,
but each lacked `[DONE]` and a completed tool call; the cause was not isolated.
OLMo 3's optional `/v1/responses` check returned HTTP 500 with a CUDA `Zero`
invalid-argument diagnostic. Direct SDK 2.4.0 `createSessionChatClient` probes
on cached `smollm3-3b-cuda-gpu:1` and
`ministral-3-3b-instruct-2512-cuda-gpu:2`, with only CUDA requested for
registration and inference restricted to the RTX 4080 by UUID, failed before
generation: `ChatSession` requires model-published structured-tool opening and
closing markers. On cached `Phi-4-mini-instruct-cuda-gpu:5`, the same direct
adapter returned the enum-constrained `pick_color({"color":"blue"})` call in
both streaming and non-streaming requests, with `finish_reason: tool_calls` and
a call ID; the non-streaming response included usage. A tool-result follow-up
returned "The tool confirmed the color blue." On that same model, JSON-object
response format returned `{"ok": true}`, and `max_tokens: 1` returned
`finish_reason: length` with one completion token. These direct sessions do not
establish sidecar IPC or gateway behavior. A real SDK/core 2.4.0 sidecar IPC
probe on the same cached Phi-4 Mini variant, restricted by CUDA device UUID to
physical GPU 1, returned the required `pick_color({"color":"blue"})` call and
a successful tool-result follow-up. The load reply reported
`acceleration.active: null`, so actual execution-provider activation is not
independently attested; GPU 0 utilization was 0% in the before/after snapshots.
A direct `createSessionChatClient` probe on
`qwen3-vl-2b-instruct-cuda-gpu:2`, with the CUDA runtime prepared and inference
restricted to physical GPU 1, passed native ChatSession image input: an
in-memory synthetic PNG containing a green square was identified as `Green`.
This is not evidence for sidecar IPC or gateway vision.
On cached `qwen2.5-0.5b-instruct-cuda-gpu:4`, two direct `ChatSession`
load/infer/unload cycles, with the CUDA runtime prepared and inference
restricted to physical GPU 1, each answered `42` to the same arithmetic prompt.
This verifies SDK model reuse, not sidecar or pool lifecycle.
A real SDK/core 2.4.0 sidecar IPC cancellation probe on cached
`qwen2.5-0.5b-instruct-cuda-gpu:4` (friendly alias `qwen2.5-0.5b`) used
physical GPU 1 by UUID and filtered EP discovery to CUDA. After the first
`Here` delta, `cancelChatRequest` acknowledged `{ok: true}`; the terminal reply
settled 30 ms later with four characters, no `finish_reason` or certainty, and
pool status `inFlight: 0`, `streaming.active: false`. A subsequent chat returned
non-empty text and shutdown exited cleanly. The sidecar load reply reported
`acceleration.active: null`, so actual EP activation is not separately
attested. This qualifies sidecar cancellation settlement and reuse, not native
inference quiescence or normal all-provider startup; do not treat terminal
`ok: true` or pool drain as proof that native work stopped.
A separate SDK/core 2.4.0 sidecar service probe used the same CUDA-only provider
filter and loaded no model. The loopback gateway returned HTTP 200 for `/status`
and `/v1/models` (99 rows); the listing exposed the cached Qwen CPU and CUDA
builds as full versioned `id` values without a `parent`. The pool stayed empty,
`stopService` withdrew the published endpoint, and the sidecar exited 0.
This qualifies listener/gateway start-stop and health on the filtered setup, not
normal all-provider startup or inference.
A fresh sidecar run on the default Flint profile then exercised normal provider
registration: `ensureAccelerators` registered CUDA, TensorRT RTX, and WebGPU
with no failures, and confirmed the existing Llama 3.2 3B local registration
without replacing it. With no model loaded, the loopback gateway returned HTTP
200 for `/status` and `/v1/models` (150 rows); `stopService` and runtime shutdown
completed successfully. This qualifies no-model all-provider sidecar startup
and listener lifecycle, not UI autostart, inference, or installed-app behavior.
On the Qwen2.5 0.5B CUDA variant, the direct gateway also returned valid JSON
for `response_format.type=json_object`, honored `tool_choice=required`, and
reported `finish_reason: length` at `max_tokens: 1` with one completion token.
The request accepted temperature, top-p, top-k, and seed values; this confirms
the gateway/native request path, not sampling semantics, IPC, or fallback. A
malformed function schema with an unsupported JSON Schema type was rejected on
this variant with HTTP 400 `invalid_request_error` and no `choices`, rather
than a success-shaped response. With `parallel_tool_calls: false` and
`tool_choice: required`, a prompt requesting two distinct functions returned
one tool call, not two.
The same variant returned a `completed` `/v1/responses` result with string
`output_text`; a streaming request returned `text/event-stream` and a
`response.completed` event. A separate required-tool request returned one
`function_call` for `pick_color` with JSON arguments.
Package revision/license provenance, broader lifecycle and provider checks,
additional tool-capable model families beyond Phi-4 Mini, Qwen2.5, and Qwen3,
the 2.2.0–2.3.1 gates on this pin, and installed-app qualification remain open.
Flash-Next conversion or architecture enablement is not a release gate.

Do not publish 0.11.0 until the qualification gates above pass. Keep completed
work in reviewed changesets; do not merge unrelated accumulated changesets as
part of this release.

## 1.0 qualification

### Benchmark Preview qualification

- Keep Benchmark Preview opt-in and off by default until a packaged Windows run
  records model pinning, Stop, Resume, served-variant reporting, and a gateway
  `503` during a run.
- Confirm the persisted run remains authoritative after reload and that a
  historical read cannot be replaced by stale live polling.
- Record the exact packaged build and models used. Do not reinterpret full-call
  response time as time to first token, and do not score stored expected answers.

### Tool and retrieval boundary

The helper shipped in 0.10.0. Keep these security and behavior constraints in
force through 1.0 qualification.

- The public web-search/retrieval tool stays narrow and read-only. It does
  not turn Playground into an autonomous agent runtime.
- Run retrieval outside the Foundry sidecar in a separately supervised helper.
  Give it only the explicit query or URL, a minimal environment, bounded JSON
  input/output, no filesystem operation or path inputs, and no conversation
  archive, model cache, browser profile, or ambient credential access.
- HTTPS retrieval must reject loopback, private, link-local, multicast, `.local`,
  `file:`, `data:`, UNC paths, non-approved ports, DNS rebinding, and redirects to
  a denied destination. Bound redirects, decompressed bytes, response time,
  concurrency, calls per turn, and returned text.
- Treat every result as untrusted reference content. Strip active content.
  Retrieved text cannot authorize a fetch or a later search; the user's consent
  does. Show citations and an audit trail, and require conversation-level opt-in.
  The model may request a short public search. Flint confirms that query. A
  search written after the model has already read web text in the same request
  is confirmed again even when a standing grant exists. Fetch authority is an
  exact match against URLs typed or attached in the current send, or against
  search-result URLs the user has allowed.
- Permit at most two model tool rounds with no more than two calls in a round.
  A malformed call is that call's error. A missing id, a duplicate id, or more
  than two calls fails the send. Force the follow-up completion tool-free so
  retrieved content cannot start another network action. While the consent
  dialog is open the chat shell is inert, so Stop cannot be clicked; Escape
  declines.
- Keep fetched bodies request-scoped and memory-only by default. They do not
  enter conversation archives, localStorage, benchmark storage, diagnostics,
  access logs, model indexes, or unrelated processes. Return bounded text only
  to the owning tool call so the selected model can answer; persist only
  user-visible citations and intentionally retained summaries.
- The first implementation is public and unauthenticated. Authenticated sites,
  cookies, browser automation, uploads, shell/file tools, and autonomous
  multi-step loops remain out of scope.

### Release and infrastructure qualification

- Preserve the existing renderer/sidecar security boundary and classify every
  new helper command by effect, admission, timeout, cancellation certainty, and
  shutdown ownership before exposing it to the model.
- Run unit, contract, sidecar E2E, bundle verification, and packaged Windows
  runtime smoke. Record any clean-machine or signed-installer dogfood completed
  for this release.
- Reconcile operator/release docs with the current published stable line.
  Before publication, ensure the generated changelog, version files, artifacts,
  and updater metadata all describe the same reviewed build.

## 1.0 execution waves

These waves define the continuing 1.0 acceptance bar. Their implementation is
present in the released line; remaining work is qualification, recorded
dogfood, integration version pins, and corrections found during that work. Do
not compensate for a slipped gate with RAG, a scheduler, or broad tool execution.

### Wave 1 — Security and CI

Rubber-duck: this is not a security product. The boundary already exists; 1.0 requires it audited, named, and gated. `npm ci` extracts packages and runs the SDK installer before a root `preinstall` restore can stick, so CI uses `npm run ci:deps` (extract with `--ignore-scripts`, restore `runtime/foundry-native-cache`, `npm rebuild`) before `skipIfPresent`. `updater:allow-download-and-install` stays for the stable updater path. PATH `node -v` stays (post-1.0 spawn-surface). CLI version checks are out — packaged users have no CLI.

- Prune unused grants: opener plugin (renderer never imported it); `$RESOURCE` read scope (sidecar paths are native `trusted_runtime_paths`); redundant `core:tray:default` / `core:menu:default` (already in `core:default`). Keep `$RESOURCE` write deny. Comment each survivor.
- Dedicated `src/lib/security-boundary.test.ts` that fails CI if opener/spawn/kill return, `$RESOURCE` reads return, shell execute is more than `node -v`, IPC allowlists drift, or BYOM `isInsideRoot` accepts a traversal.
- Cache `runtime/foundry-native-cache` in CI/release. CI runs `npm run ci:deps` (extract packages, restore cache, `npm rebuild`) so the SDK `skipIfPresent` installer sees the cores. There is no root `preinstall` restore; that hook cannot run before the SDK installer.
- Sidecar `init` warns (does not fail) when the loaded SDK or core version differs from the pin. The 0.11.0 pin is `2.4.0`, owned by the SDK/BYOM shipping plan above. Published 0.10.0 still carries the previous pin until that release.

### Wave 2 — Native lifecycle and conversation integrity

Rubber-duck: a Svelte tray created on first close is not renderer-independent. Native tray must exist from **app start**. Close-to-hide stays a frontend setting. Native Quit currently does not flush conversations — that is the handshake PR, not the tray PR. Stream-by-conversation-id does not touch Rust and is a third PR.

- Native tray Open/Quit installed at startup (`src-tauri/src/tray.rs`). Frontend no longer creates a `TrayIcon`.
- `ExitRequested` prevents exit, emits `flint-quit-flush`, waits for `ack_quit_flush` or 2s, then exits. Renderer death cannot hang quit. Hide/blur/pagehide stays a best-effort extra.
- Stream updates follow the originating conversation id (`applyMessagePatch` when that chat is not visible). Stop applies to the visible conversation only.

### Wave 3 — Cancellation and timeout certainty

SDK 2.1.0 through 2.4.0 expose native request and streaming cancellation.
2.2.1 also cancels non-streaming chat when the client disconnects. IPC
ChatSession calls now pass an AbortSignal and hold their activity lease through
the terminal SDK response; real-model race qualification remains open. Legacy
clients and gateway disconnects still suppress output and drain without
establishing native cancellation. Stop must remain honest until native
completion or cancellation is established.

- Chat streaming: Stop sends IPC cancellation; the SDK stream's terminal response is awaited before the sidecar releases its activity lease. The UI remains honest that completion can win the cancellation race.
- Compare: no Stop control. The running state says the run cannot be cancelled — wait for slots.
- Audio: transcription cannot be stopped once started; Voice says so beside Transcribe while it is in flight.
- Gateway disconnect already destroys upstream. The embeddings **path** is present
  (Wave 9). Full RAG stays after 1.0.

### Wave 4 — Observability

- Gateway access log is metadata only (`source: 'gateway'`, no bodies). TTFT/tok/s are null when unobservable. Monitor table and CSV show TTFT / prompt tok/s / decode tok/s.
- Bounded health ring (`getHealthRing`) records init and service start/stop. Diagnostics export includes it.

### Wave 5 — Endpoint trust

- Diagnostics **Test local endpoint** checks envelope, chat round-trip, stream `[DONE]`, usage (blocked if absent), disconnect abort, and tool_calls (pass or explicit not-verified). Catalog `supportsToolCalling: false` skips the tools prompt.
- Model details show **Flint-verified** from the last self-test in this session, distinct from catalog declarations.
- Continue/Cline/OpenClaw: do not invent version pins. Continue stays `verified` with “version not pinned”; Cline remains Unverified; OpenClaw remains community until a recorded dogfood.

### Wave 6 — Operator docs and UX qualification

- Operator runbook: [ADMIN.md](./ADMIN.md). USER_GUIDE sidecar troubleshooting matches bundled Node.
- Empty/error copy: catalog empty on Models and first-run; Chat shows “No chat model loaded.” Packaged Windows walk of the checklist is still a Wave 7 dogfood tick.

**1.0 UX checklist**

- First-run coach covers runtime → model → chat → optional endpoint and is recoverable from Help.
- Settings → Network bind/port apply-and-restart and WSL mirrored-vs-NAT copy are truthful.
- Monitor exposes RAM/VRAM gauges, eviction/pin controls, and access-log export.
- Catalog failure, sidecar failure, and "no chat model loaded" are visible empty/error states rather than success-shaped UI.

### Wave 7 — Packaged smoke and dogfood

- CI (Windows): after the debug Tauri build, `FLINT_RUNTIME_SMOKE=1` launches `Flint.exe` and exits 0 when the sidecar phase is `ready` (`npm run smoke:runtime`). Does not load a model.
- Process still required: signed clean-machine install, download/load/chat/stop/quit/relaunch. macOS: recorded `install-macos.sh` boot as evaluation evidence.

### Wave 8 — Stable updater channel

- About: Install / progress / Restart to update / Later against the wired updater plugin.
- Stable releases use `releases/latest`; drafts and prereleases are not updater
  targets. Rollback is the previous installer documented in
  [RELEASE.md](./RELEASE.md).
- Keep updater install evidence and rollback instructions current for every
  release on the path to 1.0.

### Wave 9 — Embeddings path

Embedding-model path, not RAG.

- Gateway classifies `/v1/embeddings` and autoloads like chat (proven in tests). Chat JSON/SSE normalization stays chat-only.
- BYOM import detects embedding folders and does not require a chat prompt template.
- Sidecar `embedTexts` uses the `EmbeddingsSession` adapter (falling back to `createEmbeddingClient()` on SDK builds without it) with the same pool inFlight fencing as chat. Batches are bounded (32 strings, 8k chars each).
- Diagnostics self-test **blocks** embeddings when no embedding model is present; **passes** when `POST /v1/embeddings` returns a numeric vector.
- Continue 2.0.0 indexing works without an account when its VS Code adapter
  supplies local IDE settings and an `embed`-role model plus an indexing
  context provider are configured. A synthetic-vector mock run sent 2,167
  inputs in 18 batches and persisted 2,167 embedding-cache rows. A separate
  run against Flint's real SDK/core 2.4.0 gateway used cached
  `qwen3-embedding-0.6b-cuda-gpu:1` on physical GPU 1; it completed 101
  `/v1/embeddings` requests, populated 3,179 vector-cache rows across 782
  indexed paths, and ended with `inFlight: 0`. The real run used a CUDA-only
  provider filter and an isolated VS Code profile. This verifies actual
  Continue codebase indexing through Flint, not normal all-provider startup,
  retrieval quality or packaged-app behavior; it used the cached catalog
  variant rather than the separately replayed BYOM artifact.

### SDK 2.x session migration

This workstream replaces Flint's deprecated OpenAI-shaped model-client
constructors while keeping the existing IPC and gateway contracts.

- **Chat:** use `ChatSession` as the primary path with the OpenAI-JSON request
  bridge; retain `createChatClient()` only for SDK builds without the session
  surface. Preserve generation settings, tool controls, streaming finish
  reasons, cancellation behavior, and model-specific error boundaries.
- **Embeddings:** use the stateless `EmbeddingsSession` bridge; retain
  `createEmbeddingClient()` only until the supported SDK floor no longer exports
  it. Preserve OpenAI-shaped results and surface both primary and cleanup
  failures.
- **Audio:** use `AudioSession` with the proven URI shape for Whisper-family
  models and raw 16 kHz mono PCM through `ItemQueue` for Nemotron. Refuse
  Parakeet when its unsupported family is determinable before loading, defer
  ambiguous aliases to the runtime-selected variant, and never retry through
  deprecated `AudioClient` or HTTP. The Whisper URI path passed and Parakeet
  was refused before loading on the 2.4.0 pin; keep the refusal until a
  supported Parakeet path passes on a later pin.
- **Prompt metadata:** keep Flint's BYOM template validation independent of SDK
  `PromptTemplate` types.

**Acceptance gate:** chat and embeddings must run without deprecated client
constructors on the supported SDK; audio must use the URI request for Whisper,
the raw-PCM queue for Nemotron, and an explicit unsupported result for Parakeet,
while conservatively resolving opaque aliases before loading; all three paths must preserve IPC, gateway,
logging, activity-fence, error, and cancellation semantics; and the test matrix
must cover session exports, legacy-only exports, missing legacy methods, malformed
output, constructor failures, disposal failures, and streaming cancellation.

## Acceptance gates for 1.0 workstreams

Each wave must remain satisfied through subsequent stable releases and 1.0
qualification. Extra audio-decoder work has no 1.0 gate.

- **Security gate:** Capability JSON is pruned and commented; the boundary suite fails if unused dangerous grants return or sidecar allowlisting/IPC/BYOM containment regress.
- **Installed-path and lifecycle gate:** Native tray Open restores the main window and Quit terminates the app on packaged Windows; macOS Dock reopen restores the main window (already native); single-instance launch refocuses the existing instance; process termination tears down the sidecar child without orphans; recovery controls operate if the renderer webview fails; quit waits for a conversation-flush ack or a bounded timeout.
- **Cancellation gate:** Every in-bar request type has an honest certainty (cancelled / unknown / complete). Stop never claims native quiescence. Resource protection holds until native completion or the child is gone.
- **Observability gate:** Diagnostics and Monitor display load time, TTFT, prompt tok/s, decode tok/s, and resolved provider/variant without an aggregated "tokens/sec"; gateway samples appear in the access log when observable; diagnostics export includes the health ring.
- **Endpoint and agent integration gate:** User-facing self-test verifies `/v1/models` envelope, then, for every listed chat id and parent alias, model ID reuse in chat completions, streaming termination with `[DONE]`, `usage` when the model emits it, and either valid `tool_calls` or an explicit not-verified label. Embedding ids get an embeddings check and speech ids get a transcription check. Disconnect cancellation is one endpoint-level probe after every model probe, not a per-name verification. Continue, Cline, and OpenClaw recipes are pinned to tested client versions.
- **UX gate:** The checklist in Wave 6 holds on a packaged Windows build.
- **Docs gate:** Operator runbook exists and is indexed; USER_GUIDE sidecar troubleshooting matches bundled Node.
- **Updater UX gate:** In-app updater displays download progress, notifies when an update is ready, prompts to restart, and supports deferral.
- **Ship gate (0.11.0):** SDK/BYOM qualification and the release-preparation
  gates above are recorded; version/changelog/artifacts/updater metadata agree;
  publish as a full stable release only after review.
- **Ship gate (1.0.0):** Signed Windows clean-machine dogfood and stable-channel
  updater evidence are recorded; 1.0.0 is published stable.

## Decisions

<a id="workstream-c-thin-native-ownership----expedited"></a>
### Native ownership and runtime architecture

1. **Expedite a thin Rust lifecycle and process-supervision layer.** Native code owns single-instance behavior, macOS Reopen, tray Open/Quit from startup, the quit-flush handshake, and exactly one runtime child.
2. **Do not expedite a wholesale Foundry-to-Rust rewrite.** Keep the existing sidecar as the sole owner of the native Foundry manager, catalog, pool, and execution providers while correcting its behavior. Preserve native crash isolation from the desktop process.
3. **Do not wait for Rust to fix data loss or runtime correctness.** Hydration, request ownership, service transitions, streaming leases, pins, and honest failure reporting are independently shippable fixes on the existing transport.
4. **Linux-only work is deferred.** Preserve existing Ubuntu checks and platform mappings. Continue Linux-specific work only if it is already part of another feature; do not open a new Linux workstream until the Windows 1.0 production bar is complete.
5. **Separate corrections from new features.** Make existing controls effective and truthful first. Richer options follow the correctness gates they depend on.
6. **Use small, reversible changes.** Do not combine a data-format migration, transport cutover, SDK upgrade, and model-policy change in one release.
7. **1.0 is one local endpoint.** Drop the multi-endpoint manager from the 1.0 bar. Sticky routing, failover, and cloud escalate stay unscheduled in BACKLOG. Azure connections stay post-1.0.
8. **1.0 production is Windows.** macOS Apple Silicon stays evaluation-only (unsigned + install script). Apple Developer ID notarization is a post-1.0 calendar item, not a 1.0 code workstream. Signing Flint.app does not un-quarantine the SDK's ad-hoc dylib.

## Rubber-duck decisions

| Challenge | Decision |
|---|---|
| Would rewriting the backend fix conversation loss? | No. Correct hydration, storage identity, and asynchronous ownership in the frontend first. |
| Should the emergency fix introduce a new database? | No. Stop destructive writes immediately; give the subsequent storage migration its own compatibility gate. |
| Does keeping old storage make every downgrade safe? | No. Define a supported rollback version that understands the new format, including conversations created after migration. |
| Does a timeout or Stop acknowledgement mean inference stopped? | No. Separate caller completion from native-operation completion. SDK 2.1.0–2.4.0 cancellation is cooperative and can race completion; 2.2.1 also cancels non-streaming chat on client disconnect. Retain resource protection until the terminal native outcome is established or the owning process is gone. |
| Can a missing heartbeat prove the sidecar crashed? | Not while synchronous native work can block its event loop. Distinguish unresponsive from exited; avoid restart loops and duplicate work. |
| Would moving inference into Tauri prevent all windows disappearing? | It can do the opposite: a native fault would enter the desktop process. Keep inference in a supervised process even if its implementation later becomes Rust. |
| Can a worker thread initialize another Foundry manager? | Not safely as a workaround for the process-global native core. Keep one manager owner; do not duplicate ownership across Node workers. |
| Can the old and new transports both run during migration? | Not as concurrent runtime owners. Select one transport at startup and switch only after the previous child is confirmed stopped. |
| What happens when every model is busy, pinned, or of unknown residency? | Queue within a declared bound or refuse admission clearly. Never bypass protection or assume memory was released. |
| Is fixing hidden-tab polling sufficient for background protection? | No. Sampling/evaluation must survive a failed renderer; native notification delivery must not depend on the hidden webview. |
| Do signing credentials block correctness fixes? | They block the relevant signed distribution, not implementation or approved local testing. Do not weaken release signing or bypass managed-device policy. |
| Can shared packaging work become a Linux release project? | No. Fix host-versus-target selection for existing targets; defer Linux formats, matrices, distro qualification, and release claims. |
| Does 1.0 require the seven roadmap criteria as originally written? | No. The bar is operationally trustworthy **local** operations. Keep the seven headings; the content must be doable or not-done. |
| Is the multi-endpoint manager a 1.0 requirement? | No. `EndpointProfile` CRUD is unused. Scheduler/failover/cloud escalate stay Future features. Criterion 2 is one local endpoint with honest cancellation, recovery, and health. |
| Is unsigned macOS part of the 1.0 production promise? | No. Evaluation-only. 1.0 production is Windows. |
| Must 1.0 ship a time-series health store? | No. Bounded in-process health ring plus diagnostics export. |
| Is UX maturity missing? | No. It was unscoped. Coach, Network/WSL, and Monitor memory UX exist; 1.0 qualifies them. |
| Must we component-test `+page.svelte`? | No. Keep extracting into `src/lib/*.ts`. 1.0 testing is unit + contract + sidecar E2E + one packaged Windows smoke. |
| Is BYOM `/v1/embeddings` a 1.0 blocker? | No. The cached Qwen3 0.6B and 8B catalog models are qualified through the gateway and sidecar IPC. A source-pinned Qwen3 0.6B CUDA INT4 recipe passed fresh pinned-environment replay and BYOM embedding smoke; retrieval-quality evaluation remains open. 1.0.0 recipes are chat completions; full RAG stays after 1.0. |
| Broader WebM/Opus/MP3 decoder for 1.0? | No. Browser `decodeAudioData` → 16 kHz WAV already ships. Document supported formats. Word-level timestamps stay upstream-blocked. |
| Must CI install the MSI to ship 1.0? | No, if clean-machine dogfood is recorded. Staged-layout smoke in CI; msiexec automation is later. |
| Is the updater broken? | No known wiring gap. Stable releases resolve through `releases/latest`; drafts and prereleases are intentionally invisible. Keep install/rollback evidence current before 1.0. |
| Native tray vs frontend tray? | Native tray from app start, not a Svelte tray created on first close. Dock Reopen is already native. Quit-flush handshake is separate. |
| Conversation data loss on quit? | 1.0. Native `ExitRequested` → flush → ack. |
| In-flight generation dropped on conversation switch? | 1.0. Route by originating conversation id. |
| Settings baseline editor, export path proof, inventory re-take, Compare without HTTP? | Post-1.0. |
| "No end-user Node"? | Already true for packaged builds. Further spawn-surface shrinkage is post-1.0. |

## 1.0 workstreams

| Capability | Target scope | Wave |
|---|---|---|
| **Capability audit and boundary suite** | Pruned `default.json` plus a dedicated security suite. | 1 |
| **CI Foundry native cache and SDK pin** | Cache nuget payload; exact SDK pin; startup warning. | 1 |
| **Native tray and quit flush** | Renderer-independent Open/Quit; `ExitRequested` handshake. | 2 |
| **Conversation-id stream routing** | Background generation finishes in its archive. | 2 |
| **Cancel/timeout certainty** | Honest certainty on chat, gateway, audio, compare. | 3 |
| **Gateway metrics and health ring** | TTFT/tok/s in UI and logs; bounded health history in diagnostics. | 4 |
| **Behavioral self-test and verified recipes** | In-app runner; catalog vs verified labels; pinned Continue/Cline/OpenClaw. | 5 |
| **Operator runbook and UX qualification** | Admin doc + checklist holes only. | 6 |
| **Packaged Windows smoke and dogfood** | Staged-exe ready-check in CI; recorded clean-machine install. | 7 |
| **Updater install UX and stable channel** | Progress/restart/defer; full releases on `releases/latest`. | 8 |
| **Embeddings path** | Gateway autoload, BYOM without chat template, `embedTexts`. | 9 |

Post-1.0 (not in the table): extra audio decoders, word-level timestamps,
multi-endpoint scheduler, Azure connections, curated ONNX catalog, Apple
notarization, Linux, full RAG, and broad tool execution. The bounded public web
retrieval boundary above is the narrow exception; it does not authorize those
larger workstreams.

### Source anchors

- Data/requests: `src/routes/+page.svelte`, `src/lib/conversation-repository.ts`, `src/lib/conversation-store.ts`, `src/lib/conversation-session.ts`, `src/lib/conversation-settings.ts`, `src/lib/conversation-export.ts`, `src/lib/chat-request.ts`.
- Runtime transport: `src/lib/sdk.ts`, `src/lib/operation-outcome.ts` (transport tests: `src/lib/sdk-transport.test.ts`).
- Service/inference: `sidecar/foundry-sidecar.js`.
- Pool/gateway: `sidecar/gateway.js`, `sidecar/pool-eviction.js`, `sidecar/inference-metrics.js`.
- Models/import: `sidecar/byom-import.js`, `sidecar/prompt-template.js`, `sidecar/model-registry.js`.
- Audio/memory: `sidecar/audio-format.js`, `src/lib/memory-watchdog.ts`, and `transcribeLongAudio` in `src/routes/+page.svelte`.
- Desktop/packaging: `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `scripts/verify-bundle.cjs`, `scripts/smoke-bundled-node.cjs`, `vite.config.js`.
- Integrations: `src/lib/integrations.ts`.

Follow symbols rather than line numbers; the review-baseline line ranges these anchors originally carried no longer track the tree.

## Gate for reconsidering a Rust runtime replacement

Revisit only after the critical data/runtime findings have been corrected and native supervision is stable:

- Supported Rust/native bindings cover the required Windows/macOS catalog, variants, EPs, streaming, multimodal, audio, and model/cache operations.
- The same behavioral contract covers both implementations, including partial failure, cancellation uncertainty, and process recovery.
- A bounded prototype demonstrates a material benefit in responsiveness, reliability, startup, or distribution cost. Language preference alone is not sufficient evidence.
- There is still one manager/pool authority, and native failure remains isolated from the desktop process. `spawn_blocking` alone is not process crash isolation.
- Cutover/rollback does not require simultaneous cache/data migration, duplicate runtimes, or replaying uncertain operations.

The near-term destination is a **native desktop supervisor with a reliable, replaceable runtime process**, not a deadline-driven removal of Node.
