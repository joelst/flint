---
"flint": patch
---

Fix a race in Arena's benchmark Start path where two concurrent starts of the same run could both pass their reservation checks and dispatch the schedule twice.
