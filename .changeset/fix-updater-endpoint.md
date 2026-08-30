---
"flint": patch
---

Fix the auto-updater never finding a new version.

The updater endpoint pointed at `releases/download/v{{current_version}}/latest.json`,
which resolves to the manifest attached to the release the user is already running.
That manifest always reports the running version, so every client reported "up to
date" forever. Point the endpoint at the floating `releases/latest/download/latest.json`
URL instead.

Clients at v0.4.4 and earlier have the old URL compiled in and cannot self-update, but
that release was never distributed, so no rescue is needed. `docs/RELEASE.md` records
that a release left as a draft or flagged as a pre-release is invisible to the updater.
