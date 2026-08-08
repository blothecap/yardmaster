#!/bin/bash
# Yardmaster — build & install from source.
#   git clone https://github.com/blothecap/yardmaster && cd yardmaster && ./install.sh
# Idempotent: safe to re-run after updates (git pull && ./install.sh).
set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=12   # require(esm) — older Node breaks Electron's installer

bold "Yardmaster installer"

# ---- platform checks --------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "macOS only."
[ "$(uname -m)" = "arm64" ] || warn "Intel Mac detected — the build config targets arm64; expect issues."
xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools missing. Run: xcode-select --install (then re-run this script)"
command -v git >/dev/null || die "git not found."
ok "macOS $(sw_vers -productVersion), Xcode CLT present"

# ---- claude code ------------------------------------------------------------
NEED_CLAUDE_NPM=0
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code found ($(claude --version 2>/dev/null | head -1))"
else
  bold "Claude Code not found — installing it (native installer)…"
  curl -fsSL https://claude.ai/install.sh | bash || true
  export PATH="$HOME/.local/bin:$PATH"
  if command -v claude >/dev/null 2>&1; then
    ok "Claude Code installed ($(claude --version 2>/dev/null | head -1))"
  else
    warn "Native installer didn't work — will retry via npm once Node is ready"
    NEED_CLAUDE_NPM=1
  fi
fi

cd "$(dirname "$0")"
[ -f package.json ] && grep -q '"name": "yardmaster"' package.json || die "Run this from the yardmaster repo root."

# ---- node -------------------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -v | sed 's/^v//')"
  major="${v%%.*}"; minor="$(echo "$v" | cut -d. -f2)"
  [ "$major" -gt "$MIN_NODE_MAJOR" ] || { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ]; }
}

if ! node_ok; then
  # try nvm with the repo's .nvmrc
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install >/dev/null 2>&1 || nvm install
    nvm use >/dev/null
  fi
fi
node_ok || die "Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} required (have: $(node -v 2>/dev/null || echo none)). Install via nvm (https://github.com/nvm-sh/nvm) or nodejs.org, then re-run."
ok "Node $(node -v)"

if [ "$NEED_CLAUDE_NPM" = "1" ]; then
  bold "Installing Claude Code via npm…"
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || true
  command -v claude >/dev/null 2>&1 \
    && ok "Claude Code installed ($(claude --version 2>/dev/null | head -1))" \
    || die "Could not install Claude Code automatically. Install it manually (https://claude.com/claude-code), then re-run this script."
fi

# ---- dependencies -----------------------------------------------------------
# npm 11 avoids an arborist crash in npm 10.9 on this dependency tree; its
# install-scripts gate needs explicit approval for native/postinstall packages.
bold "Installing dependencies (this can take a few minutes on first run)…"
npx -y npm@11 install --no-audit --no-fund >/dev/null 2>&1 || true
npx -y npm@11 install-scripts approve node-pty electron esbuild fsevents @electron/rebuild electron-winstaller >/dev/null 2>&1 || true
npx -y npm@11 install --no-audit --no-fund >/dev/null

# Electron's binary download can be skipped when scripts were gated on pass 1.
if [ ! -d node_modules/electron/dist/Electron.app ]; then
  node node_modules/electron/install.js
fi
[ -d node_modules/electron/dist/Electron.app ] || die "Electron binary failed to install."
npx electron-rebuild -f -w node-pty >/dev/null
ok "Dependencies installed (node-pty rebuilt for Electron)"

# ---- build ------------------------------------------------------------------
bold "Building Yardmaster.app…"
npm run dist >/dev/null
[ -d "release/mac-arm64/Yardmaster.app" ] || die "Build failed — release/mac-arm64/Yardmaster.app not found."
ok "Built release/mac-arm64/Yardmaster.app"

# ---- install ----------------------------------------------------------------
osascript -e 'quit app "Yardmaster"' >/dev/null 2>&1 || true
# wait for a clean exit — the app may show a quit-confirmation dialog first
i=0
while pgrep -x Yardmaster >/dev/null 2>&1; do
  [ $i -ge 60 ] && die "Yardmaster is still running (answer its quit dialog), then re-run this script."
  sleep 1; i=$((i+1))
done
rm -rf /Applications/Yardmaster.app
cp -R "release/mac-arm64/Yardmaster.app" /Applications/
ok "Installed to /Applications/Yardmaster.app"

# open by path — LaunchServices hasn't indexed a first-time install by name yet
open /Applications/Yardmaster.app
bold "Done — Yardmaster is running. Pin it to your Dock and press ⌘N."
