---
"flint": minor
---

Add the storage layer for the versioned conversation archive.

The schema module decides what is safe to keep; this decides when it is safe to write. Its
guiding rule is that a read we did not fully understand must never become a write, which is
exactly how the pre-v2 data loss happened.

- Opening an archive that is unreadable, incompatible, or newer than this build blocks
  writing for the session instead of starting fresh over it, so a stale migration can never
  replace a real archive.
- Bytes that could not be fully parsed are copied to a backup key before anything overwrites
  them, and the copy is read back before it is trusted — a backup that did not persist would
  otherwise authorize destroying the original.
- Backup slots are addressed by content rather than by the clock, so two payloads preserved
  in the same millisecond cannot overwrite each other and an unparseable archive is not
  re-copied on every launch.
- Saving validates the whole candidate through the schema first and refuses when anything
  would be dropped or rebuilt on the next read, leaving the previously saved archive intact.
  Deliberately preserved unknown content is the one exception, so an archive holding data
  from a newer build stays saveable.
- Saving never lowers a rollback floor the stored archive already declared.
- Legacy migration reads both pre-v2 keys before deciding anything, reports damaged sources
  as damage rather than as an empty history, and never deletes the old keys as part of the
  conversion.
