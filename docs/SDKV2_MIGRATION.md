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

## Sequencing

1. **Chat completion**
   - Keep the existing `ChatSession` adapter as the primary path. It preserves
     the deprecated client's OpenAI-shaped request/response bridge, while Flint
     deliberately wraps setup, native, and response-parsing failures under the
     same model-specific error family.
   - Move generation settings into the session/request adapter as the SDK
     exposes stable request options, while preserving omitted-setting behavior.
   - Exercise buffered, streaming, tool payload pass-through, usage extraction,
     malformed output, constructor failure, and disposal failure.
   - Remove the `createChatClient()` fallback only after a runtime probe confirms
     the minimum supported SDK no longer exports it and all supported Flint
     transports use the session path.

2. **Embeddings**
   - Keep the existing stateless `EmbeddingsSession` adapter. It preserves
     the deprecated client's OpenAI-shaped request/response bridge, while Flint
     deliberately wraps setup, native, and response-parsing failures under the
     same model-specific error family.
   - Prefer native tensor output when the SDK contract is stable; retain the
     OpenAI-shaped result conversion at the sidecar boundary.
   - Validate empty input, multiple inputs, output dimensions, malformed output,
     constructor failure, and disposal.
   - Remove `createEmbeddingClient()` only after the supported SDK floor no
     longer exports it.

3. **Audio**
   - Add model-family capability classification before attempting
     `AudioSession`; do not use constructor availability as proof that a request
     shape is supported.
   - Keep the classifier conservative: skip only known unsupported families,
     probe unknown families, and retain the legacy fallback for every failure.
   - Implement and test the Whisper URI path independently.
   - Track Nemotron raw-PCM `ItemQueue` support as a separate adapter because it
     changes input preparation and completion signaling.
   - Keep the legacy client and HTTP fallbacks for Parakeet and any family whose
     session path is not proven.
   - Remove the legacy audio path only after each supported family has a
     passing session integration test and a truthful capability decision.

4. **Prompt metadata**
   - Keep Flint's BYOM template authoring and validation independent of SDK
     `PromptTemplate` types.
   - Treat model metadata as input to catalog/import behavior, not as a runtime
     construction dependency.
   - Revisit the stored `PromptTemplate` field only if a future Foundry scanner
     format replaces it; that is a BYOM format migration, not a ChatSession
     migration.

## Completion criteria

The migration is complete when:

- chat and embeddings execute without calling their deprecated model client
  constructors;
- audio chooses a proven session request shape per model family and retains an
  explicit fallback where no session shape exists;
- all three operations preserve Flint's existing IPC, gateway, logging,
  activity-fence, error, and cancellation semantics;
- the migration test matrix covers SDK builds with session exports, legacy
  exports only, and neither path where applicable;
- the supported SDK floor is documented and the legacy fallback removal is
  separately reviewable rather than coupled to the first session adapter.

This scope deliberately treats the end-of-2026 removal as a near-term
compatibility deadline, while avoiding a risky all-at-once rewrite of the audio
path.
