---
"flint": patch
---

Remove an unused import of `ARCHIVE_BACKUP_KEY` from the main page component. The backup key is
interpolated into the hydration notice by the repository layer, so the component never needed the
symbol.
