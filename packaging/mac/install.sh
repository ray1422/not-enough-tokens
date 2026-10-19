#!/bin/sh
# Installs the latest Not Enough Tokens release into /Applications:
#   curl -fsSL https://raw.githubusercontent.com/ray1422/not-enough-tokens/main/packaging/mac/install.sh | sh
#
# The app is ad-hoc signed, not notarized. A dmg downloaded by a browser is
# quarantined and Gatekeeper refuses to open it; one downloaded with curl is not,
# so installing this way opens without the warning. Read this script before
# running it: that trust is what you are giving it.
set -eu

REPO=ray1422/not-enough-tokens
APP="Not Enough Tokens.app"
DEST="${NET_INSTALL_DIR:-/Applications}"

die() { echo "install: $*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this installer is for macOS"
[ "$(uname -m)" = arm64 ] || die "only Apple silicon builds are published"

# Latest release's dmg, from the GitHub API (no jq: the URL is on one line).
# NET_DMG_URL overrides it (e.g. file:///path/to.dmg for testing).
url=${NET_DMG_URL:-}
[ -n "$url" ] || url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
  grep -o '"browser_download_url": *"[^"]*-arm64\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$url" ] || die "no dmg found in the latest release"

tmp=$(mktemp -d)
mnt="$tmp/mnt"
cleanup() {
  [ -d "$mnt" ] && hdiutil detach -quiet "$mnt" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

echo "Downloading ${url##*/}"
curl -fL --progress-bar -o "$tmp/app.dmg" "$url"

mkdir "$mnt"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$tmp/app.dmg"
[ -d "$mnt/$APP" ] || die "the dmg does not contain $APP"

if pgrep -f "$DEST/$APP/Contents/MacOS/" >/dev/null 2>&1; then
  echo "Quitting the running app"
  osascript -e 'quit app "Not Enough Tokens"' >/dev/null 2>&1 || true
  sleep 2
fi

echo "Installing to $DEST/$APP"
if [ -w "$DEST" ]; then
  rm -rf "$DEST/$APP" && ditto "$mnt/$APP" "$DEST/$APP"
else
  sudo rm -rf "$DEST/$APP" && sudo ditto "$mnt/$APP" "$DEST/$APP"
fi

echo "Done. Open it from Launchpad or: open \"$DEST/$APP\""
