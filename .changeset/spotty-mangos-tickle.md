---
"flint": patch
---

Preserve conversation data the schema does not fully own: messages with an unrecognized role are now kept rather than discarded, fields parked in `extra` by an older build are recovered on re-upgrade, and keys that collide with `Object.prototype` survive a round trip. Adds a typed per-conversation settings contract over the opaque settings bag, and a title policy that stops a save from renaming a conversation whose thread is not loaded, overwriting a recovery label, or discarding a user-chosen name.
