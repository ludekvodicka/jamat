#!/usr/bin/env bash
# Generic Jamat DEV launcher (electron-vite dev).  Usage:  start-dev.sh [config-dir]
#   [config-dir]  -> JAMAT_CONFIG_DIR (see start.sh). Dev uses the `-debug` leaf of the config-dir for
#                    Electron-owned state, so dev and prod don't share app-state / caches.
set -euo pipefail
JAMAT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -n "${1:-}" ] && export JAMAT_CONFIG_DIR="$1"

ensure_deps() {
  ( cd "$1" && node -e "const fs=require('fs');try{const a=fs.statSync('package-lock.json').mtimeMs;const b=fs.statSync('node_modules/.package-lock.json').mtimeMs;process.exit(a>b?1:0)}catch{process.exit(1)}" ) || {
    echo "Installing dependencies in $1 ..."; ( cd "$1" && npm install )
  }
}
ensure_deps "$JAMAT_ROOT"
ensure_deps "$JAMAT_ROOT/app-electron"

cd "$JAMAT_ROOT/app-electron"
exec npx electron-vite dev
