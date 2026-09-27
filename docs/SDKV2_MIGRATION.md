# Foundry Local SDK 2.x migration scope

This document records the migration boundary for the current minimum
`foundry-local-sdk` version, pinned to `2.0.1` in `package.json` and
`PRODUCT_PLAN.md`. The SDK marks the OpenAI-shaped `ChatClient`, `AudioClient`, and
`EmbeddingClient` wrappers deprecated and plans to remove them at the end of
2026. The replacement API is based on `ChatSession`, `AudioSession`,
`EmbeddingsSession`, `Request`, and `Item`.

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
Nemotron uses 16 kHz mono 16-bit PCM through `ItemQueue`. Parakeet has no working
request shape in the pinned SDK and is refused before loading when determinable.
Mixed or unreadable cached candidates defer to the exact runtime-selected
variant; no speech request retries through deprecated `AudioClient` or HTTP.

Flint's `sidecar/prompt-template.js` is not the SDK's deprecated
`PromptTemplate` type. It is a Node-free Flint module that validates and authors
the `PromptTemplate` JSON stored in BYOM `inference_model.json` files and shared
with the browser bundle. It must remain until Flint's BYOM format no longer
requires that metadata. ChatSession applies the model's template internally at
inference time.

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
