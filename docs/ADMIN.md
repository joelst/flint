# Flint operator runbook

How an installed Flint behaves on a machine. Cutting a signed build is
[RELEASE.md](./RELEASE.md). End-user first steps are [USER_GUIDE.md](./USER_GUIDE.md).

**1.0 production is Windows.** macOS Apple Silicon is evaluation-only (unsigned).
Linux is not a release target.

## Logs

| What | Where |
|---|---|
| Flint sidecar access/audit log | `~/.flint/logs/` (rotated; 7 days) |
| Foundry native runtime | `~/.foundry/logs` |
| In-app | Diagnostics → Copy All Diagnostics (includes the health ring) |

## Service lifecycle

1. Start the local service from **Diagnostics**.
2. The **client URL** is usually `http://127.0.0.1:<port>/v1`. Copy it from Diagnostics or About.
3. **Bind address** (Settings → Network) is where the gateway listens. Apply & restart after changes.
4. Non-loopback bind exposes the service on the network and asks for confirmation.
5. WSL2 NAT cannot reach host `127.0.0.1`. Settings → Network → WSL clients can enable mirrored networking.

Stop / Stop & Unload withdraws the endpoint. A Stop acknowledgement is not proof the native listener has gone quiet.

## Packaged vs PATH Node

About shows Node as `bundled` or `PATH`. Release installers include Node 22. PATH Node is a development fallback. If About says Node is missing, the install is incomplete — reinstall from GitHub Releases, do not install Node as a user requirement.

## Offline and first run

The installer contains Flint, bundled Node, and Foundry native libraries. It does **not** contain chat model weights. First run downloads a model from the catalog (needs network). Cached models remain usable offline.

## Uninstall leftovers

Removing the app does not delete:

- `~/.flint/` (conversations, logs, settings)
- Foundry model cache under `~/.foundry/` (multi-GB)

Delete those directories only if you intend to drop local models and chat history.

## Updater

The in-app updater follows GitHub `releases/latest`. **Prereleases are skipped** — 0.7.0 evaluation builds must be installed by hand. The first **stable** 1.0.0 publish is what makes `latest.json` resolve.

If an update misbehaves: install the previous MSI/NSIS from GitHub Releases and do not take the in-app updater offer. See [RELEASE.md](./RELEASE.md).

## macOS evaluation

Unsigned builds. Prefer:

```bash
curl -fsSL https://raw.githubusercontent.com/joelst/flint/main/scripts/install-macos.sh | bash
```

or `xattr -cr /Applications/Flint.app` after a browser DMG install. Signing Flint.app does not un-quarantine the SDK's ad-hoc dylib.

## Packaged runtime smoke

After a debug Tauri build:

```bash
FLINT_RUNTIME_SMOKE=1  # set by the script
npm run smoke:runtime
```

The app starts, waits until the sidecar is ready, then exits 0. It does not download a model. CI runs this on Windows only.

## Supported audio

The sidecar accepts 16 kHz mono PCM WAV. The browser transcodes whatever Web Audio can decode; conversion failures are rejected before bytes are sent. Broader container coverage is not a 1.0 promise.
