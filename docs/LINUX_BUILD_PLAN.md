# Linux Build Plan

Plan for shipping a Linux build of Flint. Written 2026-09-01; status lives here until the work
lands, then this folds into [RELEASE_ROADMAP.md](../RELEASE_ROADMAP.md).

## Goal and scope

- **Target:** x86_64 Linux desktop (glibc), packaged as **AppImage** (primary, self-updating) and
  **.deb** (secondary). CPU inference first.
- **Out of scope for the first cut:** aarch64 Linux, RPM/Flatpak/Snap, GPU execution providers on
  Linux (CUDA/ROCm), WSL-as-a-target (Windows users already reach Flint from WSL via mirrored
  networking — Settings → Network → WSL clients).

## What already works (inventory, verified in-repo)

Surprisingly little is missing — the plumbing was built platform-aware:

| Piece | Status |
|---|---|
| Foundry native core for Linux | `foundry-local-sdk` publishes `linux-x64` / `linux-arm64` NuGet RIDs; `scripts/ensure-foundry-native.cjs` already lists both as installable and maps the Rust triples |
| Bundled Node runtime | `scripts/ensure-bundled-node.cjs` already maps `x86_64-unknown-linux-gnu` → `node-linux-x64.tar.xz` |
| Sidecar | Platform-neutral except `coreLibraryFileName()`, which already returns `.so` on Linux; WSL commands correctly refuse off-Windows |
| Rust/Tauri compile on Linux | CI (`ci.yml`) already runs `cargo check` + full test suite on `ubuntu-latest` with the webkit2gtk/GTK dependency set |
| Frontend platform gates | `detectPlatform()` returns `'unix'` → bash snippets in Integrations; the WSL settings section is gated to Windows hosts |
| Autostart / notifications / updater plugins | All support Linux in Tauri v2 (updater: AppImage only — see below) |

## Unknowns to spike first (do these before any packaging work)

1. **Does the Foundry Local core actually run on Linux?** The `.so` downloads exist, but nothing in
   this repo has ever executed one. Spike (no Tauri needed, ~half a day on any Ubuntu 22.04+ box or VM):
   ```bash
   npm ci
   npm run ensure:foundry -- --target x86_64-unknown-linux-gnu
   node sidecar/foundry-sidecar.js
   # then drive it over stdin with JSON lines:
   # {"id":1,"cmd":"init","appName":"flint","logLevel":"info"}
   # {"id":2,"cmd":"startService","port":5272}
   # {"id":3,"cmd":"download","alias":"qwen2.5-0.5b"}
   # {"id":4,"cmd":"load","alias":"qwen2.5-0.5b"}
   # {"id":5,"cmd":"chatCompletion","model":"qwen2.5-0.5b","messages":[{"role":"user","content":"hi"}]}
   ```
   This exercises the entire inference stack (SDK, native core, gateway, pool). If this fails, the
   whole plan is blocked on Microsoft — stop and file the gap upstream.
   Record results in `docs/spikes/` like the pool spike.
2. **Microphone capture under webkit2gtk.** The audio lane records via `getUserMedia`, which on
   webkit2gtk depends on GStreamer plugins being present. Test in the dev build; expect the .deb
   `depends` list (and AppImage bundle) to need `gstreamer1.0-plugins-good`/`-bad` additions.
3. **`latest.json` merging across three platforms.** tauri-action currently merges the Windows and
   macOS updater manifests into one release asset; confirm a third matrix job appends
   `linux-x86_64` rather than clobbering (watch the draft release assets on the first dry run).

## Workstream A — dev build on Linux

- [ ] Run the spike above; fix whatever falls out of the sidecar path (likely candidates: none —
      paths use `path.join` throughout; `sidecar-paths.ts` already handles non-Windows).
- [ ] Widen test gates that assume Windows-only native SDK (`byom-import.e2e.test.ts` gates on
      `process.platform === 'win32'` — change to "core library present for this host").
- [ ] `npm run tauri dev` on Linux; smoke the main tabs (Models, Chat, Audio, Integrations,
      Settings). Audio is the risk item (unknown #2).

## Workstream B — packaging

- [ ] `tauri.conf.json`: `bundle.targets` is `"all"`, so Linux builds produce deb/rpm/AppImage
      automatically once built with `--bundles appimage,deb`. Add a `bundle.linux.deb.depends`
      list if the audio spike demands GStreamer packages.
- [ ] `scripts/verify-bundle.cjs`: knows the Linux triples but only inspects `bundle/msi|nsis|dmg`.
      Add `bundle/appimage` (`.AppImage`, expect ≥ 80 MB — it embeds webkit) and `bundle/deb`
      checks, plus the Linux resource layout for the staged-core check (deb:
      `data/usr/lib/<app>/resources/…`; AppImage: `squashfs-root/usr/lib/<app>/…`).
- [ ] `scripts/smoke-bundled-node.cjs`: confirm it resolves the Linux staging layout (it shares the
      triple map; verify, don't assume).
- [ ] Icons: Tauri Linux bundles use the PNG set (`icons/128x128@2x.png` etc.) — already correct
      (regenerated 2026-08-31 with the Flint logo).

## Workstream C — release workflow

- [ ] Add a matrix entry to `.github/workflows/release.yml`:
      ```yaml
      - os: ubuntu-22.04            # oldest supported glibc; do NOT use ubuntu-latest
        target: x86_64-unknown-linux-gnu
        bundles: appimage,deb
      ```
- [ ] Add the apt dependency step (copy the exact list from `ci.yml`), gated to `runner.os == 'Linux'`.
- [ ] No OS code signing exists on Linux — skip the Windows/macOS signing steps for the Linux job
      (they're already gated by `matrix.os`). The existing `TAURI_SIGNING_PRIVATE_KEY` signs the
      AppImage updater artifact; nothing new to provision.
- [ ] Updater: only the **AppImage** self-updates on Linux (Tauri limitation). `.deb` installs get
      updates only by downloading the next release manually — say so in the release notes template
      and README, and recommend the AppImage as the default download.
- [ ] Verify unknown #3 (latest.json gains `linux-x86_64`) on the first `workflow_dispatch` dry run
      with a test version.

## Workstream D — docs and UX

- [ ] README: add Linux to Requirements and Quick start (AppImage: `chmod +x`, run; note
      `libfuse2` requirement on some distros for AppImage).
- [ ] `docs/RELEASE.md`: short Linux section (no signing; AppImage-only self-update; expected
      artifacts `*.AppImage`, `*.deb`, `*.AppImage.sig`).
- [ ] Integrations tab needs no changes (unix snippets already exist) — but re-verify the OpenClaw
      card's WSL limitation reads sensibly when the host *is* Linux.
- [ ] `docs/BACKLOG.md`: the `glib` advisory note says "Flint ships Windows + macOS" — revisit that
      triage once Linux ships.

## Test checklist before first Linux release

- [ ] Fresh Ubuntu 22.04 and 24.04 VMs (and one non-Debian distro, e.g. Fedora, for the AppImage):
      install → download starter model → chat round-trip → audio transcription → external client
      (curl the gateway from another terminal) → updater check.
- [ ] AppImage on a machine without dev packages installed (catches missing bundled libs).
- [ ] Service bind/port changes + firewall note (Linux users typically have no inbound firewall on
      loopback; the LAN-bind warning text is generic enough).

## Sequencing and rough effort

1. Spike (Workstream A first item) — **~1 day**, gates everything.
2. Dev-build fixes + test-gate widening — **0.5–1 day**.
3. Packaging + verify-bundle — **1 day**.
4. Release workflow + dry run — **0.5 day**.
5. QA matrix + docs — **1–2 days**.

Total: roughly **a week** of calendar effort if the spike passes; if the Foundry core does not run
on Linux, the plan reduces to filing the upstream gap and re-checking on SDK bumps.
