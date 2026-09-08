---
"flint": minor
---

Each conversation now remembers its own model, persona, context length and thread view.

The chat header's model picker, persona menu, context selector and full-thread toggle were always
presented as belonging to the chat, but were a single set of application-wide values: changing the
persona in one conversation changed it in all of them, and switching conversations silently carried
the previous one's configuration across.

Conversations have stored these settings since the archive was introduced, but they were never
applied, because there was no record of the application defaults an absent setting is supposed to
inherit — so applying them would have leaked the previous conversation's model and persona and
then republished it as an application-level setting. That baseline now exists, and resolution is
read-only: opening a conversation never writes overrides onto it, so a value this build cannot use
is preserved rather than repaired, and a setting left to inherit stays inherited.

Only explicit choices are stored. Runtime behaviour — clearing a model whose files were deleted,
auto-selecting the first available model, and clamping the context length to what a small model
supports — changes the live chat without being recorded against it.

A conversation whose model is not installed on this computer now says so, in the picker and in the
empty chat, instead of appearing ready and failing on send.
