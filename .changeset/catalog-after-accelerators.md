---
"flint": patch
---

Populate the model catalog after registering every discovered accelerator so compatible GPU variants are available.
Keep loaded-model tracking accurate across restarts and eviction, and safely refuse catalog changes blocked by expired telemetry.
