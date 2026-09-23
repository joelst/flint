---
"flint": patch
---

The MSI now moves the installed Foundry SDK aside before installing 1.2.4 and puts it back on rollback; its command lines previously skipped both steps, and its backup cleanup was scheduled where Windows Installer never runs it. Neither installer puts a leftover SDK backup over a working install when the install fails or is cancelled.
