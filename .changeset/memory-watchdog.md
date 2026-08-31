---
"flint": minor
---

Warn before the machine runs out of memory, and give the model pool a way to bound itself.

A memory watchdog now samples system RAM and per-GPU VRAM regardless of which tab is open,
raises an in-app banner and a native OS notification when usage stays high, and clears itself
once usage drops back below the threshold with hysteresis. RAM and VRAM have separate limits
because a GPU legitimately runs near capacity during inference. The sustain window is measured
in elapsed time rather than samples, since polling slows down in the background, and a gap in
sampling — a suspended laptop, a throttled webview — or an edited threshold restarts the window
instead of firing immediately on stale history. Because the underlying telemetry is system-wide
rather than Flint's own footprint, alerts only appear while Flint actually has models resident
and the wording never claims the memory is Flint's. Alerts can be dismissed per device, the
thresholds and sustain window are adjustable, and the whole watchdog can be turned off.

The model pool can now evict. Two independent rules, both off by default, unload models after
an idle timeout or keep at most N resident, evicting least-recently-used first. Models can be
marked `pinned` so they are never unloaded — including while idle-unload is on — or `low` so
they are given up first. A model is never evicted while a request is in flight, including
requests arriving through the OpenAI-compatible gateway, which the pool previously could not
see. When the cap is in force, room is freed before a new load commits memory rather than
after. Idle time and priority are shown per model in the pool table.
