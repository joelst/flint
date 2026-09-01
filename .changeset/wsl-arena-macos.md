---
"flint": minor
---

Fix macOS releases, reach Flint from WSL, and rename Compare to Model Arena.

macOS builds no longer ship broken. The release workflow now signs and notarizes the app
automatically when Apple Developer secrets are present, and otherwise builds unsigned with a
loud warning instead of failing — a half-configured state (certificate without notarization
credentials) still fails, because that app would be blocked anyway. Since unsigned browser
downloads are quarantined and reported as "damaged" by Gatekeeper, a new curl-based installer
(`scripts/install-macos.sh`) installs the latest release without any Gatekeeper interaction,
and the docs cover the `xattr -cr` fix for DMG installs. The mac app icon is also finally the
Flint logo — `icon.icns` had shipped the default template icon since the initial check-in.

Tools running inside WSL2 (OpenClaw, OpenCode, …) can't reach `127.0.0.1` on the host in WSL's
default NAT mode. A new Settings → Network → WSL clients section detects WSL and enables
mirrored networking with one click: it writes `networkingMode=mirrored` into `.wslconfig`
(backing up the original, preserving everything else in the file), and offers a confirmed
`wsl --shutdown` to apply. Mirrored mode keeps Flint on the recommended loopback-only bind and
keeps gateway autoload working for WSL callers. A manual NAT walkthrough (host IP, `0.0.0.0`
bind, scoped firewall rule, no-autoload caveat) is included for those who prefer it.

The Compare tab is now **Model Arena** — page, sidebar, status messages, markdown export, help,
and docs. The keyboard shortcuts dialog also gains the previously undocumented Ctrl/⌘+6 entry.
Saved runs carry over unchanged.

Also: a Linux build plan landed in `docs/LINUX_BUILD_PLAN.md`.
