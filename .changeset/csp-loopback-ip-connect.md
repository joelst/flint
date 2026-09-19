---
"flint": patch
---

Allow the app's own local gateway to be reached at http://127.0.0.1 and http://[::1] (not just http://localhost) so the endpoint self-test and other in-app fetches don't fail CSP with "Failed to fetch" when the service binds to a loopback IP.
