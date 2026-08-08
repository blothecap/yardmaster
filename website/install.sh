#!/bin/bash
# Yardmaster bootstrap — one-liner installer.
#   curl -fsSL https://yardmaster.me/install.sh | bash
# Clones (or updates) the repo into ~/yardmaster, then hands off to the
# repo's full installer.
set -euo pipefail

REPO_URL="https://github.com/blothecap/yardmaster.git"
DEST="${YARDMASTER_DIR:-$HOME/yardmaster}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

bold "Yardmaster bootstrap"
command -v git >/dev/null || die "git not found — install Xcode Command Line Tools first: xcode-select --install"

if [ -d "$DEST/.git" ]; then
  bold "Updating existing checkout at ${DEST}…"
  git -C "$DEST" pull --ff-only
else
  bold "Cloning into ${DEST}…"
  git clone "$REPO_URL" "$DEST" \
    || die "Clone failed — check your network connection and try again."
fi

cd "$DEST"
exec ./install.sh
