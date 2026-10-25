#!/bin/sh
# Installs the latest Not Enough Tokens release, picking the right way for this system:
#   curl -fsSL https://raw.githubusercontent.com/ray1422/not-enough-tokens/main/packaging/install.sh | sh
#
#   macOS            -> packaging/mac/install.sh (dmg into /Applications)
#   Arch and derived -> the release's pacman package, with the system electron
#   NixOS            -> prints the `nix run` line, installs nothing
#   other Linux      -> the AppImage, into ~/.local (no root)
# NET_METHOD=appimage forces the AppImage on Arch. NET_DRY_RUN=1 only prints the chosen method
# (used by packaging/test-install.sh). Read this script before running it.
set -eu

REPO=ray1422/not-enough-tokens
RAW="https://raw.githubusercontent.com/$REPO/main"
OS_RELEASE="${NET_OS_RELEASE:-/etc/os-release}"

die() { echo "install: $*" >&2; exit 1; }

# URL of the latest release asset whose name ends with $1 (no jq: each URL is on one line).
asset() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    grep -o "\"browser_download_url\": *\"[^\"]*$1\"" | head -1 | sed 's/.*"\(https[^"]*\)"/\1/'
}

case "$(uname -s)" in
Darwin)
  [ -z "${NET_DRY_RUN:-}" ] || { echo "method=dmg"; exit; }
  curl -fsSL "$RAW/packaging/mac/install.sh" | sh
  exit
  ;;
Linux) ;;
*) die "unsupported system $(uname -s)" ;;
esac

id=; like=
if [ -r "$OS_RELEASE" ]; then
  id=$(. "$OS_RELEASE"; echo "${ID:-}")
  like=$(. "$OS_RELEASE"; echo "${ID_LIKE:-}")
fi
distro="$id $like"
case " $distro " in *" nixos "*)
  [ -z "${NET_DRY_RUN:-}" ] || { echo "method=nix"; exit; }
  echo "NixOS: run it straight from the flake, nothing to install:"
  echo "  nix run github:$REPO"
  exit
  ;;
esac

method=${NET_METHOD:-}
if [ -z "$method" ]; then
  case " $distro " in
  *" arch "*) method=pacman ;;
  *) method=appimage ;;
  esac
fi

[ -z "${NET_DRY_RUN:-}" ] || { echo "method=$method"; exit; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

case "$method" in
pacman)
  command -v pacman >/dev/null || die "pacman not found"
  url=$(asset '-any\.pkg\.tar\.zst')
  [ -n "$url" ] || die "no pacman package in the latest release"
  echo "Downloading ${url##*/}"
  curl -fL --progress-bar -o "$tmp/${url##*/}" "$url"
  echo "Installing with pacman (electron comes from the Arch repositories)"
  # Under `curl | sh` stdin is the script, so give pacman's [Y/n] prompt the terminal.
  if [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then in=/dev/tty; flag=; else in=/dev/null; flag=--noconfirm; fi
  if [ "$(id -u)" = 0 ]; then pacman -U $flag "$tmp/${url##*/}" <"$in"; else sudo pacman -U $flag "$tmp/${url##*/}" <"$in"; fi
  echo "Done. Start it from your app menu or run: not-enough-tokens"
  ;;
appimage)
  case "$(uname -m)" in
  x86_64) arch=x86_64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "no AppImage for $(uname -m)" ;;
  esac
  url=$(asset "-$arch\\.AppImage")
  [ -n "$url" ] || die "no $arch AppImage in the latest release"
  bin="${XDG_BIN_HOME:-$HOME/.local/bin}"
  share="${XDG_DATA_HOME:-$HOME/.local/share}"
  mkdir -p "$bin" "$share/applications" "$share/icons/hicolor/512x512/apps"
  echo "Downloading ${url##*/}"
  curl -fL --progress-bar -o "$tmp/app" "$url"
  install -m 755 "$tmp/app" "$bin/not-enough-tokens.AppImage"
  curl -fsSL -o "$share/icons/hicolor/512x512/apps/not-enough-tokens.png" "$RAW/build/icon.png" || true
  cat >"$share/applications/not-enough-tokens.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Not Enough Tokens
Comment=Claude Code usage across machines
Exec=$bin/not-enough-tokens.AppImage %U
Icon=not-enough-tokens
Terminal=false
Categories=Development;Utility;
StartupWMClass=not-enough-tokens
DESKTOP
  echo "Installed $bin/not-enough-tokens.AppImage"
  command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1 ||
    echo "Note: AppImages need FUSE 2 (libfuse2); without it run with --appimage-extract-and-run."
  case ":$PATH:" in *":$bin:"*) ;; *) echo "Note: $bin is not on your PATH." ;; esac
  ;;
*) die "unknown NET_METHOD=$method (pacman or appimage)" ;;
esac
