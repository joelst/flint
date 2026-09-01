---
"flint": minor
---

Keep the local service running when the window is closed.

The inference service lives in Flint's sidecar process, so quitting the app always killed the
endpoint that external tools were pointed at. Now, while the service is running, closing the
window hides Flint to the system tray instead of quitting — the endpoint stays available, a
one-time notification says so, and the tray menu offers "Open Flint" and "Stop service and
quit" (which stops the service gracefully before exiting). The behavior is controlled by a new
"Keep service running in background" toggle in Settings → System (on by default), only kicks in
while the service is actually running, and falls back to a normal quit if the tray cannot be
created so a hidden window can never be stranded.
