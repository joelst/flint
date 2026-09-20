---
"flint": patch
---

Fix misleading validation errors in benchmark preview start/resume: a mismatched validation failure no longer always claims duplicate target aliases — Start now surfaces the suite validator's actual errors, and Resume/direct-start reservation checks only cite duplicate aliases where that is truly the only possible cause.
