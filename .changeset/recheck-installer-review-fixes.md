---
"flint": patch
---

Fix the Windows installer's commit-phase backup cleanup and running-app check, and move a provider cache aside before deleting it so a locked file cannot leave it half removed.
