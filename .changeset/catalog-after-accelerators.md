---
"flint": patch
---

Populate the model catalog after registering every discovered accelerator so compatible GPU variants are available.
Keep tracking loaded models across a service restart so deletion and unload cannot run beneath active requests.
