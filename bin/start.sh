#!/usr/bin/env bash
# Generic Jamat launcher (compiled app).  Usage:  start.sh [config-dir]
#   [config-dir]  -> JAMAT_CONFIG_DIR: the portable dir holding config + app-state + caches + ideas.
#                    Omit for the app default (~/.jamat). Point it at a synced dir to share settings
#                    across machines, or at an empty dir to run the first-run setup wizard.
#
# NOTE: mac/linux compiled builds are not wired into electron-builder yet (Windows-first). Until they
# are, `npm run compile` will fail here and this falls back to dev mode — same shape as start.bat.
set -euo pipefail
JAMAT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -n "${1:-}" ] && export JAMAT_CONFIG_DIR="$1"
cd "$JAMAT_ROOT/app-electron"

ensure_deps() {
  ( cd "$1" && node -e "const fs=require('fs');try{const a=fs.statSync('package-lock.json').mtimeMs;const b=fs.statSync('node_modules/.package-lock.json').mtimeMs;process.exit(a>b?1:0)}catch{process.exit(1)}" ) || {
    echo "Installing dependencies in $1 ..."; ( cd "$1" && npm install )
  }
}
ensure_deps ".."
ensure_deps "."

# Platform-specific compiled output (electron-builder). mac → .app via `open`; linux → unpacked binary.
case "$(uname -s)" in
  Darwin) APP="$(ls -d dist/mac*/Jamat.app 2>/dev/null | head -1)"; EXE="" ;;
  *)      APP=""; EXE="dist/linux-unpacked/jamat" ;;
esac
VERFILE="dist/.built-version"

CUR_VER="$(node -p "require('../package.json').version" 2>/dev/null || echo dev)"
BUILT_VER="$(cat "$VERFILE" 2>/dev/null || true)"

have_build() { [ -n "$APP" ] && [ -d "$APP" ] || { [ -n "$EXE" ] && [ -x "$EXE" ]; }; }

if ! have_build || [ "$CUR_VER" != "$BUILT_VER" ]; then
  echo "App changed [built=$BUILT_VER current=$CUR_VER]. Compiling..."
  if npm run compile; then
    echo "$CUR_VER" > "$VERFILE"
    case "$(uname -s)" in Darwin) APP="$(ls -d dist/mac*/Jamat.app 2>/dev/null | head -1)" ;; esac
  else
    echo "Build failed (cross-platform build may not be configured). Falling back to dev mode."
    exec npx electron-vite dev
  fi
fi

if [ -n "$APP" ]; then exec open -W "$APP"; else exec "./$EXE"; fi
