# Foundry Local SDK 2.x migration scope

This document records the migration boundary for the current minimum
`foundry-local-sdk` version, pinned to `2.1.0` in `package.json` and
`PRODUCT_PLAN.md`. The registration measurement is
[spikes/foundry-2.1.0-spike.md](./spikes/foundry-2.1.0-spike.md). The SDK marks the OpenAI-shaped `ChatClient`, `AudioClient`, and
`EmbeddingClient` wrappers deprecated and plans to remove them at the end of
2026. The replacement API is based on `ChatSession`, `AudioSession`,
`EmbeddingsSession`, `Request`, and `Item`.

The 2.1.0 pin is an integration target, not release qualification. Current
implementation gaps, model feasibility, sequencing, and release gates belong
to [the SDK/BYOM shipping plan](./PRODUCT_PLAN.md#sdk-210-and-real-byom-shipping-plan).

## Current state

Flint already has compatibility adapters for the text paths:

| Flint operation | Preferred path | Current fallback |
|---|---|---|
| `chatCompletion` | `ChatSession` with an `openai-json` request item | `Model.createChatClient()` |
| `embedTexts` | `EmbeddingsSession` with an `openai-json` request item | `Model.createEmbeddingClient()` |
| `transcribeAudio` | Whisper: `AudioSession` + `Item.audioFromUri()`; Nemotron: `AudioSession` + raw-PCM `ItemQueue` | None; unsupported families fail explicitly |

The adapters preserve Flint's existing OpenAI-shaped request and response
contracts. They create a fresh session for each operation, so the migration does
not implicitly change Flint's conversation-history ownership or streaming
cancellation behavior.

Completed assistant tool calls are structurally validated on every chat
transport before Flint reports success or emits a synthetic buffered delta.
Streaming accepts incremental `delta.tool_calls` and cumulative
`message.tool_calls` snapshots, reconciles compatible representations, and
rejects conflicts. Each call is limited to 256 ID characters, 128 function-name
characters, and 64 KiB of UTF-8 function arguments; a response may contain at
most 64 distinct calls.

The current audio code classifies the requested model before loading whenever
its alias, explicit variant, resident variant, or unanimous cached candidates
identify the family. Whisper-family models use the proven one-shot URI request.
Nemotron uses 16 kHz mono 16-bit PCM through `ItemQueue`. These request shapes
were established on 2.0.1 and still need real-model qualification on 2.1.0.
Parakeet is refused before loading when determinable, retaining the unsupported
family decision from 2.0.1 rather than claiming a fresh 2.1.0 probe.
Mixed or unreadable cached candidates defer to the exact runtime-selected
variant; no speech request retries through deprecated `AudioClient` or HTTP.

Flint's `sidecar/prompt-template.js` is not the SDK's deprecated
`PromptTemplate` type. It is a Node-free Flint module that validates and authors
the `PromptTemplate` JSON stored in BYOM `inference_model.json` files and shared
with the browser bundle. It must remain until Flint's BYOM format no longer
requires that metadata. ChatSession applies the model's template internally at
inference time.

## SDK 2.1.0 local-catalog boundary

`manager.getCatalog(CatalogType.Local)` exposes
`registerModel(modelPath, modelId, metadata)` and `unregisterModel(aliasOrId)`.
The public `manager.catalog` is not the mutation target. `MutableModelInfo`
exposes string/integer setters for task, execution provider, device type,
context length, modalities, tool/reasoning capabilities, and other metadata.
Registration is metadata, not a model converter or proof that a session works.

Copied and linked folders are registered after awaited accelerator setup,
through the serialized local-catalog mutation lane without forcing a public
catalog snapshot read. SDK local rows use `providerType: LocalRegistration`;
sidecar list projections retain `local://<alias>` for existing frontend
presentation. A catalog read failure no longer turns into an empty list or
authorizes unregistering an unknown row. A task-less collision is replaced
only when its registered path matches the requested path. Deletion captures
the registered path before unregistering; external linked assets remain
untouched.

The native listener still omits local registrations from `/v1/models` and
returns 404 for them. Flint's gateway now appends cached local registrations to
discovery and sends local chat completions through `ChatSession`, while keeping
the existing model admission, residency, and activity leases. Focused gateway
tests cover the adapter boundary. The external Llama 3.2 3B spike also proves
real-weight CPU IPC and buffered/streaming gateway chat, as recorded in the
linked spike evidence. Tool/usage parity, other providers, and installed-app
behavior remain release gates until the complete qualification matrix passes.

## SDK 2.1.0 session features

The installed package declares `Request.cancel()` for active one-shot
inference and `processStreamingRequest(request, { signal })` for queued/active
stream cancellation. The stream's terminal `response` settles after native
completion and queued callbacks. Cancellation can lose a race to completion;
calling `cancel()` on an idle/queued one-shot request has no effect.
`IModel.download(..., signal)` observes cooperative cancellation at download
checkpoints. Flint has not yet wired these contracts end to end and must retain
its current drain/uncertainty semantics until it does.

`ChatSession` also exposes exact structural `preflightRequest`, function-tool
definitions, custom raw-text tool definitions, and explicit tool removal.
Those declarations do not make raw tools part of Flint's existing
function-only IPC contracts or authorize a tool executor. Adoption and explicit
unsupported outcomes are owned by the shipping plan.

The imported adapters omit every frequency penalty, while presence penalty
retains neutral-value normalization. This avoids the previously observed
converter failure but does not preserve non-neutral frequency-penalty
semantics. Resolve the UI/API contract and verify sampling/usage/finish reasons
against real 2.1.0 sessions before shipping.

## Migration boundary

The migration keeps deprecated text-client constructors as optional
compatibility fallbacks rather than primary paths. It does not remove:

- Flint's OpenAI-shaped IPC and gateway contracts;
- `openai-json` request serialization used by the session adapters;
- Flint-owned BYOM template validation and editing;
- model-family capability checks and runtime fallback handling.

The sidecar remains the only place that imports the Foundry SDK. The frontend
continues to use `src/lib/sdk.ts` and IPC contracts.

Implementation sequencing and release acceptance gates for this migration are
owned by `docs/PRODUCT_PLAN.md`. This document remains the technical boundary:
the session adapters, text compatibility fallbacks, model-family checks, request
shapes, and error/cancellation contracts described above are the current behavior.
