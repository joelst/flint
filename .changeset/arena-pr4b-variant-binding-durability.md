---
"flint": patch
---

Fix benchmark preview variant handling: a fresh explicit-variant target whose load resolved to a different build is now rejected instead of silently executed, and the variant actually bound to an alias-only target is now durably persisted before dispatch so Resume recovers the correct build even after a Stop/crash leaves a position mid-flight.
