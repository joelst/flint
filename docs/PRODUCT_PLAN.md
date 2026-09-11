# Flint reliability execution plan

**Status:** In progress. Phase 0 and Phase 1A are delivered and Phase 1B is
underway; see [Delivery status](#delivery-status). Everything else in this
document remains planned and implies no implementation.

**Scope:** Address the project review's data-integrity, lifecycle, inference, model,
audio, packaging, and observability findings. Supported-platform work targets
Windows and macOS Apple Silicon.

**Release ownership:** [CHANGELOG.md](../CHANGELOG.md) owns version assignments and
release history. [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) owns the forward plan
through 1.0. This document owns implementation sequencing and acceptance gates.
[BACKLOG.md](./BACKLOG.md) holds deferred work.

## 0.7.0 foundation release

**Objective:** produce a shareable Windows/macOS build by Monday that gives the
Foundry Local Explorer team a dependable Flint core to build on. This is a
release-candidate track, not a rewrite of the full plan and not a reason to
delete or reorder deferred backlog items.

**Release scope, in order:**

1. Complete the minimum thin Rust supervisor needed to own one sidecar child,
   observe exit, preserve truthful operation outcomes, and keep tray/Open/Quit
   and macOS Reopen recoverable. Keep Foundry manager, catalog, pool, gateway,
   cache, and inference ownership in the Node sidecar.
2. Add Rust and installed-path smoke coverage for duplicate launch, sidecar
   startup failure, sidecar crash, graceful quit, failed quit, and reopen.
3. Build and verify the Windows installer and macOS Apple Silicon artifact,
   using unsigned local builds only for development smoke tests. Run the
   supported core flow from the packaged artifacts: first launch, model
   download/load, chat streaming, transcription, service start, endpoint
   client connection, restart, and quit.
4. Share a clearly labelled `0.7.0` evaluation prerelease outside the updater
   channel, with supported platforms, known limitations, explicit
   0.6.0/0.7.0 upgrade and rollback expectations, and a short feedback route
   for the Explorer team. Do not make it the `releases/latest` target while it
   is a prerelease.
5. Verify and hand off the stable extension seams already documented in
   [EXTENDING.md](./EXTENDING.md): frontend SDK boundary, sidecar JSON-lines
   contract, command addition checklist, model/catalog lifecycle, gateway
   behavior, storage rules, packaging commands, and the rule that new features
   must not create a second Foundry manager or runtime owner.

**Explicitly deferred from the 0.7.0 critical path:** broad audio-format
conversion and timestamp work while the Foundry SDK audio surface is changing;
RAG/embeddings until an embedding-model path is validated; Linux qualification;
and wholesale Rust runtime replacement. These remain open in [BACKLOG.md](./BACKLOG.md).

**Fast schedule for the Monday handoff:**

| Window | Outcome |
|---|---|
| Day 1 | Freeze the 0.7.0 scope, land the smallest Rust ownership slice, and add failure-mode tests before polishing. |
| Day 2 | Exercise packaged Windows and macOS Apple Silicon builds; fix only blockers in startup, model load, chat, transcription, endpoint, restart, and quit. |
| Day 3 | Finalize release notes and the extension handoff guide, repeat clean-environment smoke checks, and share the labelled prerelease artifacts with known limitations. |

If a Rust supervisor feature cannot meet the packaged-flow gate in this window,
ship the existing sidecar lifecycle only if the build is explicitly marked an
evaluation prerelease and the missing native ownership is called out. Do not
silently claim 0.7.0 has completed Workstream C.

### 0.7.0 rubber-duck decisions

| Challenge | Decision |
|---|---|
| Can the current Node sidecar be called a solid core without Rust supervision? | Not for a shared prerelease. The sidecar lifecycle is already carefully guarded, but the desktop process still needs native ownership of the child and exit/reopen behavior. |
| Should 0.7.0 move Foundry SDK calls into Rust? | No. That would create a second runtime implementation and expand the risk surface. Rust supervises; the sidecar remains the sole Foundry authority. |
| Can we finish every backlog item before Monday? | No, and doing so would reduce confidence. The release gate is a reproducible supported flow, not backlog exhaustion. Existing items stay open and retain their owners. |
| Should audio expansion outrank the supervisor because Explorer has a nicer audio path? | No. Keep the WAV boundary and truthful errors; defer decoder and timestamp work until upstream behavior stabilizes. |
| Does a successful build prove the app is shareable? | No. The installer, bundled Node, Foundry resources, first-run model flow, service endpoint, restart, and quit must be exercised from the packaged artifact. |
| Should the README describe Flint as a general-purpose AI app? | No. Lead with its value as a Foundry Local control plane: model lifecycle, local endpoint, evaluation, and an extensible core for tools and experiments. |

## Delivery status

A stage is recorded here only once the pull request delivering it is merged to
`main`. Work that was consciously deferred rather than completed is listed in
[BACKLOG.md](./BACKLOG.md) and is not counted against a stage.

| Phase | Stage | Delivered by |
|---|---|---|
| 0 | Containment: hydration/write guards, async ownership epochs, single-instance and macOS Reopen, microphone metadata, local unsigned-build profile, single-flight service startup, gateway activity leases and pool admission safety | #35 |
| 1A | 1A-1 versioned conversation schema, legacy migration, supported rollback floor | #38 |
| 1A | 1A-2 `ConversationRepository` storage layer with byte preservation | #43 |
| 1A | 1A-3a conversation contracts and title derivation from plain text | #43 |
| 1A | 1A-3b multipart-preserving request builder and chat transport | #42 |
| 1A | 1A-3c conversation session wiring: switching, creation, deletion, and flush | #45 |
| 1A | 1A-3d per-conversation settings resolved against an application baseline | #49 |
| 1A | 1A-4 conversation export and at-risk storage reporting | #52 |
| 1B | 1B-1 typed operation outcomes: settlement revokes dispatch, convenience-start authorization, honest interruption reporting | #53 |
| 1B | 1B-2 versioned sidecar handshake, process generations, and independent runtime readiness states | #55, #56, #57, #58 |
| 1B | 1B-3 catalog refresh failures propagate and mark model readiness unknown | #59 |
| 1B | 1B-4 non-destructive service ensure under the lifecycle transition lock | #60 |
| 1B | 1B-5 failed or uncertain service transitions invalidate stale endpoint state | #61 |
| 1B | 1B-6 Stop fences older queued starts, including transition-handle starts | #63 |
| 1B | 1B-7 public endpoints reflect the configured reachable bind and effective port | #65 |
| 1B | 1B-8 failed service restarts withdraw the endpoint and clean up partial listeners | #67 |
| 1B | 1B-9 hydrated runtime policy and accelerator readiness precede service startup and model preloads | #69 |
| 1B | 1B-10 partial accelerator registration preserves compatible startup preloads | #72 |
| 1B | 1B-11a webpage fetches have a total deadline and bounded response body | #74 |
| 1B | 1B-11b native service readiness probes are bounded by the startup deadline | #76 |
| 1B | 1B-11c gateway control and autoload-error response captures are byte-bounded | #78 |
| 1B | 1B-11d finite read-only IPC queries have operation-specific transport deadlines | #80 |
| 1B | 1B-11e downloads and accelerator setup surface non-cancelling progress-stall notices | #82 |
| 1B | 1B-11f native error diagnostics and gateway request captures complete bounded operation handling | #83 |
| 1B | 1B-12 explicit Stop HTTP, Stop-and-Unload, and confirmed Quit Runtime semantics | #84 |

Phase 1A closed its acceptance gate for storage, migration, rollback, multipart
preservation, conversation switching, and export. Phase 1B is in progress:
1B-1 through 1B-12 delivered typed outcomes, versioned transport/readiness
contracts, truthful catalog failures, non-destructive service ensure, and stale
endpoint invalidation, Stop fencing, reachable public endpoint reporting, and
failed-restart cleanup, plus startup sequencing from hydrated runtime intent and
partial accelerator readiness. Webpage fetches now bound total duration and
response bytes before parsing, and each native readiness probe is bounded by the
remaining startup deadline. Gateway responses buffered for `/status` rewriting or
first-pass autoload-error inspection now have a byte cap without limiting streamed
inference. Finite read-only IPC queries now stop waiting after operation-specific
deadlines without applying those deadlines to inference or effectful work. Long-running
downloads and accelerator setup report prolonged progress silence without cancellation,
native HTTP error diagnostics are bounded by time and bytes, and gateway request capture
limits reject invalid configuration. Service shutdown now distinguishes endpoint
withdrawal from bounded drain-and-unload and full runtime termination, with new
work fenced during draining and process exit confirmed before a clean quit is
reported. The remaining Workstream B gate covers failure propagation and
observability.
Work split out of a delivered stage rather than completed is listed in
[BACKLOG.md](./BACKLOG.md) under *Conversation persistence* and *Operation
outcomes*, and is not counted against the stage that produced it.

## Decisions

1. **Expedite a thin Rust lifecycle and process-supervision layer.** Native code
   should own single-instance behavior, tray Open/Quit, macOS Reopen, and exactly
   one runtime child. A failed renderer must not remove the recovery controls.
2. **Do not expedite a wholesale Foundry-to-Rust rewrite.** Keep the existing
   sidecar as the sole owner of the native Foundry manager, catalog, pool, and
   execution providers while correcting its behavior. Preserve native crash
   isolation from the desktop process.
3. **Do not wait for Rust to fix data loss or runtime correctness.** Hydration,
   request ownership, service transitions, streaming leases, pins, and honest
   failure reporting are independently shippable fixes on the existing transport.
4. **Linux-only work is deferred.** Preserve existing Ubuntu checks and platform
   mappings. Continue Linux-specific work only if it is already part of another
   feature; do not use this plan to open a new Linux workstream. Shared fixes
   required for Windows/macOS may incidentally improve portability, without
   implying that Linux is qualified or supported.
5. **Separate corrections from new features.** Make existing controls effective
   and truthful first. Richer options follow the correctness gates they depend on.
6. **Use small, reversible changes.** Do not combine a data-format migration,
   transport cutover, SDK upgrade, and model-policy change in one release.

## Rubber-duck decisions

| Challenge | Decision |
|---|---|
| Would rewriting the backend fix conversation loss? | No. Correct hydration, storage identity, and asynchronous ownership in the frontend first. |
| Should the emergency fix introduce a new database? | No. Stop destructive writes immediately; give the subsequent storage migration its own compatibility gate. |
| Does keeping old storage make every downgrade safe? | No. Define a supported rollback version that understands the new format, including conversations created after migration. |
| Does a timeout or Stop acknowledgement mean inference stopped? | No. Separate caller completion from native-operation completion. Retain resource protection until completion is established or the owning process is gone. |
| Can a missing heartbeat prove the sidecar crashed? | Not while synchronous native work can block its event loop. Distinguish unresponsive from exited; avoid restart loops and duplicate work. |
| Would moving inference into Tauri prevent all windows disappearing? | It can do the opposite: a native fault would enter the desktop process. Keep inference in a supervised process even if its implementation later becomes Rust. |
| Can a worker thread initialize another Foundry manager? | Not safely as a workaround for the process-global native core. Keep one manager owner; do not duplicate ownership across Node workers. |
| Can the old and new transports both run during migration? | Not as concurrent runtime owners. Select one transport at startup and switch only after the previous child is confirmed stopped. |
| What happens when every model is busy, pinned, or of unknown residency? | Queue within a declared bound or refuse admission clearly. Never bypass protection or assume memory was released. |
| Is fixing hidden-tab polling sufficient for background protection? | No. Sampling/evaluation must survive a failed renderer; native notification delivery must not depend on the hidden webview. |
| Do signing credentials block correctness fixes? | They block the relevant signed distribution, not implementation or approved local testing. Do not weaken release signing or bypass managed-device policy. |
| Can shared packaging work become a Linux release project? | No. Fix host-versus-target selection for existing targets; defer Linux formats, matrices, distro qualification, and release claims. |

## Execution order

Phases are dependency gates, not one monolithic release. Add regression coverage
with each fix rather than postponing it to a final testing phase.

| Phase | Work | Dependencies and exit condition |
|---|---|---|
| **0: Contain existing failures** *(delivered)* | Hydration/write guards, stale-result guards, truthful errors, immediate Mac metadata and Dock-reopen fixes, local-build profile, idempotent service ensure, startup deduplication, and urgent eviction protections | No runtime rewrite or storage-migration prerequisite. Each corrected failure has a focused regression case; affected packaged paths also have artifact-level evidence. |
| **1A: Durable conversation state** *(delivered)* | Versioned conversation repository, legacy recovery, multipart storage, supported rollback, export/backup foundation | Hydration protection is already in place. Migration can be interrupted/retried without overwriting either legacy or new data. |
| **1B: Runtime correctness** *(in progress)* | Runtime/service contracts, admission and leases, inference adapter, cache ownership, audio sessions, and renderer-independent monitoring | Starts on the existing transport. Domain fixes may ship independently; shared contracts must be stable before native transport cutover. |
| **2: Native ownership cutover** | Thin Rust supervisor, native tray/reopen/quit, single-instance behavior, process-generation transport | May overlap Phase 1 once contracts are fixed. Exactly one child and one manager owner; rollback happens at a clean startup boundary. |
| **Every affected release** | Complete resource packaging, installed-app scenarios, updater/install integrity, SDK/core matrix, current documentation | Runs continuously, not just at the end. Windows/macOS only; release signing remains mandatory for signed channels. |
| **3: Useful options** | Operation queue, conversation controls, device selection, endpoint profiles, diagnostics, updater UI, and richer metrics | Each option depends on working underlying behavior. No automatic cloud fallback or silent model/provider substitution. |
| **Later decision** | Replace selected runtime implementation with Rust if justified | Requires supported bindings, Windows/macOS parity, measured benefit, and preserved process isolation. Not a committed rewrite. |

## Workstream A: Data and asynchronous ownership

**Primary surfaces:** `src/routes/+page.svelte`, conversation/sidebar helpers,
message rendering, and the SDK request adapter.

**Delivered in Phase 1A (#38, #42, #43, #45, #49, #52).** The acceptance gate below
is met. Remaining gaps are recorded in [BACKLOG.md](./BACKLOG.md) under *Conversation
persistence*, not here.

### Required changes

- Separate `hydrating`, `ready`, and `storage-error` states. Disable persistence
  until hydration completes; make corrupt/unavailable storage a visible,
  non-destructive condition. Register lifecycle cleanup independently of storage.
- Introduce a typed `ConversationRepository`: conversation IDs, message IDs,
  active conversation ID, conversation-specific settings, and typed text/image
  parts. Save/load the actual history when switching, not just sidebar metadata.
- Use a versioned store for the new format. Delivered on `localStorage` under the
  key `flint-conversations-v2`, not the IndexedDB backend originally proposed: a
  single key is replaced atomically, which gives the whole archive one commit point
  and avoids a partially applied multi-record transaction. The cost is the ~5 MB
  budget, which is why the thread is not duplicated into the settings blob and why
  storage errors are surfaced rather than retried silently.
- Retain the original legacy payload until a validated migration commits.
  Migration must be idempotent. Where the global legacy history has no provable
  sidebar owner, import it as a clearly labeled recovered conversation; do not
  invent an association with the first sidebar entry.
- Do not claim to recover messages that were never persisted or already
  overwritten. Preserve available bytes and offer export before destructive
  reset decisions.
- Define a minimum rollback-compatible application version before shipping the
  new schema. Preserve conversations created after migration as well as legacy
  history. Avoid indefinite dual-writing to incompatible formats.
- Associate send, stop, compaction, and attachment retrieval with stable
  operation/conversation/message IDs. A conversation switch must not redirect
  completion into the currently displayed conversation.
- Allow generation to finish in its originating conversation unless explicitly
  cancelled. Apply compaction only to the captured message set, preserving newer
  turns, or discard it when the required revision is no longer applicable.
- Make all completion cleanup ownership-aware, including streaming flags and
  active request IDs, not only the abort controller.
- Validate URL input before creating render state. Update URL chips by stable
  identity; removed or superseded chips cannot be resurrected.
- Preserve multipart content during instruction insertion and same-role
  normalization. Derive titles from plain text and render image/text parts
  deliberately rather than stringifying arrays.

### Acceptance gate

Existing data survives delayed/failed SDK initialization, storage failure,
conversation switching, image-first conversations, interrupted migration, and
supported downgrade/re-upgrade. Late summary/stream/fetch completion cannot
delete new turns, modify another conversation, or clear a newer request's controls.

## Workstream B: Runtime and service coordination

**Primary surfaces:** `src/lib/sdk.ts`, `src/lib/ipc-contracts.ts`,
`sidecar/foundry-sidecar.js`, and gateway lifecycle.

**Delivered through 1B-12 (#53, #55-#61, #63, #65, #67, #69, #72, #74, #76, #78, #80, #82-#84):** typed operation outcomes classified by
command effect (`src/lib/operation-outcome.ts`); settlement revokes a request's
permission to dispatch; versioned handshakes and process generations; independent
runtime readiness states; convenience service starts authorized inside the transition
lock; non-destructive service ensure; stale endpoint invalidation; catalog and
model-load failure propagation; Stop fencing; reachable endpoint publication;
partial-start cleanup; honest requested-EP application; startup sequenced from
hydrated runtime intent; structured partial accelerator readiness with compatible
startup preloads; bounded webpage fetch duration and response bytes; bounded native
readiness probes; bounded gateway control and autoload-error captures; bounded finite
read-only IPC queries; non-cancelling progress-stall notices; bounded native HTTP error
diagnostics; validated gateway request-capture limits; explicit HTTP stop,
drain-and-unload, and runtime-quit contracts; and honest interruption reporting.
The remaining items below are outstanding.

### Required changes

- Define a versioned JSON-lines handshake, process generation, operation IDs,
  typed outcomes, and separate process/runtime/service/model states. A spawned
  child is not equivalent to a ready manager or a running HTTP service.
- Have one shared startup-and-initialization promise. Ignore late events from
  obsolete children. On exit, invalidate actual endpoint/residency/readiness
  while retaining durable desired configuration.
- Distinguish operations that failed, were cancelled, completed, or have an
  unknown outcome after connection loss. Never automatically replay generation
  or mutation merely because its acknowledgement was lost.
- Separate `ensureServiceRunning` from explicit restart. Serialize transitions
  across startup, Audio, Diagnostics, and Settings. Stop fences older queued
  starts so late work cannot revive the endpoint. Delivered.
- Make partial starts and failed Apply explicit. Either restore the last working
  configuration through a deliberate rollback or remain stopped with the error;
  do not advertise an old endpoint as running. Failed replacement starts now
  withdraw the endpoint unconditionally and await best-effort gateway/native
  teardown before reporting the original error. Confirming termination when
  teardown itself fails remains part of the outstanding stop-semantics work.
- Derive published endpoints from the actual listener address/port. Establish
  client reachability for specific-interface binds and automatically assigned
  ports; do not assume a listener bound to a LAN address also accepts loopback.
  Delivered.
- Sequence startup from hydrated intent: runtime initialization, atomic
  priorities/eviction configuration, accelerator readiness, optional HTTP
  startup, and requested model preloading. Keep local history/settings usable
  while runtime stages are unavailable. Delivered.
- Honor service autostart, configured port/bind, and exact selected variants.
  Configuration changes requiring native reinitialization use a controlled
  child restart, never a second native manager inside the same process.
- Preserve structured accelerator registration results, including partial
  failure. Block incompatible preloads until their requirements are met.
  A requested device preference whose available setters reject it fails.
  Registration results remain structured; alias/CPU-compatible startup loads
  continue while explicit variants with known requirements for unavailable
  providers are skipped. Unknown provider metadata proceeds to the runtime load,
  which remains responsible for reporting incompatibility. Delivered.
- Add operation-specific deadlines and progress handling. Webpage fetches now
  keep one deadline active through headers and body consumption, stream at most
  the configured byte limit before parsing, and cancel unused response bodies.
  Native `/status` readiness attempts are bounded by the remaining overall startup
  deadline and discard their unused bodies. Gateway `/status` rewrites and first-pass
  autoload-error inspection buffer no more than the configured byte cap; ordinary and
  replayed inference responses remain streamed without this cap. Finite read-only IPC
  query deadlines begin while startup is pending; expiry removes the pending request,
  prevents later dispatch, and ignores late replies. Outer deadlines retain headroom
  beyond legitimate nested probe budgets. Inference and effectful IPC operations remain
  unbounded because transport expiry would not establish native cancellation or outcome.
  Downloads and accelerator registration instead surface a notice after 60 seconds
  without reported progress; the operation remains pending, resumed progress restarts
  the quiet period, and settlement or runtime loss retires the notice. Native chat and
  transcription HTTP error diagnostics are capped at 64 KiB with a five-second body
  deadline. Gateway request replay limits are finite, non-negative, normalized once,
  and enforced while undeclared bodies stream; buffered `/status` and first-pass
  autoload-error captures also have a five-second completion deadline. Delivered.
- Distinguish "Stop HTTP", "Stop and unload", and "Quit runtime". Define draining,
  queued cancellation, stdin EOF, signals, and escalation. A blocked heartbeat
  alone must not trigger an automatic restart of legitimate native work. Stop HTTP
  withdraws the public endpoint without claiming model quiescence. Stop-and-Unload
  fences new IPC and gateway work, allows admitted work and eviction to drain within
  one deadline, unloads only after that drain, and reports timeout/failure without a
  false success. Quit Runtime uses the same cleanup, waits for the owned child close
  event, then escalates through the permitted shell kill command and reports
  unconfirmed termination if no close arrives. EOF and signals share single-flight
  terminal cleanup with an outer exit bound. Delivered.
- Propagate model-load and catalog-refresh failures to their callers. Replace
  empty refresh placeholders, swallowed errors, and success-shaped fallbacks.
  Model-load and catalog-refresh propagation are delivered. The UI now
  preserves the last known STT catalog when its focused refresh fails and reports
  the failure instead of replacing it with an empty success-shaped list. Runtime
  log-level requests now preserve the configured initialization level and reject
  unsupported changes with an explicit restart-required error.
- Surface `supportsToolCalling` and `contextLength` as catalog-declared metadata,
  clearly distinguished from Flint-verified behavior.
  Delivered for the model details view; neither field is presented as a runtime
  conformance guarantee.
- Make log-level changes effective or explicitly restart-required. Interpret a
  successful empty loaded-model enumeration as empty, not as failed telemetry.
  Delivered for runtime initialization and explicit restart-required changes.
- Use bounded asynchronous logging and explicit retention. Adding gateway
  observability must not introduce synchronous disk writes on every proxied
  request or record sensitive request bodies. Delivered: disk writes use a
  bounded asynchronous queue, seven-day file retention remains enforced, and
  queue overflow drops new log entries rather than blocking runtime work.

### Acceptance gate

Concurrent callers create one child and await initialization. Sidecar death
cannot leave a false RUNNING/READY state. Stop remains stopped despite late
starts. Audio does not interrupt an existing endpoint. Startup honors settings,
partial EP failure is visible, and uncertain work is not automatically repeated.

## Workstream C: Thin native ownership -- expedited

**Primary surfaces:** `src-tauri/src/lib.rs`, capabilities, typed frontend
transport, and native lifecycle handlers.

### Native responsibilities

- Single-instance behavior and ownership of exactly one runtime child.
- Child spawn, JSON-lines transport, generation tracking, exit observation,
  bounded restart/backoff, and confirmed termination of owned child handles.
- Native tray Open/Quit and macOS Reopen. Restore hidden/minimized windows;
  recreate a window where the selected keep-alive policy permits a no-window
  state. Do not rely on renderer JavaScript for recovery.
- Explicit close policy and quitting state. Preserve a recovery affordance until
  exit is committed; restore a visible error surface if quitting fails.
- Background notification delivery independent of webview callbacks.

### Responsibilities that stay in the runtime

The native Foundry manager, model selection/catalog, pool/admission, execution
providers, inference, and cache ownership remain under one sidecar authority.
The supervisor transports operations; it must not create a competing model pool.

### Cutover rules

1. Define and exercise the transport contract on the existing implementation.
2. Implement the supervisor behind a startup/build-time selection.
3. Select exactly one owner before spawning. Do not run JS and Rust spawn paths
   concurrently or silently fail over a mutation between them.
4. Confirm the old child has exited before replacement. Configuration restoration
   is explicit; active jobs receive truthful terminal or unknown outcomes.
5. Roll back only at a clean startup boundary using a compatible data format.
6. Remove unnecessary frontend shell privileges only when their replacement is
   complete and any supported rollback build has the capabilities it requires.

**Important:** Successful destruction of the last window currently exits Flint.
The confirmed Dock defect concerns a *hidden* window, not normal Tray Quit leaving
an app headless. Tauri awaits the async close handler; awaiting tray creation
before `preventDefault()` is not itself the reported race.

### Acceptance gate

Close, minimize, Dock reopen, tray failure, renderer unavailability, repeated
launch, child crash, and failed quit remain recoverable. The native manager never
moves into the UI process as a side effect of supervision. Shared ownership,
restart loops, duplicate execution, and stale-child events are excluded.

## Workstream D: Pool safety and background monitoring

**Primary surfaces:** gateway, pool eviction/registry, resource sampling, Arena
memory planning, and priority settings.

- Keep a request lease until the native operation's lifetime is accounted for,
  not just response headers or cancellation acknowledgement.
- Separate activity accounting from autoload eligibility. Include LAN, multipart,
  larger/streamed bodies, and autoload-disabled traffic without unbounded
  buffering. When the model cannot be identified, conservatively protect
  residency for the live exchange and bound/reject new admissions.
- Coordinate all load entry points with capacity reservations and per-alias
  mutation locks. Do not hold a global lock for an entire completion.
- Reject or queue within a declared limit when all capacity is protected.
  In-use variants cannot be replaced, and explicit uncached version requests
  cannot silently resolve to another cached version.
- Retain failed/unknown unloads in accounting until reconciliation establishes
  residency. Recheck pins and activity at execution time, not only when planning.
- Apply priorities/configuration atomically. A priority-only change must not run
  an eviction sweep against the old priority before installing the new pin.
- Cancel obsolete queued autoloads before entering native load. Deduplicated
  loads track remaining consumers; Stop/disconnect cannot start abandoned work.
- Maintain protection after caller cancellation if native completion is not yet
  established. Disconnecting a transport is not automatically native cancellation.
- Make the runtime the single owner of background sampling/evaluation, sharing
  the pure watchdog rules rather than maintaining competing frontend/runtime
  evaluators. The native supervisor delivers notifications and surfaces runtime
  unavailability or stale samples; the frontend renders snapshots. Separate
  foreground log refresh from watchdog work.
- Preserve system-wide memory wording and elapsed-time/hysteresis semantics.
  Treat missing telemetry as unknown, not zero. Zero free VRAM is known
  exhaustion. Use one memory budget on unified-memory hardware; establish actual
  model-budget behavior rather than declaring the suspected undercount proven.

### Acceptance gate

SSE cannot be evicted mid-operation; simultaneous admissions cannot bypass the
cap; changing to Keep loaded cannot evict its target. Failed unloads do not create
fictional free capacity. Background protection works from every last-selected
view and without a functional renderer, including missing telemetry and resume.

## Workstream E: Inference and responsiveness

**Primary surfaces:** typed message models, SDK adapter, sidecar chat paths, Arena,
compaction, and capability/metric reporting.

- Make chat adapter capabilities explicit and normalize native response-shape
  differences. Transport selection now reports named client/endpoint availability,
  and sidecar IPC SDK/HTTP completions remove Foundry-only status fields while
  returning one OpenAI-shaped message or delta choice. Gateway HTTP chat responses
  now apply the same normalization to JSON completions and streamed SSE
  chunks while preserving `[DONE]`; JSON normalization is attempted within a bounded
  threshold and larger JSON responses remain byte-preserving pass-through. Non-chat
  and ordinary streaming responses remain pass-through. Adapter scope delivered.
- Introduce explicit adapter capabilities for multipart input, streaming,
  generation settings, cancellation, and usage reporting.
- Preserve first- and later-turn images end to end. Use a verified supported
  multimodal API; an HTTP path must respect the user's service/exposure policy.
  Do not silently enable the public gateway or strip images to make a call pass.
- Apply actual SDK settings for Arena warmup/measurement and compaction. Add
  general chat controls only when the adapter enforces them.
- Prefer supported nonblocking streaming APIs, aggregating their results when a
  caller wants a final response. Do not assume an `async` wrapper makes a
  synchronous native command nonblocking or that Arena currently runs in parallel.
- If unavoidable blocking inference requires process relocation, relocate the
  **sole** manager into a supervised worker process. Do not add a second manager
  beside the existing pool, or initialize extra managers in Node worker threads.
- Make native cancellation capability explicit. Retain request ownership and
  memory protection where stopping display does not stop computation.
- Record actual resolved variant/provider and available timing/usage data.
  Distinguish TTFT, load time, end-to-end time, and decode throughput; label
  unavailable metrics rather than inventing values. Delivered for sidecar IPC
  chat access logs: cold/warm state, load and end-to-end time, observed TTFT,
  usage-derived rates when measurable, resolved variant, and active provider
  are recorded; buffered transports leave unavailable timing as null.
- Cover SDK/native response-shape differences and streaming terminators with a
  gateway behavioral compatibility harness. The harness exercises status rewriting,
  model routing/autoload replay, normalized JSON/SSE chat responses, and `[DONE]`.
  Do not promise tool/embedding support based only on route existence or catalog
  metadata. Delivered for the gateway chat boundary within the normalization threshold;
  broader capability checks remain open.

### Acceptance gate

Text and first/later image turns reach the intended model intact. Arena and
compaction budgets are enforced. Supported long operations do not stall proxy
forwarding or control handling through avoidable synchronous work. Native
parallelism/cancellation are claimed only where established.

## Workstream F: Model identity, imports, and ownership

**Primary surfaces:** `byom-import.js`, the shared pure prompt-template helper,
registry/model operations, and model/import UI.

- Use exact model identity, including version and ownership classification, for
  template get/set and deletion. Reject ambiguous publisher/name/version matches;
  do not use prefix lookup or the first discovered version.
- Share prompt-source resolution between inspection and activation. Preserve an
  accepted tokenizer-config or Jinja template even when the user did not edit it.
- Parse and validate configuration, existing inference metadata, identity,
  required files, and prompt placeholders before activation. Merely finding a
  `genai_config.json` filename is not validation.
- Keep browser/sidecar prompt validation identical and free of Node imports.
- Copy asynchronously with bounded work, progress, cancellation, space checks,
  and clear permission/disk failures. CPU/file-copy workers must not initialize
  a Foundry manager.
- Stage outside the discovered model subtree, using a same-filesystem atomic
  activation where possible. Do not assume a dot-prefixed staging name is
  excluded by the recursive native scanner.
- Recover or clean interrupted staging using explicit ownership records only.
  Invalidate cached-model indexes after every relevant mutation.
- Provide a read-only cache inventory for duplicate aliases, partial downloads, and
  reclaimable byte totals; recommendations must never authorize cross-root deletion. Delivered.
  Already-cached catalog metadata groups variants under friendly aliases when available; otherwise
  entries remain variant-scoped. Filesystem inspection errors are surfaced as an incomplete scan.
- Define safe behavior for editing a loaded model: defer changes or perform an
  explicit lease-aware unload/reload. Do not silently modify active state.
- Provide distinct **Unlink** and **Delete owned copy** operations. Generic native
  deletion must not stand in for an ownership guarantee.

**Evidence boundary:** The review did not establish that native removal of a
linked model deletes the foreign target. Establish this with throwaway fixtures;
until safe unlink-only behavior is implemented, refuse that ambiguous operation
and explain why. Never test against the user's model cache.

### Acceptance gate

Same-prefix names and multiple versions cannot cross-edit. The imported template
matches inspection. Interrupted, cancelled, or full-disk imports cannot expose a
partial model or delete foreign files. Unlink leaves every source byte intact.

## Workstream G: Audio sessions and transcript integrity

**Primary surfaces:** frontend recording/dictation/transcription, audio formatting,
runtime transcription, and operation presentation.

- Make the explicitly selected ASR alias authoritative. The legacy "audio lane"
  is an ordinal pool entry, not a safe substitute for a selected model identity.
- Use acquiring/recording/stopping states and session-owned recorder/stream
  handles. Release tracks on every setup failure, cancellation, and teardown.
- Separate background recording policy from keeping inference available.
  Default to stopping capture on hide unless the user explicitly enables
  background recording; show an ongoing-recording indicator and usable Stop.
- Produce valid standalone WAV data. Never fall back to passing original
  non-WAV bytes to the WAV-only path after conversion failure. The current
  browser path decodes supported uploads/recordings to 16 kHz mono PCM WAV and
  reports conversion failures instead of sending the original bytes.
- Do not assume the last two MediaRecorder fragments form a decodable file.
  Choose a supported capture/chunk pipeline for each shipped webview.
- Determine useful model input windows through model-specific capability and
  audio fixtures. Do not assert a universal native 30-second cutoff.
  Exercise short, medium, and long recordings.
- Preserve successful text with explicit failed ranges and retry/cancel controls.
  An all-failed or partially failed transcription cannot claim full completion.
- Normalize the SDK's word/delta/cumulative stream semantics instead of choosing
  one word and triggering a second full synchronous transcription by default.
- Label silence-derived timing as approximate; do not present unavailable model
  timestamps as native output.
- Keep chat and external clients working during transcription; ensuring audio
  prerequisites must not restart a healthy HTTP service.

### Acceptance gate

The selected ASR model is used with another ASR model resident. Microphone denial
and setup failure leave no live capture. Missing chunks are visible and retryable,
valid formats remain valid across capture boundaries, and cancellation has an
honest partial/terminal outcome.

## Workstream H: Packaging, release, and operational truth

**Primary surfaces:** Tauri resources/configuration, build/staging/verifier scripts,
Windows/macOS workflows, updater presentation, and current documentation.

- Add macOS microphone usage metadata and the entitlements required by the actual
  signing/capture configuration. Set the supported minimum OS from the complete
  bundled native dependency set, not Tauri's generic default.
- Add a dedicated local build command/profile using `--no-sign` where appropriate.
  Keep updater and OS signing requirements intact for release channels; never
  distribute unsigned updater artifacts as valid signed updates.
- Package the complete runtime JavaScript dependency graph for HTML extraction.
  Correct jsdom's runtime classification, but do not mistake that alone for
  packaging. The SDK's install-only adm-zip dependency is not the missing runtime
  parser problem.
- Validate all required native libraries and addons, target architectures, and
  deployment requirements. Fix target-versus-host selection for existing
  Windows/macOS builds. Validate per-target staged Node version metadata as part
  of avoiding stale/cross-target resource assumptions.
- Exercise the actual packaged/installed resource tree without ancestor
  `node_modules`, PATH Node, or a developer SDK. Include HTML context, not just
  manager construction from the checkout.
- Stage and validate installer replacements before committing the swap; retain a
  usable prior app if copying fails. Keep installer rollback and data-format
  rollback as separate guarantees.
- Maintain an explicit SDK/core/provider compatibility matrix for Windows and
  macOS. Establish what Windows standard/WinML packaging actually supplies.
  Do not fold a blind SDK upgrade into transport migration.
- Treat Developer ID/notarization credentials as an operator dependency for the
  signed macOS channel. Do not block unrelated fixes or weaken managed-device
  protections to conceal that dependency.
- Surface updater availability, last-check/error, progress, and restart/defer
  state. The About view now exposes an explicit update check, availability, and
  last error; installation/progress/restart/defer handling remains planned.
  Keep publication/draft handling explicit; only published compatible artifacts
  belong on the latest-update path.
- Make startup/native/EP download failures actionable. A working npm registry
  does not configure every Node, NuGet, catalog, and model-download endpoint.
  Richer diagnostics must respect approved trust/proxy configuration and redact
  credentials; never recommend disabling certificate verification.
- Extract orchestration modules as each domain is corrected. Add mounted
  hydration, mocked transport, native lifecycle, and installed-path coverage;
  retain pure-helper coverage without implying it covers the main orchestrators.
- Update Help, development/release instructions, roadmap status, and backend
  contracts with each behavior change. Remove stale manager-recreation guidance,
  unavailable command names, and inaccurate capability/support claims.

### Acceptance gate

Windows/macOS packages perform affected user flows without developer dependencies.
Microphone denial is handled, minimum OS declarations match packaged libraries,
replacement failure preserves the old app, and update status is honest. Each code
PR carries its changeset and focused regression coverage; docs-only planning does
not require a version bump.

## Finding-to-workstream register

This register keeps smaller review findings from disappearing behind the major
architecture work. "Risk" means establish behavior before claiming a failure.

| ID | Finding | Owner / disposition |
|---|---|---|
| DATA-01 | Autosave precedes hydration; initialization failure prevents restoration | A, Phase 0 |
| DATA-02 | Sidebar metadata lacks per-conversation messages and active ownership | A, Phase 1A |
| DATA-03 | Late compaction drops turns or crosses conversations | A, Phase 0 |
| DATA-04 | Old cancellation/finally clears a newer request | A + E |
| DATA-05 | URL completion resurrects/overwrites removed context | A |
| DATA-06 | Malformed URL throws during rendering | A |
| DATA-07 | Storage/title errors abort lifecycle registration or cleanup | A + C |
| RUN-01 | Duplicate spawn, send-before-ready, and obsolete child events | B + C |
| RUN-02 | Stale manager/readiness/endpoint after death; incomplete respawn | B + C |
| RUN-03 | Unconditional port 5272 start ignores preferences | B |
| RUN-04 | EP/preload race, ignored registration failures, unsupported preference setters | B + E |
| RUN-05 | Audio Ensure/Transcribe destructively restarts an existing service | B + G |
| RUN-06 | Overlapping Start/Stop, false endpoint, and partial-start/Apply failure | B |
| RUN-07 | Unbounded readiness/body/IPC waits and ineffective fetch size cap | B |
| RUN-08 | Queued autoload outlives stop/disconnect | B + D |
| RUN-09 | Stop HTTP, native cancellation, and process shutdown are conflated | B + C + D |
| RUN-10 | Load/catalog failures become success-shaped flows; log level is ineffective | B + H |
| RUN-11 | Actual bound-port reporting and specific-interface client reachability need a defined contract | B |
| MEM-01 | SSE lease ends at headers; non-autoload traffic lacks activity | D |
| MEM-02 | Concurrent admission exceeds cap; variant switching ignores active use | D |
| MEM-03 | Failed unload loses tracking; empty enumeration differs from unknown | B + D |
| MEM-04 | Pin arrives after config-triggered sweep; pin not rechecked at execution | D |
| MEM-05 | Hidden Monitor stops watchdog; renderer failure removes protection | C + D |
| MEM-06 | Null/zero telemetry handling; unified-memory budget undercount risk | D + E |
| INF-01 | First-turn multipart stringification/title failure; later SDK rejection | A + E |
| INF-02 | Arena/compaction settings accepted but not enforced | E |
| INF-03 | Synchronous native completion blocks proxy/control handling | E |
| INF-04 | Cancellation acknowledgement does not establish native completion | B + D + E |
| INF-05 | Non-standard API shape and missing/ambiguous metrics | E + H |
| MOD-01 | Prefix/first-version template lookup; uncached version silently substituted | D + F |
| MOD-02 | Inspected prompt source differs from imported prompt | F |
| MOD-03 | Malformed configuration and existing metadata accepted | F |
| MOD-04 | Synchronous multi-GB import stalls runtime | F |
| MOD-05 | Recursive-scanner staging/crash-cleanup visibility risk | F |
| MOD-06 | Linked deletion lacks explicit unlink/ownership guarantee | F, risk containment first |
| MOD-07 | Loaded-template change and cache-index reconciliation need defined behavior | D + F |
| AUD-01 | First resident ASR overrides explicit selection | G |
| AUD-02 | Concurrent microphone acquisition, leaked tracks, capture-on-hide policy | C + G |
| AUD-03 | Non-WAV fallback and non-standalone recorder fragments | G |
| AUD-04 | Failed chunks omitted as full success; word stream causes duplicate pass | G |
| AUD-05 | Medium/long input behavior and timing claims need model-specific evidence | G |
| MAC-01 | Hidden-window Dock reopen missing | C, independent Phase 0 fix |
| MAC-02 | Close policy depends on service state; tray/quit/cleanup failure paths | A + C |
| MAC-03 | Missing microphone privacy declaration | H, Phase 0 |
| MAC-04 | Minimum OS declaration disagrees with bundled native library | H, Phase 0 |
| PKG-01 | Local builds unnecessarily require updater signing credentials | H, Phase 0 |
| PKG-02 | HTML parser dependency graph absent from installed resources | H |
| PKG-03 | Incomplete native checks, host/target and staging assumptions | H, existing targets only |
| PKG-04 | Checkout-based smoke misses clean-installed failures | H |
| PKG-05 | Unsigned Mac distribution / notarization dependency | H, operator-gated channel |
| PKG-06 | Installer removes working app before replacement succeeds | H |
| PKG-07 | SDK/core/provider matrix and runtime packaging intent not established | B + E + H |
| QUAL-01 | Main page/SDK/sidecar orchestration and Rust lifecycle coverage gaps | Every affected workstream |
| DOC-01 | Stale version, commands, lifecycle guidance, and support assertions | H, alongside affected changes |
| LINUX-01 | No Linux app-build/release matrix or distro/native/media qualification | Deferred |
| LINUX-02 | Verifier does not recognize Linux installer formats | Deferred unless already needed by another feature |
| LINUX-03 | ARM64, GPU, tray/Wayland/audio/updater distribution qualification | Deferred |

### Source anchors

- Data/requests: `src/routes/+page.svelte`, `src/lib/conversation-repository.ts`,
  `src/lib/conversation-store.ts`, `src/lib/conversation-session.ts`,
  `src/lib/conversation-settings.ts`, `src/lib/conversation-export.ts`,
  `src/lib/chat-request.ts`.
- Runtime transport: `src/lib/sdk.ts`, `src/lib/operation-outcome.ts`.
- Service/inference: `sidecar/foundry-sidecar.js`.
- Pool/gateway: `sidecar/gateway.js`, `sidecar/pool-eviction.js`.
- Models/import: `sidecar/byom-import.js`, `sidecar/prompt-template.js`,
  `sidecar/model-registry.js`.
- Audio/memory: `sidecar/audio-format.js`, `src/lib/memory-watchdog.ts`, and
  `transcribeLongAudio` in `src/routes/+page.svelte`.
- Desktop/packaging: `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`,
  `src-tauri/capabilities/default.json`, `scripts/verify-bundle.cjs`,
  `scripts/smoke-bundled-node.cjs`, `vite.config.js`.

Follow symbols rather than line numbers; the review-baseline line ranges these
anchors originally carried no longer track the tree.

## Options after the corresponding correctness gates

| Capability | Prerequisite and scope |
|---|---|
| Close behavior, launch hidden, native recovery | C; keep background service and background recording as separate choices |
| Startup progress and per-stage retry; endpoint-only startup | B + C; do not force preloading or publish false readiness |
| Conversation export/import, backups, per-conversation controls | A; include supported restore/rollback and visible storage errors |
| Generation controls and configurable auto-compaction | A + E; expose only settings the adapter enforces |
| Operation queue, cancellation, retry, stop-and-unload | B + D + E; uncertain operations are not blindly replayed |
| Microphone selection, recording duration, partial-range retry | G; explicit session state and device permission handling |
| Read-only cache inventory, partial/duplicate reporting, unlink | F; recommendations do not authorize cross-root deletion |
| Endpoint profiles, connection tests, chat/audio routing | B + E; existing helpers must be wired before exposure, with explicit opt-in and no automatic cloud fallback |
| Actual provider and TTFT/load/decode metrics; compatibility diagnostics | E + H; distinguish catalog-declared from behaviorally established support |
| Managed-network doctor and redacted support bundle | H; respect approved proxy/trust settings, never collect secrets or disable TLS verification |
| Visible updater availability/progress/errors/restart/defer | H + C; basic failure visibility belongs with correctness, richer UI can follow |

RAG, autonomous agent execution, a second Foundry CLI, and new embedding workflows
are not prerequisites for this reliability program.

## Gate for reconsidering a Rust runtime replacement

Revisit only after the critical data/runtime findings have been corrected and
native supervision is stable:

- Supported Rust/native bindings cover the required Windows/macOS catalog,
  variants, EPs, streaming, multimodal, audio, and model/cache operations.
- The same behavioral contract covers both implementations, including partial
  failure, cancellation uncertainty, and process recovery.
- A bounded prototype demonstrates a material benefit in responsiveness,
  reliability, startup, or distribution cost. Language preference alone is not
  sufficient evidence.
- There is still one manager/pool authority, and native failure remains isolated
  from the desktop process. `spawn_blocking` alone is not process crash isolation.
- Cutover/rollback does not require simultaneous cache/data migration, duplicate
  runtimes, or replaying uncertain operations.

The near-term destination is a **native desktop supervisor with a reliable,
replaceable runtime process**, not a deadline-driven removal of Node.
