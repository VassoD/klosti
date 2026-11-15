#!/bin/sh
# Packages the built Mac app for the curl installer (site/public/install.sh):
# seals the whole bundle with an ad-hoc signature, zips it and writes its checksum.
# Upload both files in app/release/ to a GitHub release.
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
BUNDLE="$APP_DIR/src-tauri/target/release/bundle/macos/Klosti.app"
OUT="$APP_DIR/release"
ASSET="Klosti-macos-arm64.zip"

[ -d "$BUNDLE" ] || { echo "No app found. Run npm run build first." >&2; exit 1; }

# Tauri's automatic signature covers the main binary only, so the bundle would not verify on another Mac.
codesign --force --deep --sign - "$BUNDLE"
codesign --verify --deep --strict "$BUNDLE"

rm -rf "$OUT"
mkdir -p "$OUT"
ditto -c -k --keepParent "$BUNDLE" "$OUT/$ASSET"
(cd "$OUT" && shasum -a 256 "$ASSET" > "$ASSET.sha256")
echo "Release files in $OUT:"
ls -l "$OUT"
