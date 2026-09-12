# Flint 0.7.0 foundation release

This release is a shareable Windows/macOS Apple Silicon prerelease. It is
intended to establish a dependable Flint core and a documented extension
surface, not to finish every item in the reliability backlog.

## Release promise

Flint 0.7.0 provides:

- bundled Node 22 and Foundry resources in packaged builds;
- model catalog, download, load, unload, and cached-model autoload;
- local streaming chat and supported audio transcription;
- the Model Arena, conversations, diagnostics, monitoring, and integrations;
- an OpenAI-compatible local endpoint with explicit bind and port behavior;
- a documented frontend/SDK/sidecar boundary for adding workflows without
  creating another Foundry manager.

The release remains pre-1.0. It must not promise Linux support, cloud routing,
tool execution inside Flint, broad audio decoding, timestamps, or RAG until
those capabilities are separately validated.

## Required gates

### Build and package

- [x] Version is `0.7.0` in `package.json`, `src-tauri/tauri.conf.json`, and
  `src-tauri/Cargo.toml`.
- [x] `npm run verify:release -- 0.7.0 --channel=evaluation` passes before
  publishing or sharing the handoff packet. The explicit channel flag is
  required because `0.7.0` is a stable SemVer used for an evaluation handoff;
  it must not be inferred from the updater endpoint. When using the release
  workflow, select the `evaluation` channel; this forces GitHub prerelease
  publication even for an unsuffixed `0.7.0` version.
- [ ] Do not push `v0.7.0` directly. Run the release workflow manually with
  `version=0.7.0`, `channel=evaluation`, and the intended handoff ref so an
  unsuffixed evaluation build cannot become the stable `releases/latest`
  publication.
- [ ] Windows installer is built and signed through the normal release path.
- [ ] macOS Apple Silicon DMG/app is built and its unsigned-install limitation
  (Gatekeeper "damaged" warning workaround) is called out in the release notes.
- [ ] Target-specific bundle verification passes for each artifact.
- [ ] The build is shared as an evaluation prerelease outside the updater
  channel. The current `releases/latest` endpoint intentionally does not
  discover prereleases.

### Supported-flow smoke test

Run these scenarios from the packaged application, not only `tauri dev`:

1. Install on a clean machine with no PATH Node, Rust, or Foundry CLI.
2. Launch Flint and confirm the bundled sidecar reaches ready. On macOS, verify
   the quarantine workaround (`scripts/install-macos.sh` or `xattr -cr`) allows
   launch without Gatekeeper errors.
3. Discover, download, and load a small model.
4. Send a streaming chat request and stop one request.
5. Transcribe a supported audio file and use the microphone flow.
6. Start the local service and connect with an OpenAI-compatible client.
7. Restart the service and confirm endpoint state is truthful.
8. Quit and relaunch; confirm conversations and settings remain available.
9. Exercise tray hide, restore, and macOS Dock reopen where applicable.
10. Confirm a missing runtime, failed model load, and failed service start
    produce visible errors rather than success-shaped state.

Record the OS version, artifact name, model alias/variant, and any failure.
Do not describe an unrun scenario as verified.

For a target build, include its target triple in verification:

```bash
npm run verify:bundle -- --target <triple> --require-build
```

### Installation and profile integrity

- [ ] Install the 0.7.0 evaluation build on a clean environment or disposable test profile.
- [ ] Confirm export and import of test conversations works as expected.
- [ ] Confirm conversations and settings persist across restarts.
- [ ] Do not present an evaluation prerelease as an in-place updater upgrade.

### Runtime ownership

- [x] Rust owns exactly one sidecar child, generation-checked JSON-lines
  transport, exit observation, and app-exit cleanup. The renderer has no
  spawn/stdin/kill permission.
- [ ] Exercise crash, renderer reload, failed quit, tray restore, and macOS Dock
  reopen from the packaged Windows and macOS artifacts.

The minimum native-supervisor gate is tracked in
[PRODUCT_PLAN.md](./PRODUCT_PLAN.md) and
[BACKLOG.md](./BACKLOG.md). Rust must own exactly one sidecar child and observe
its termination; the Node sidecar remains the sole owner of the Foundry manager,
catalog, pool, gateway, cache, and inference. No uncertain operation may be
replayed during recovery.

The process-ownership cutover does not complete the packaged lifecycle gate.
Until the remaining installed-path scenarios pass, label the artifact an
evaluation prerelease and state that limitation explicitly.

## Handoff packet

Share these together:

- installer or DMG and SHA-256 checksum;
- this checklist with completed gates marked;
- release notes with supported platforms and known limitations;
- [EXTENDING.md](./EXTENDING.md);
- [DEVELOPMENT.md](./DEVELOPMENT.md);
- [USER_GUIDE.md](./USER_GUIDE.md);
- a short list of tested model aliases and variants;
- the endpoint URL and one verified client recipe.

Feedback should include the Flint version, OS/build, model alias and resolved
variant, the operation being attempted, and the redacted diagnostics export.
Never request credentials, API keys, or unredacted local logs.

## What comes next

After the handoff, prioritize the thin Rust supervisor and installed-path
recovery tests. Then evaluate document/RAG and embeddings work only after a
supported embedding-model path exists. Audio decoder and timestamp work
remains coordinated with the Foundry SDK rather than being a 0.7.0 release
blocker.
