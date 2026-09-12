# Building on Flint

Flint is a desktop control plane for Microsoft Foundry Local. The core product
owns model discovery and lifecycle, local inference, an OpenAI-compatible
endpoint, diagnostics, and the desktop runtime. Extensions should add user
value on top of those seams instead of reimplementing Foundry Local.

This guide is the handoff contract for contributors building features such as
document workflows, evaluation tools, integrations, or new views.

## Architecture boundaries

Flint 0.7.0 uses the native Rust runtime supervisor to own the sidecar process
and bridge stdio JSON lines to the frontend SDK transport.

```text
Svelte frontend
    |
    | typed methods in src/lib/sdk.ts
    v
Rust supervisor & stdio transport bridge
    |
    | JSON lines over stdio
    v
sidecar/foundry-sidecar.js
    |
    | the only Foundry manager, catalog, pool, gateway, and inference owner
    v
Foundry Local SDK
```

The browser bundle must not import `foundry-local-sdk` or Node built-ins.
Frontend behavior belongs behind `src/lib/sdk.ts`. The sidecar remains the
authority for native runtime state and model operations. The native Rust
supervisor is the single process-launch and child-lifecycle owner; Rust does
not create a competing Foundry manager or model pool.

## Choosing an extension seam

| Need | Start here |
|---|---|
| Pure parsing, validation, sorting, or policy | Add a pure module under `src/lib/` or `sidecar/` with focused tests. |
| A new native/runtime operation | Add a typed SDK method and sidecar command together. |
| A new model or catalog view | Reuse `listModels`, alias/variant identity, capability metadata, and readiness state. |
| An OpenAI-compatible client workflow | Use the gateway endpoint and Integrations helpers; do not bypass autoload or rewrite model identity. |
| Conversation-related behavior | Use the APIs in `src/lib/conversation-repository.ts` and per-conversation settings; do not write storage before hydration. |
| A new desktop shell action | Keep shell ownership in Tauri/Rust and expose a narrow typed frontend method. |
| A document or retrieval feature | Validate an embedding-model path first; keep sources, retrieved chunks, and failures visible. |

## Working safely in parallel

Use one work lane per pull request. The lanes are frontend/persistence,
SDK/IPC contracts, sidecar/runtime, Rust/Tauri shell, packaging/release, and
documentation. A change may touch another lane when it updates that lane's
contract, but the pull request must name the owner and the handoff explicitly.

These files are shared hotspots and need extra coordination:

- `src/routes/+page.svelte`
- `src/lib/sdk.ts`
- `src/lib/ipc-contracts.ts`
- `sidecar/foundry-sidecar.js`
- `package-lock.json`

Keep parallel work safe by:

1. Keeping one behavioral concern per pull request.
2. Reusing pure modules and typed seams instead of adding logic to a hotspot.
3. Rebasing before handing off a hotspot change or resolving a conflict.
4. Re-running the contract checks after resolving conflicts; never choose one
   side of a command or schema conflict without checking the complete surface.
5. Recording assumptions, known follow-ups, and ownership in the pull request.

For changes to the SDK/IPC or runtime, run:

```bash
npm run verify:ipc-contracts
```

The check compares the typed command list with the sidecar allowlist, command
schemas, operation-effect classifications, and IPC deadline declarations.
It is a drift check, not a replacement for focused behavior tests.

## Adding a sidecar command

1. Define the command name and typed request/response in `src/lib/sdk.ts` and
   the IPC contract.
2. Add the command in all required sidecar validation locations:
   `KNOWN_COMMANDS`, `FIELD_TYPES`, and `COMMAND_SCHEMA`, plus any checks in
   `validateCommand`.
3. Add the operation effect classification in
   `src/lib/operation-outcome.ts`.
4. Implement the sidecar handler using the existing runtime authority.
5. Add focused pure/sidecar tests and update contract tests.
6. Add a deadline only when the operation is a finite read-only query.
   Inference and effectful operations remain unbounded because transport expiry
   does not cancel native work.
7. Update user-facing documentation and add a changeset for code changes.

Never replay a command merely because `write()` rejected. Only an explicit
`not-dispatched` result proves that an operation did not happen. Every async
handler must re-check ownership immediately before dispatch and after
confirmation awaits.

### Worked example: `getCacheInventory`

`getCacheInventory` is a shipped, read-only query that walks the checklist
above end to end. Reading it in one pass is faster than following the
checklist in the abstract:

1. **Typed contract** — `src/lib/ipc-contracts.ts` lists `getCacheInventory` in
   `KNOWN_COMMANDS`/`SidecarCommand` with no request fields (it takes no
   arguments).
2. **Sidecar validation** — `sidecar/foundry-sidecar.js` declares it in
   `KNOWN_COMMANDS`, `COMMAND_SCHEMA` (`{ required: [], optional: [] }`), and
   dispatches it in the command switch to the `getCacheInventory()` handler.
3. **Effect classification** — `src/lib/operation-outcome.ts` marks it
   `'query'` in `COMMAND_EFFECTS`: it only reads the filesystem and never
   mutates runtime state, so it is safe to treat as idempotent and
   interruption-tolerant.
4. **Handler** — the sidecar's `getCacheInventory()` resolves the configured
   cache root, tolerates a missing root or scan errors without throwing, and
   delegates classification to the pure module `sidecar/cache-inventory.js`
   (`summarizeCacheInventory`), keeping filesystem I/O and pure
   duplicate/partial-entry classification separate and independently
   testable.
5. **Deadline** — `src/lib/ipc-deadlines.ts` gives it a finite `30_000` ms
   transport deadline, appropriate because it is a bounded read-only query,
   not an inference or effectful operation.
6. **SDK wrapper** — `src/lib/sdk.ts`'s `getCacheInventory()` sends the
   command and throws if the sidecar returned no result, so the frontend never
   silently treats a malformed reply as an empty inventory.
7. **UI usage** — `src/routes/+page.svelte`'s `scanCacheInventory()` calls the
   SDK method, sets a loading flag, and reports failure through
   `statusMessage`/`appendAppLog` rather than leaving stale or ambiguous state
   on screen; the incomplete-scan case (`cacheInventory.scanComplete === false`)
   is rendered explicitly instead of being presented as a clean success.
8. **Tests** — `sidecar/cache-inventory.test.ts` covers the pure
   classification logic directly; `scripts/verify-ipc-contracts.cjs` covers
   the cross-file contract drift for the command.

A new read-only query command can follow this same shape: pure classification
module + thin sidecar handler + typed SDK wrapper + UI state that distinguishes
loading, error, and incomplete-but-successful results.

## Model and endpoint rules

- Friendly aliases are for catalog lookup; loading requires the alias and the
  selected variant when one is known.
- The gateway routes variant IDs and owns the one-time autoload/replay path.
- Autoload resolves cached models only. A user identifier must never trigger an
  accidental download.
- Keep alias, resolved variant, and execution-provider identity visible when
  the runtime can establish them.
- Preserve streamed responses and `[DONE]`; only bounded control/error captures
  may be buffered.
- Do not report a model as ready when loading failed, or a request as cancelled
  when native completion is unknown.

## Conversation and storage rules

Hydrate before writing. Conversations live in the versioned v2 archive. The
legacy settings payload retains the pre-v2 launch snapshot for rollback and
migration; it must not be extended with live messages. Storage failures are
surfaced rather than silently retried or replaced with an unhydrated blob.

New features should use stable conversation, message, and operation IDs so a
late completion cannot write into whichever conversation happens to be visible.

## Testing and packaging

At minimum, an extension should include:

- pure module tests for its policy and data transformations;
- sidecar contract tests for new commands;
- `npm run check`, focused tests, and `git diff --check`;
- `npm run verify:bundle` when resources or runtime files change;
- installed Windows/macOS smoke coverage when startup, packaging, or shell
  behavior changes.

For local builds:

```bash
npm install
npm run tauri dev
npm run tauri:build:local
npm run verify:bundle
```

Use `npm run tauri:build` only for signed release artifacts. See
[DEVELOPMENT.md](./DEVELOPMENT.md) and [RELEASE.md](./RELEASE.md) for the
complete build and publication procedures.

## Before handing off a feature

Describe the user problem, the Flint seam used, the new command or data shape,
failure and cancellation semantics, tests, and any new resource or permission.
Keep the change behind existing runtime ownership and document whether it is
part of the 0.7.0 foundation or remains a later backlog feature.
