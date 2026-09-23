---
"flint": patch
---

The MSI now moves the installed Foundry SDK aside before an upgrade and puts it back on rollback; its command lines previously skipped both steps. Neither installer puts a leftover SDK backup over a working install when the install fails or is cancelled.
