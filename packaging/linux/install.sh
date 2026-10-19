#!/bin/sh
# Installs the app for use with the system Electron.
#   sh packaging/linux/install.sh                  # into /usr/local (needs sudo)
#   PREFIX=$HOME/.local sh packaging/linux/install.sh
#   DESTDIR=pkgdir PREFIX=/usr sh packaging/linux/install.sh   # for distro packages
# ELECTRON_BIN fixes the electron the launcher uses; otherwise it finds `electron` on PATH.
set -eu
PREFIX="${PREFIX:-/usr/local}"
DESTDIR="${DESTDIR:-}"
ELECTRON_BIN="${ELECTRON_BIN:-}"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$PREFIX/lib/not-enough-tokens"

install -d "$DESTDIR$APP" "$DESTDIR$PREFIX/bin" "$DESTDIR$PREFIX/share/applications" \
  "$DESTDIR$PREFIX/share/icons/hicolor/scalable/apps" "$DESTDIR$PREFIX/share/icons/hicolor/512x512/apps"
cp -R "$SRC/package.json" "$SRC/electron" "$SRC/src" "$SRC/web" "$DESTDIR$APP/"
sed -e "s|@APP_DIR@|$APP|" -e "s|@ELECTRON@|$ELECTRON_BIN|" "$SRC/packaging/linux/not-enough-tokens" > "$DESTDIR$PREFIX/bin/not-enough-tokens"
chmod 755 "$DESTDIR$PREFIX/bin/not-enough-tokens"
install -m 644 "$SRC/packaging/linux/not-enough-tokens.desktop" "$DESTDIR$PREFIX/share/applications/"
install -m 644 "$SRC/build/icon.svg" "$DESTDIR$PREFIX/share/icons/hicolor/scalable/apps/not-enough-tokens.svg"
install -m 644 "$SRC/build/icon.png" "$DESTDIR$PREFIX/share/icons/hicolor/512x512/apps/not-enough-tokens.png"
echo "installed to $DESTDIR$APP (launcher: $PREFIX/bin/not-enough-tokens)"
