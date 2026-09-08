---
"flint": minor
---

Stop destroying conversation history when switching chats.

Conversations were an index of titles only: every message lived in a single global thread, and
selecting a conversation blanked that thread rather than loading anything. Switching away from a
chat therefore discarded it permanently.

Conversations now own their messages in a versioned archive, and a thread may only be written back
to the conversation it was loaded from, so an empty editor can never be mistaken for an empty
conversation. Chats started from a model card get a real destination instead of being dropped,
saves are retried when storage fails, and the sidebar marks conversations whose messages the
migration could not recover.
