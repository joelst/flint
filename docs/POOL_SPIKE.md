# Model Pool Spike — Protocol & Results Capture

Investigation script for [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md) MVP 0.3 model pool (complete; protocol retained for re-runs).

## What the spike answers

Before designing the model pool API in the sidecar, we need empirical answers to four questions. The current `lane.chat` / `lane.audio` structure assumes Foundry Local will hold one chat-class model and one audio model resident; the pool design needs to know whether that assumption can be relaxed.

1. **Co-residency** — When model B is loaded after model A, does Foundry Local keep A resident, or does B silently evict A?
2. **HTTP routing by alias** — Does the OpenAI-compatible endpoint route `POST /v1/chat/completions` by the `model` field in the request body, serving whichever alias the client asks for?
3. **Hot-switch cost** — After switching A → B → A, is the second A call instant (A never left memory) or does it pay a reload penalty (A was evicted and lazily reloaded)?
4. **Memory observability** — How much RSS does the sidecar process grow per loaded model? Useful for the budget-aware admission rule in the pool design.

## Prerequisites

- Foundry Local installed and reachable (you must have run Flint successfully at least once).
- Both candidate models already **downloaded** into the Foundry cache. The script does not download — it expects `await manager.catalog.getModel(alias).load()` to succeed against locally-cached weights.
- Node 22+ (matches Flint app preflight; script uses native `fetch` and ES modules).
- No other Foundry web service running on the chosen port (default `5273`).
- Flint **not running** during the spike — we need exclusive access to the local service.

### Choosing model aliases

Pick **two small chat-class models** that together fit comfortably in your available memory. Suggestions (verify availability in your catalog):

- A pair of <2 GB chat models is ideal (Phi-3-mini variants, Qwen 2.5 0.5B/1.5B variants, similar).
- Avoid mixing a vision/STT model with a chat model — the script only exercises chat completions, so a non-chat model on either side will skew the HTTP routing result.

If your hardware can't comfortably host two chat models, the spike will still produce a useful answer: the `load-B-complete` step will report `evictionDetected: true` and the verdict bucket will be `silent-eviction-detected`. That **is** the answer in that case.

## How to run

### Step 1 — discover catalog aliases

The script accepts **catalog aliases**, NOT resolved variant ids. `phi-4-mini` is a catalog alias; `phi-4-mini-cuda-gpu:2` is a runtime variant of that alias chosen by the SDK based on registered execution providers. Pass only the base alias.

From the repo root:

```powershell
node sidecar/scripts/pool-spike.mjs --list
```

This prints all aliases the SDK sees with their `cached` flag (whether you have weights downloaded) and `task` metadata. Pick two with `task: chat-completion` and `cached: yes`.

### Step 2 — execution provider setup (one-time per machine)

The Foundry Local SDK has **no `setPreferredEp` method**. The way to bias variant selection is to **register** an execution provider: `manager.downloadAndRegisterEps([name])` invalidates the catalog cache so subsequent `getModel(alias)` calls prefer variants compiled for that EP.

A fresh installation has zero EPs registered, so `catalog.getModel(alias)` falls back to a generic-cpu variant. If your downloaded weights are GPU/NPU variants, the generic-cpu variant won't exist on disk and `load()` fails with `Model path does not exist`.

**Find the exact EP names for your machine first** — run `--list` and look at the "Discovered execution providers" header. They use ONNX-Runtime style names, e.g.:

- `CUDAExecutionProvider`
- `WebGpuExecutionProvider`
- `NvTensorRTRTXExecutionProvider`
- `DmlExecutionProvider` (DirectML)
- `QNNExecutionProvider` (Qualcomm NPU)
- `OpenVINOExecutionProvider`

Pass the **exact case-sensitive name** to `--ep`. Two registration strategies:

- **Register one specific EP** (fast, downloads only that EP's package):
  ```powershell
  node sidecar/scripts/pool-spike.mjs <aliasA> <aliasB> --ep CUDAExecutionProvider
  ```

- **Register all available EPs** (slow first time — downloads every EP package; exhaustive):
  ```powershell
  node sidecar/scripts/pool-spike.mjs <aliasA> <aliasB> --register-eps
  ```

The script prints discovered EPs at the start of every run (the `eps-discovered` step) so you can confirm exactly what your machine exposes and whether registration succeeded.

### Step 3 — full spike

```powershell
node sidecar/scripts/pool-spike.mjs <aliasA> <aliasB> [--port 5273] [--ep <name>] [--register-eps]
```

The script prints a one-line summary per step to stdout while it runs, then writes both a `.json` and `.md` report under `docs/pool-spike-results/`.

### Suggested model pairs

Once you've run `--list` with `--ep` set so the `cached` column reflects reality, pick two with `task: chat-completion` and `cached: yes`. Pairs to consider:

- `phi-4-mini` + `qwen3.5-2b-text`  (both chat-completion, both small)
- `phi-4-mini` + `qwen2.5-1.5b`
- `qwen3-0.6b` + `qwen2.5-0.5b`  (tiny — quickest iteration)

**Aliases to avoid for this spike** (they will skew the routing result because they are not pure chat models):

- `qwen3-vl-*` / `qwen3.5-2b` / `qwen3.5-4b` / `qwen3.5-9b` / `ministral-3-3b-instruct-2512` → `vision-language-chat`
- `whisper-*` / `nemotron-*-speech-*` → `automatic-speech-recognition`
- `qwen3-embedding-*` → `embeddings`

Note that several Qwen3.5 variants in a typical catalog use **`-text` suffix for the chat-completion variant** (`qwen3.5-2b-text`), while the unsuffixed alias (`qwen3.5-2b`) is the vision-language model. Pick carefully from the `--list` output.

## How to interpret the verdict

The script bins the run into one of these buckets (printed at the end and saved in the report):

| Verdict bucket | What it means | Pool design implication |
|---|---|---|
| `optimistic-pool-works` | Both models served HTTP requests by alias; no eviction signal; no large reload penalty on A's second call. | Build the pool as a simple `Map<alias, model>` — no proactive eviction needed for the first cut. |
| `silent-eviction-detected` | After loading B, A's `isLoaded` flipped to false. | Pool must implement budget-aware proactive eviction. We track which models are resident in the pool's *intent* layer, but expect Foundry to evict at will, and re-load on demand. |
| `lazy-reload-on-switch` | Both calls eventually succeeded, but A's second call took ≥5× longer than the first — implies A was reloaded transparently. | Pool can be "logical" (track intent) but must surface latency cost to users on switch. UI should warn before hot-swapping. |
| `http-routing-broken` | An HTTP chat call returned non-OK status. The OpenAI-compat endpoint may only serve the active model regardless of `model` field. | Pool design must use in-process `createChatClient` per model rather than HTTP routing by alias. Bigger refactor. |
| `inconclusive` | No known signature matched. | Read the `steps` array and report; spike needs refinement. |

## Capturing the result

Each run writes:

- `docs/pool-spike-results/pool-spike-<timestamp>.json` — full structured data (steps, timings, memory, verdict).
- `docs/pool-spike-results/pool-spike-<timestamp>.md` — human-readable table with a "Notes for design" placeholder section.

**After running**, edit the markdown report to add observations under "Notes for design" — anything the script couldn't auto-classify (visible memory pressure, watchdog logs, fan noise, etc.) is exactly what the pool design discussion needs.

## What the spike does NOT cover

Deliberate scope cuts for this spike:

- **Three or more concurrent models.** Two is the minimum signal we need; three+ would multiply variables before we've answered the binary question.
- **Mixed model classes** (chat + audio + vision together). Lane separation already covers that case — the open question is specifically same-class co-residency.
- **Concurrency under load** (parallel requests to A and B at the same time). Sequential alternation first; concurrency stress is a follow-up.
- **Different acceleration providers** (CPU vs. GPU vs. NPU). We use whatever Foundry picks automatically. Cross-provider co-residency is its own follow-up.

## After the spike: what gets built

The verdict determines the **next** design ticket:

- `optimistic-pool-works` → write the `ModelPool` class in the sidecar, replace `lane.chat` / `lane.audio` callers gradually, add a `poolStatus` command for the upcoming Monitoring view.
- `silent-eviction-detected` → write the pool as an *intent registry* with LRU eviction policy; track `requestedLoaded` vs. `actuallyLoaded` and surface the gap to the UI.
- `lazy-reload-on-switch` → same as optimistic-pool-works, plus a "switching model — this may take Xs" toast in the UI.
- `http-routing-broken` → pool must use in-process `createChatClient` per model; HTTP endpoint becomes a single-model surface as today.

In every case, hardware-aware admission (memory budget check before load) lands as the same follow-up.
