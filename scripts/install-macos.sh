#!/usr/bin/env bash
# Install the latest Flint release on macOS.
#
# Flint's macOS builds are not signed with an Apple Developer ID, so an app
# downloaded through a browser is quarantined and Gatekeeper reports it as
# "damaged". curl does not apply the quarantine attribute, so installing this
# way runs cleanly; xattr -cr afterwards is belt and braces.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/joelst/flint/main/scripts/install-macos.sh | bash
set -euo pipefail

REPO="joelst/flint"
DEST="/Applications"

ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  echo "Flint ships macOS builds for Apple Silicon (arm64) only; this Mac reports '$ARCH'." >&2
  exit 1
fi

# The bundled libonnxruntime.dylib is built with minos 14.0, and the app declares
# LSMinimumSystemVersion 14.0 — installing on an older macOS produces an app that
# LaunchServices simply refuses to open. Fail here with a reason instead.
DARWIN_MAJOR="$(uname -r | cut -d. -f1)"
if [ "$DARWIN_MAJOR" -lt 23 ]; then
  echo "Flint requires macOS 14 (Sonoma) or later; this Mac reports macOS $(sw_vers -productVersion)." >&2
  exit 1
fi

echo "Looking up the latest Flint release..."
LATEST_JSON="$(curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.json")"
# latest.json is the Tauri updater manifest; the darwin entry's url is the
# .app.tar.gz updater archive, which is also a perfectly good install source.
# `|| true` because grep exits 1 on no match, which `set -euo pipefail` would turn into a
# silent early exit before the friendly error below.
URL="$(printf '%s' "$LATEST_JSON" | grep -oE 'https://[^"]+\.app\.tar\.gz' | head -n 1 || true)"
if [ -z "$URL" ]; then
  echo "Could not find a macOS .app.tar.gz asset in the latest release manifest." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $URL"
curl -fL --progress-bar "$URL" -o "$TMP/flint.app.tar.gz"
tar -xzf "$TMP/flint.app.tar.gz" -C "$TMP"

APP="$(find "$TMP" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$APP" ]; then
  echo "The downloaded archive did not contain a .app bundle." >&2
  exit 1
fi
APP_NAME="$(basename "$APP")"

if [ -d "$DEST/$APP_NAME" ]; then
  echo "Replacing existing $DEST/$APP_NAME"
  rm -rf "$DEST/$APP_NAME"
fi
cp -R "$APP" "$DEST/"
xattr -cr "$DEST/$APP_NAME" 2>/dev/null || true

echo "Installed $DEST/$APP_NAME — launch it from Applications or Spotlight."
