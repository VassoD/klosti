#!/bin/sh
# Installs or updates the Klosti Mac app from the latest GitHub release.
# Usage: curl -fsSL https://klosti.vassi.fyi/install.sh | sh
set -eu

REPO="VassoD/klosti"
ASSET="Klosti-macos-arm64.zip"
URL="https://github.com/$REPO/releases/latest/download/$ASSET"
APP="Klosti.app"

fail() {
  printf 'klosti: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "the Mac app is for macOS. Anywhere else, run: npx klosti"
[ "$(uname -m)" = "arm64" ] || fail "the Mac app needs an Apple silicon Mac for now. On an Intel Mac, run: npx klosti"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading Klosti..."
curl -fsSL --retry 3 -o "$TMP/$ASSET" "$URL" || fail "the download failed. Nothing was installed."
curl -fsSL --retry 3 -o "$TMP/$ASSET.sha256" "$URL.sha256" || fail "the checksum download failed. Nothing was installed."

# Both files come from the same release, so this catches a broken download, not a tampered release.
EXPECTED=$(awk '{print $1}' "$TMP/$ASSET.sha256")
ACTUAL=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
[ "$EXPECTED" = "$ACTUAL" ] || fail "the download is damaged (checksum mismatch). Nothing was installed."

ditto -x -k "$TMP/$ASSET" "$TMP/unpacked"
[ -d "$TMP/unpacked/$APP" ] || fail "the download did not contain $APP. Nothing was installed."

DEST="/Applications"
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"

# An open copy keeps its files busy, so it is closed before it is replaced.
osascript -e 'tell application "System Events" to if exists process "Klosti" then tell application "Klosti" to quit' >/dev/null 2>&1 || true

rm -rf "${DEST:?}/$APP"
mv "$TMP/unpacked/$APP" "$DEST/$APP"
echo "Installed $DEST/$APP"
open "$DEST/$APP"
