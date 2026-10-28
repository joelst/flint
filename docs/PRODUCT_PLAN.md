# Flint reliability execution plan

**Status:** **0.10.0** is the current published stable release. **0.11.0** is
the next release and carries the SDK 2.1.0 / real-BYOM work below. The external
Llama 3.2 3B ONNX GenAI model has passed CPU registration, IPC chat, and
buffered/streaming gateway chat; package provenance, broader lifecycle and SDK
qualification, and installed-app evidence remain. No 1.0 date until the
remaining process gates in [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) are done.

**Scope:** 1.0 production is Windows. macOS Apple Silicon remains evaluation-only (unsigned). Linux is deferred.

**Release ownership:** [CHANGELOG.md](../CHANGELOG.md) owns version assignments and release history. [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) owns the forward plan through 1.0 and the 1.0 release bar. This document owns 1.0 implementation sequencing and acceptance gates. [BACKLOG.md](./BACKLOG.md) holds deferred and post-1.0 work.

## 0.11.0 SDK/BYOM release preparation

### SDK 2.1.0 and real BYOM shipping plan

**Status:** The integration branch pins SDK 2.1.0 and contains local-catalog
registration, merged frontend discovery, local load/delete handling, runtime
version reporting, and live-probe scripts. The linked external-model spike
demonstrates CPU inference through IPC and the session-backed OpenAI gateway.
Unsigned Windows packaging and bundle-resource verification also pass; these
are not installed-app qualification or full SDK compatibility. Do not publish
the SDK/BYOM changeset until the remaining gates below pass.

**Scope:** Qualify every existing Flint model operation on 2.1.0: discovery,
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
and must not block SDK 2.1.0/BYOM shipping.

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
[spike evidence](./spikes/foundry-2.1.0-spike.md#go--no-go). Package provenance
and the remaining lifecycle/provider checks still need qualification. A
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
| 1 | SDK/native compatibility and startup | Exact 2.1.0 JS package and matching native assets; accelerator registration precedes the catalog snapshot/local-registration work; one manager per process; generation-owned readiness and About data; existing catalog operations still work. |
| 2 | Reliable local-model lifecycle | Durable, collision-safe registrations with explicit task/provider/device/context/capability metadata; copy/link/restart/recovery/unregister/delete matrix passes without modifying or deleting external assets. |
| 3 | Real BYOM sessions | Control model and genuine external package produce meaningful non-streaming and streaming answers through Flint IPC, including a fresh launch and HTTP service off. |
| 4 | BYOM OpenAI endpoint | The same registered models appear in gateway discovery and work by advertised name and alias, cold and resident, with streaming, tool results, usage, correct errors, admission, and activity accounting. Flint's gateway must handle local registrations without exposing the native listener's 404. |
| 5 | SDK 2.1 feature adoption | Native cancellation, download cancellation, tool-call fixes, parameter/usage/output-limit handling, and audio behavior are exercised on real models; unsupported features fail explicitly. |
| 6 | Installed-app qualification and release | Full automated gates plus a fresh target-specific Windows package, installed-app BYOM dogfood, source-file preservation, and updater/rollback evidence pass for the same release candidate. |

Steps 1-2 precede 3; 3 precedes 4; 5 builds on the same lifecycle and inference
ownership, and all precede 6. The non-catalog spike's package/catalog selection
can run alongside steps 1-2; its Flint inference matrix closes steps 3-4.
Each implementation slice gets its own focused changeset and review;
do not combine a runtime replacement or storage-format change with this upgrade.

**1. SDK/native and startup**

- Audit the installed 2.1.0 declarations and actual calls, not just release
  notes: local `Catalog`, `MutableModelInfo`, session/request APIs, cancellation,
  download signals, and metadata getters. Prefer session paths; test that normal
  2.1.0 operations never invoke deprecated clients. Compatibility fallbacks must
  not hide a primary inference error or submit it a second time.
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
  native listener behavior. The Llama 3.2 3B CPU run passed IPC, gateway
  discovery, buffered chat, streaming chat, and source-file integrity.
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

**5. Native 2.1 feature completion**

- Wire `Request.cancel()` for active one-shot work and the streaming
  `AbortSignal`/terminal `response` contract. Preserve completion-vs-cancel
  races and queued-request semantics; retain residency protection until native
  completion/confirmed cancellation or child exit, not until iterator break or
  the UI Stop acknowledgement. Exercise gateway disconnect independently.
- Wire cooperative download `AbortSignal` cancellation and retain partial-file
  cleanup/reporting. A checkpoint delay is not proof cancellation failed; an
  acknowledgement alone is not proof the download stopped.
- Prove Qwen enum arguments, fragmented/cumulative tool calls, malformed-call
  recovery, a tool-result follow-up, unique ids, and a tool-free final answer.
  Keep Llama text-call compatibility model-scoped and subject to the existing
  consent, allowlist, two-round, size, and schema limits.
- Add a bounded discriminated transport representation for SDK custom/raw-text
  tools if exposed through Flint's public contracts, with explicit support or
  rejection on each transport. Never JSON-parse a custom payload as a function
  argument or add an executor to Playground.
- Verify sampling, reasoning, tool-choice, structured output, usage and
  output-limit/finish reasons across IPC, fallback, and gateway. Resolve the
  imported code's silent removal of every frequency penalty: supported values
  must preserve semantics; unsupported non-neutral values need an explicit UI
  and API outcome, not a successful response that hides an ignored setting.
- Re-probe Whisper URI and Nemotron PCM/language behavior on 2.1.0; do not infer
  success from the old 2.0.1 shapes or claim native word timestamps. Run a real
  embedding package through both `embedTexts` and `/v1/embeddings` with numeric,
  finite vectors before claiming end-to-end embedding support.
- Evaluate `ChatSession.preflightRequest` for exact structural token admission
  on native session paths. Preserve whole-turn packing, reply reserve and
  untrusted-envelope rules; structural fit does not reserve runtime memory.

#### Required evidence and release decision

For each real model, record source URL/revision, artifact hashes, conversion
recipe/version, license, quantization, task, template, provider, device, RAM/VRAM,
context/output limits, SDK/core/native versions, app commit/build, served id,
commands and results. Keep model weights and prompt bodies out of the repo.
Store repeatable measurements with the existing spike evidence; keep this plan
for remaining gates, not a running history.

The live runner must make an absent requested model, missing required usage,
malformed/absent tool call, or absent tool-result turn fail the relevant gate.
Its current optional `model-listed`/`usage` checks and HTTP-only tool success
are not sufficient. Run disconnect last, after all functional probes; a client
abort proves neither native quiescence nor released memory.

| Qualification | Required checks |
|---|---|
| Automated | `npm run check`, `npm run build`, `npm run verify:ipc-contracts`, `npm run verify:markdown-links`, `npm test`, `npm run test:coverage`; native BYOM E2E and both live-runner self-tests; new guards demonstrated red then green. |
| Real models | Copy and link, no-metadata import, direct IPC with HTTP off, gateway discovery/chat/stream/tools, restart/recovery, unload/reload/delete with unchanged external source; CPU control and supported GPU/provider; separate vision, embedding and speech checks. |
| Runtime coexistence | Catalog and external models together; model swap, concurrent requests, leases/pins/eviction, Arena/Benchmark exclusivity and recovery; gateway 200 before a run, 503 while Running, 200 after release. |
| Packaged Windows | Fresh target-specific build; `npm run verify:bundle -- --target x86_64-pc-windows-msvc --require-build`, `npm run smoke:node`, `npm run smoke:runtime`; installed copy/link/load/chat/stream/tools/delete/relaunch without PATH Node; signed-installer and updater/rollback qualification per [RELEASE.md](./RELEASE.md). |

**Integration baseline (commit `864e0c5`):** `npm run check`, `npm run build`,
`npm run test:coverage`, IPC-contract and Markdown-link verification pass.
Coverage passes all configured thresholds; the focused SDK/BYOM suites and
native registration E2E pass. Both live-runner self-tests, bundled Node smoke,
and fresh unsigned Windows packaging with bundle verification pass. CI passes
on Windows and macOS. The Llama 3.2 3B CPU run proves real external-model
registration, IPC chat, gateway discovery, and buffered/streaming gateway chat;
all eight source-file hashes remained unchanged. This does not establish full
SDK/BYOM qualification. Package revision/license provenance, broader lifecycle
and provider checks, tool-capable-model behavior, and installed-app qualification
remain open. Flash-Next conversion or architecture enablement is not a release
gate.

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
- Pin `foundry-local-sdk` to `2.1.0`. Warn (do not fail) at sidecar `init` when loaded SDK/core versions differ from that pin.

### Wave 2 — Native lifecycle and conversation integrity

Rubber-duck: a Svelte tray created on first close is not renderer-independent. Native tray must exist from **app start**. Close-to-hide stays a frontend setting. Native Quit currently does not flush conversations — that is the handshake PR, not the tray PR. Stream-by-conversation-id does not touch Rust and is a third PR.

- Native tray Open/Quit installed at startup (`src-tauri/src/tray.rs`). Frontend no longer creates a `TrayIcon`.
- `ExitRequested` prevents exit, emits `flint-quit-flush`, waits for `ack_quit_flush` or 2s, then exits. Renderer death cannot hang quit. Hide/blur/pagehide stays a best-effort extra.
- Stream updates follow the originating conversation id (`applyMessagePatch` when that chat is not visible). Stop applies to the visible conversation only.

### Wave 3 — Cancellation and timeout certainty

SDK 2.1.0 exposes native request and streaming cancellation. Flint's current
transport still suppresses output and drains the native operation; adoption and
confirmation are gated by the SDK shipping plan above. Stop must remain honest
until native completion or cancellation is established.

- Chat streaming: Stop settles the caller; native loop keeps consuming until stream end or child exit; UI already says the background may finish.
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
- One recorded BYOM recipe is still a spike: do not fake a Continue indexer verification.

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
  deprecated `AudioClient` or HTTP.
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
| Does a timeout or Stop acknowledgement mean inference stopped? | No. Separate caller completion from native-operation completion. SDK 2.1.0 cancellation is cooperative and can race completion; retain resource protection until the terminal native outcome is established or the owning process is gone. |
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
| Is BYOM `/v1/embeddings` a 1.0 blocker? | No. Catalog has zero embedding models. 1.0.0 recipes are chat completions. The embeddings **path** exists (Wave 9). Full RAG stays after 1.0. |
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
