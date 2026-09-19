---
"flint": patch
---

Allow the app's own local gateway to be reached at http://127.0.0.1 (not just http://localhost) so the endpoint self-test and other in-app fetches don't fail CSP. A ::1 bind is published as http://localhost so WebView2 CSP can allow it.
