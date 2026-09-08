---
"flint": minor
---

Add the versioned conversation archive schema that underpins durable chat history.

Flint's pre-v2 storage kept a sidebar index of conversation titles under one key and a
single global message thread under another, so selecting a different conversation cleared
the thread and the next autosave wrote the empty thread over the only stored copy.

This adds `src/lib/conversation-store.ts`, a pure schema, validation, and migration module:

- A versioned archive with a declared `minAppVersion` rollback floor, so an older build
  refuses to write over an archive it cannot read instead of silently discarding it.
- Normalization that preserves every message flag the chat pipeline depends on
  (`isError`, `pinned`, `condensed`, `isSummary`) plus an `extra` escape hatch, so a field
  a newer build added survives a round trip through an older one.
- Content parts this schema does not model are kept verbatim in an opaque envelope rather
  than dropped or mistaken for renderable parts.
- Every repair is reported rather than applied silently: dropped conversations, dropped
  messages, dropped and unrecognized parts, substituted identifiers, and rewritten header
  fields all surface so the storage layer can retain the original bytes.
- Legacy migration imports the title-only sidebar entries, marks them as having
  unavailable turns, and imports the one real thread as a clearly labelled recovered
  conversation with an id derived from its own contents so a retried migration cannot
  create duplicates.
