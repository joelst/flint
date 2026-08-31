---
"flint": minor
---

Serve models on demand, so any OpenAI-compatible client works without loading a model in
Flint first. Foundry Local only answers for a model that is already resident in memory, and
it exposes no HTTP route to load one, so a coding agent or IDE plugin that read `/v1/models`
and posted to a model it found there received `400 Model 'X' is not loaded` with no way to
recover. Flint now listens on the configured port itself and forwards to the native service,
and when that specific rejection comes back it loads the model and replays the request once.

The proxy forwards first and inspects afterwards, so Foundry still performs all routing and
request validation and a bad request cannot trigger a multi-gigabyte load. Only the exact
not-loaded rejection is retried, only once, and only for a model that is already downloaded,
so a stray or hostile identifier can never start a download. Loads are serialised and
deduplicated, which collapses a burst of concurrent requests for the same model into one
load. Streaming responses are passed through untouched, so tokens still arrive as they are
produced, including on the replayed request.

This also fixes service start, which failed with `Foundry Local Core is already initialized`
every time it ran after initialization. The native core can only be initialized once per
process, so the manager can never be re-created to change its port; Flint now takes the
port the service reports and proxies the configured port to it. As a result the configured
port and bind address are honoured for the first time.
