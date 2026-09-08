---
"flint": patch
---

Reliability fixes for chat persistence, async result ownership, sidecar and service lifecycle,
model pool safety, and macOS packaging.

**Chat and settings no longer reset on launch.** The autosave effect ran at mount and wrote
in-memory defaults over the saved blob before it was ever read, so every launch discarded the
chat history and reverted settings such as the service port and autostart. Persisted state is
now hydrated before autosave is enabled, and every writer honours that gate.

**Storage failures are visible and non-destructive.** Unreadable or corrupt data is preserved
under a `.corrupt` backup key and reported in a dismissible banner instead of being silently
replaced. When the bytes cannot be preserved, saving stays disabled for the session rather than
destroying the only copy. Lifecycle listeners are also registered before any storage work, so a
storage error can no longer strand the app without its keyboard handler or close-to-tray hook.

**In-flight results can no longer land in the wrong conversation.** Streaming completions,
summarization, dictation and URL fetches identified their target by array position, so switching
conversations or loading another model mid-flight wrote the result into an unrelated thread.
Each now tracks the thread and message it belongs to and discards results that no longer apply.
Concurrent URL fetches also keep the spinner accurate, and detected URLs are validated before a
fetch chip is offered.

**The sidecar can no longer be started twice or reported healthy after it dies.** Concurrent
callers could each spawn a child process, and a crashed sidecar still reported ready — Retry
returned success without re-initializing anything. Startup and initialization are now
single-flighted and tied to a specific child, and a lost sidecar clears the endpoint and the
model residency it owned.

**The local service honours your settings and is no longer restarted needlessly.** Startup
always started the service on a hardcoded port regardless of the autostart setting or the
configured port and bind address. Separately, transcribing audio and "Ensure service" performed
a full service restart, which evicts every loaded model and resets usage counters; they now load
what they need into the running service. All service starts and stops are serialized, so a
restart can no longer tear the service down underneath in-flight work.

**Models are no longer unloaded while they are still answering.** A streamed completion through
the local endpoint reported the model idle as soon as response headers were sent, so the idle
and max-resident eviction rules could unload it mid-generation; the model is now held for the
whole exchange. Loading the same model twice at once is serialized, a variant switch is refused
while requests are in flight, and a failed unload no longer drops the model from the pool as
though it had succeeded. Choosing "Keep loaded" while enabling a memory limit no longer evicts
the model being pinned.

**macOS: clicking the Dock icon restores the window again.** After close-to-tray the window is
hidden, and nothing handled `RunEvent::Reopen`, so the app appeared to be gone.

**macOS: added the microphone usage description**, without which the system terminates the app
when the Audio tab starts recording, and **raised the declared minimum to macOS 14**, matching
the bundled `libonnxruntime.dylib`. The installer now rejects older macOS with a clear message.

**Added `npm run tauri:build:local`** for local packaging without signing credentials.
