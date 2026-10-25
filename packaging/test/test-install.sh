#!/bin/sh
# Checks which method packaging/install.sh picks for each os-release sample, with
# no download and no install. Run from anywhere: sh packaging/test/test-install.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
script="$here/../install.sh"
fails=0

check() { # name expected [env...]
  name=$1 want=$2
  got=$(NET_DRY_RUN=1 NET_OS_RELEASE="$here/os-release/$name" sh "$script" 2>&1) || got="failed: $got"
  if [ "$got" = "method=$want" ]; then echo "ok   $name -> $want"; else echo "FAIL $name: want method=$want, got: $got"; fails=$((fails + 1)); fi
}

# The script asks `uname`; only the Linux branch is meaningful to vary here.
bin=$(mktemp -d)
trap 'rm -rf "$bin"' EXIT
printf '#!/bin/sh\n[ "${1:-}" = -s ] && echo Linux || echo x86_64\n' > "$bin/uname"
chmod +x "$bin/uname"
PATH="$bin:$PATH"

check arch pacman      # ID=arch
check cachyos pacman   # ID_LIKE=arch: any derivative
check nixos nix
check ubuntu appimage  # everything else

# No os-release at all: fall back to the AppImage.
got=$(NET_DRY_RUN=1 NET_OS_RELEASE=/nonexistent sh "$script")
[ "$got" = method=appimage ] && echo "ok   no os-release -> appimage" || { echo "FAIL no os-release: $got"; fails=$((fails + 1)); }

# NET_METHOD overrides the distro.
got=$(NET_DRY_RUN=1 NET_METHOD=appimage NET_OS_RELEASE="$here/os-release/arch" sh "$script")
[ "$got" = method=appimage ] && echo "ok   NET_METHOD override" || { echo "FAIL NET_METHOD override: $got"; fails=$((fails + 1)); }

exit $((fails > 0))
