## Summary

<!-- What user problem does this change solve? -->

## Flint seam

- [ ] Frontend pure module
- [ ] Frontend/SDK boundary
- [ ] Sidecar command or runtime
- [ ] Rust/Tauri shell
- [ ] Packaging/release
- [ ] Documentation only

<!-- List touched files, commands, contracts, and ownership boundaries. -->

## Safety and compatibility

- Runtime owner remains: <!-- e.g. Node sidecar / Rust shell -->
- New or changed command:
- Effect and cancellation semantics:
- Failure or uncertain-outcome behavior:
- Storage, resource, or permission impact:
- 0.7.0 impact: <!-- required, optional, or explicitly deferred -->

## Validation

- [ ] `npm run check`
- [ ] Focused tests
- [ ] `npm run verify:ipc-contracts` (when IPC/runtime files change)
- [ ] `npm run verify:bundle` (when resources/runtime packaging changes)
- [ ] `git diff --check`

## Handoff

- Lane owner: <!-- who owns this lane going forward -->
- Next contributor should know: <!-- assumptions, known follow-ups, anything not to infer -->
