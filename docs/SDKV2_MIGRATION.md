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
| `transcribeAudio` | `AudioSession` with `Item.audioFromUri()` | `Model.createAudioClient()` and existing HTTP fallback |

The adapters preserve Flint's existing OpenAI-shaped request and response
contracts. They create a fresh session for each operation, so the migration does
not implicitly change Flint's conversation-history ownership or streaming
cancellation behavior.

The current audio code classifies the loaded model before attempting the
`AudioSession` URI shape. Whisper-family models use the proven one-shot URI
request; known Nemotron and Parakeet families skip that unsupported shape and
use the existing legacy fallback. Unknown speech families still probe the
session path and fall back if the runtime rejects it. Nemotron requires a
different raw-PCM `ItemQueue` shape, and Parakeet has no working `AudioSession`
request shape in the pinned SDK.

Flint's `sidecar/prompt-template.js` is not the SDK's deprecated
`PromptTemplate` type. It is a Node-free Flint module that validates and authors
the `PromptTemplate` JSON stored in BYOM `inference_model.json` files and shared
with the browser bundle. It must remain until Flint's BYOM format no longer
requires that metadata. ChatSession applies the model's template internally at
inference time.

## Migration boundary

The migration removes Flint's dependency on deprecated client constructors. It
does not remove:

- Flint's OpenAI-shaped IPC and gateway contracts;
- `openai-json` request serialization used by the session adapters;
- Flint-owned BYOM template validation and editing;
- the legacy audio path before every supported STT family has a proven session
  request shape;
- model-family capability checks and runtime fallback handling.

The sidecar remains the only place that imports the Foundry SDK. The frontend
continues to use `src/lib/sdk.ts` and IPC contracts.

Implementation sequencing and release acceptance gates for this migration are
owned by `docs/PRODUCT_PLAN.md`. This document remains the technical boundary:
the session adapters, legacy fallbacks, model-family checks, request shapes, and
error/cancellation contracts described above are the current behavior.
