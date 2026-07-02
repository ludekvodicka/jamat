#!/usr/bin/env bash
# Generic Jamat terminal-menu launcher (the app-cli TUI).  Usage:  start-menu.sh [config-dir]
#   [config-dir]  -> JAMAT_CONFIG_DIR: the portable dir holding config + menu-prefs + usage-stats.
#                    Omit to use the app default (~/.jamat). Point it at a synced dir to share across
#                    machines, or an empty dir to first-run-seed a starter config.
set -euo pipefail
JAMAT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -n "${1:-}" ] && export JAMAT_CONFIG_DIR="$1"
cd "$JAMAT_ROOT"
exec node --import tsx app-cli/executor.ts
